/**
 * ============================================================================
 * UniServ Stage 5.0 Tests: Settlement Evidence & Anomaly Rules
 * ============================================================================
 * Verifies:
 *  1. Evidence Packet Structure: Built from server data only, matches deriveBillFromEvents.
 *  2. Happy-Path Demo Job: Clean short job produces zero anomaly flags and APPROVE.
 *  3. RULE_CEILING_EXCEEDED: High severity, forces HOLD_FOR_HUMAN with exact reason parity.
 *  4. RULE_EXCESSIVE_EXTRAS: Compares extra work + parts to BASE bill, high severity.
 *  5. RULE_SUSPICIOUS_FAST_EXTRAS: High flag if < 20s with extras; no flag without extras.
 *  6. RULE_NON_POSITIVE_DURATION: Low severity flag, safe 0-second duration fallback.
 *  7. RULE_MANY_EXTRA_WORK_EVENTS: Low severity advisory flag (> 3 events).
 *  8. RULE_EXCESSIVE_PAUSED_TIME: Low severity advisory flag (> 50% paused ratio).
 *  9. RULE_URGENCY_MISMATCH: Low severity advisory flag.
 * 10. decide() Invariant: Any high flag forces HOLD_FOR_HUMAN; low or none allows APPROVE.
 * 11. Env Overrides: Dynamic threshold overrides via environment variables.
 * 12. Quarantined Untrusted Context: User descriptions placed safely in untrusted_data.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate test store in a fresh temporary directory
const stage5TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-stage5-evidence-'));
const stage5StoreFile = path.join(stage5TempDir, 'bookings.json');

const store = require('../server/store');
store.setStorePath(stage5StoreFile);

test.after(() => {
  store.resetStorePath();
  try {
    fs.rmSync(stage5TempDir, { recursive: true, force: true });
  } catch (e) {}
});

const { buildSettlementEvidence } = require('../server/services/settlementEvidence');
const { evaluateAnomalyRules, decide, getThresholds } = require('../server/services/anomalyRules');
const { deriveBillFromEvents } = require('../server/services/jobEventService');
const { validateAndBuildEvidence } = require('../server/services/settlementService');

// Helper to create a base test booking
function createMockBooking(overrides = {}) {
  const defaultEvidence = validateAndBuildEvidence({
    service_id: 's1',
    booking_type: 'normal',
    distance_km: 0,
    first_time: false
  });

  return {
    bookingId: 'BK_TEST_STAGE5_' + Math.random().toString(36).slice(2, 7),
    status: 'AUTHORIZED',
    authorizedCents: 150,
    authorizedAmountUsd: '1.50',
    estimatePaise: 9900,
    totalRupees: 99,
    estimateCents: 118,
    estimateAmountUsd: '1.18',
    evidence: defaultEvidence,
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'complete', timestamp: '2026-11-11T10:00:03.000Z', client_reported: true }
    ],
    english_dispatch_summary: 'Plumbing leak inspection.',
    ai_triage: {
      trade_id: 's1',
      urgency: 'medium',
      likely_parts: ['Washer'],
      price_range_inr: { min: 100, max: 250 },
      mode: 'REAL_AI'
    },
    ...overrides
  };
}

test('1. Evidence Packet Structure: contains all required fields and derives engine totals via deriveBillFromEvents', () => {
  const booking = createMockBooking({
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'pause_parts', timestamp: '2026-11-11T10:10:00.000Z', client_reported: true },
      { type: 'resume', timestamp: '2026-11-11T10:15:00.000Z', client_reported: true },
      {
        type: 'extra_work',
        timestamp: '2026-11-11T10:20:00.000Z',
        client_reported: true,
        payload: { id: 'ew_1', description: 'Replace corroded nipple', amount: 120, approved: true }
      },
      {
        type: 'parts',
        timestamp: '2026-11-11T10:25:00.000Z',
        client_reported: true,
        payload: { cost: 80 }
      },
      { type: 'complete', timestamp: '2026-11-11T10:35:00.000Z', client_reported: true }
    ]
  });

  const evidence = buildSettlementEvidence(booking);

  // Core identifiers & whitelisted inputs
  assert.strictEqual(evidence.booking_id, booking.bookingId);
  assert.strictEqual(evidence.status, 'AUTHORIZED');
  assert.strictEqual(evidence.service.id, 's1');
  assert.strictEqual(evidence.booking_type, 'now');
  assert.strictEqual(evidence.authorized_cents, 150);

  // Engine totals matching deriveBillFromEvents exactly
  const directDerive = deriveBillFromEvents(booking);
  assert.strictEqual(evidence.engine_totals.final_paise, directDerive.totalPaise);
  assert.strictEqual(evidence.engine_totals.final_rupees, directDerive.totalRupees);
  assert.strictEqual(evidence.engine_totals.final_cents, directDerive.finalCents);
  assert.strictEqual(evidence.engine_totals.final_amount_usd, directDerive.finalAmountUsd);
  assert.strictEqual(evidence.engine_totals.base_price_rupees, Math.round(directDerive.bill.basePaise / 100));
  assert.strictEqual(evidence.engine_totals.extra_work_rupees, 120);
  assert.strictEqual(evidence.engine_totals.parts_rupees, 80);

  // Timeline and pause tracking
  assert.strictEqual(evidence.timeline.length, 6);
  assert.strictEqual(evidence.pause_intervals.length, 1);
  assert.strictEqual(evidence.pause_intervals[0].duration_seconds, 300); // 5 minutes = 300s
  assert.strictEqual(evidence.total_paused_seconds, 300);

  // Extra work & parts items
  assert.strictEqual(evidence.extra_work_items.length, 1);
  assert.strictEqual(evidence.extra_work_items[0].description, 'Replace corroded nipple');
  assert.strictEqual(evidence.extra_work_items[0].amount, 120);
  assert.strictEqual(evidence.parts_cost, 80);

  // Quarantined untrusted context
  assert.ok(evidence.untrusted_data, 'Evidence must contain untrusted_data field');
  assert.strictEqual(evidence.untrusted_data.english_dispatch_summary, 'Plumbing leak inspection.');
  assert.strictEqual(evidence.untrusted_data.ai_triage.trade_id, 's1');
  assert.deepStrictEqual(evidence.untrusted_data.extra_work_descriptions, ['Replace corroded nipple']);
});

test('2. Happy-Path Demo Job: 3-second clean job produces 0 anomaly flags and APPROVE decision', () => {
  const booking = createMockBooking({
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'complete', timestamp: '2026-11-11T10:00:03.000Z', client_reported: true }
    ]
  });

  const evidence = buildSettlementEvidence(booking);
  const flags = evaluateAnomalyRules(evidence);

  assert.strictEqual(flags.length, 0, 'Clean demo job must have zero anomaly flags');

  const policy = decide(flags);
  assert.strictEqual(policy.decision, 'APPROVE');
  assert.strictEqual(policy.highFlags.length, 0);
  assert.strictEqual(policy.lowFlags.length, 0);
  assert.ok(policy.reason.includes('clear'));
});

test('3. RULE_CEILING_EXCEEDED: triggers HIGH severity with exact reason parity vs orders.js capture check', () => {
  const booking = createMockBooking({
    authorizedCents: 100, // lower than final bill
    authorizedAmountUsd: '1.00',
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      // Add extra work so final cents > 100
      {
        type: 'extra_work',
        timestamp: '2026-11-11T10:20:00.000Z',
        client_reported: true,
        payload: { id: 'ew_1', description: 'Major fitting', amount: 500, approved: true }
      },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z', client_reported: true }
    ]
  });

  const evidence = buildSettlementEvidence(booking);
  const flags = evaluateAnomalyRules(evidence);

  const ceilingFlag = flags.find((f) => f.id === 'RULE_CEILING_EXCEEDED');
  assert.ok(ceilingFlag, 'Must trigger RULE_CEILING_EXCEEDED');
  assert.strictEqual(ceilingFlag.severity, 'high');

  // Exact parity assertion with capture route hold reason
  const expectedReason = `Final bill ($${evidence.engine_totals.final_amount_usd} USD / ₹${evidence.engine_totals.final_rupees}) exceeded authorized ceiling ($${evidence.authorized_amount_usd} USD)`;
  assert.strictEqual(ceilingFlag.reason, expectedReason);

  const policy = decide(flags);
  assert.strictEqual(policy.decision, 'HOLD_FOR_HUMAN');
  assert.strictEqual(policy.reason, expectedReason);
});

test('4. RULE_EXCESSIVE_EXTRAS: compares extra_work + parts to BASE bill, triggers HIGH flag on boundary', () => {
  // Base bill for s1 is ₹99. Threshold is 100% of base (₹99).
  // Case A: ₹50 extra work + ₹49 parts = ₹99 (exactly 100% of base) -> NO FLAG
  const bookingAtBoundary = createMockBooking({
    authorizedCents: 500,
    authorizedAmountUsd: '5.00',
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      {
        type: 'extra_work',
        timestamp: '2026-11-11T10:10:00.000Z',
        client_reported: true,
        payload: { id: 'ew_1', description: 'Fix joint', amount: 50, approved: true }
      },
      {
        type: 'parts',
        timestamp: '2026-11-11T10:15:00.000Z',
        client_reported: true,
        payload: { cost: 49 }
      },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z', client_reported: true }
    ]
  });

  const evidenceA = buildSettlementEvidence(bookingAtBoundary);
  const flagsA = evaluateAnomalyRules(evidenceA);
  assert.strictEqual(
    flagsA.some((f) => f.id === 'RULE_EXCESSIVE_EXTRAS'),
    false,
    'Extras exactly equal to base bill must not trigger flag'
  );

  // Case B: ₹50 extra work + ₹50 parts = ₹100 (> ₹99) -> TRIGGERS HIGH FLAG
  const bookingExceeded = createMockBooking({
    authorizedCents: 500,
    authorizedAmountUsd: '5.00',
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      {
        type: 'extra_work',
        timestamp: '2026-11-11T10:10:00.000Z',
        client_reported: true,
        payload: { id: 'ew_1', description: 'Fix joint', amount: 50, approved: true }
      },
      {
        type: 'parts',
        timestamp: '2026-11-11T10:15:00.000Z',
        client_reported: true,
        payload: { cost: 50 }
      },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z', client_reported: true }
    ]
  });

  const evidenceB = buildSettlementEvidence(bookingExceeded);
  const flagsB = evaluateAnomalyRules(evidenceB);
  const flagB = flagsB.find((f) => f.id === 'RULE_EXCESSIVE_EXTRAS');
  assert.ok(flagB);
  assert.strictEqual(flagB.severity, 'high');
  assert.strictEqual(decide(flagsB).decision, 'HOLD_FOR_HUMAN');
});

test('5. RULE_SUSPICIOUS_FAST_EXTRAS: triggers HIGH flag on fast job with extras, but ignores fast job without extras', () => {
  // Case A: 5-second job WITH extra work -> triggers HIGH
  const fastJobWithExtras = createMockBooking({
    authorizedCents: 500,
    authorizedAmountUsd: '5.00',
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      {
        type: 'extra_work',
        timestamp: '2026-11-11T10:00:02.000Z',
        client_reported: true,
        payload: { id: 'ew_1', description: 'Quick solder', amount: 30, approved: true }
      },
      { type: 'complete', timestamp: '2026-11-11T10:00:05.000Z', client_reported: true }
    ]
  });

  const evidenceA = buildSettlementEvidence(fastJobWithExtras);
  const flagsA = evaluateAnomalyRules(evidenceA);
  const flagA = flagsA.find((f) => f.id === 'RULE_SUSPICIOUS_FAST_EXTRAS');
  assert.ok(flagA);
  assert.strictEqual(flagA.severity, 'high');
  assert.strictEqual(decide(flagsA).decision, 'HOLD_FOR_HUMAN');

  // Case B: 5-second job WITHOUT extras -> NO FLAG (clean demo happy path preserved)
  const fastJobNoExtras = createMockBooking({
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'complete', timestamp: '2026-11-11T10:00:05.000Z', client_reported: true }
    ]
  });

  const evidenceB = buildSettlementEvidence(fastJobNoExtras);
  const flagsB = evaluateAnomalyRules(evidenceB);
  assert.strictEqual(
    flagsB.some((f) => f.id === 'RULE_SUSPICIOUS_FAST_EXTRAS'),
    false
  );
  assert.strictEqual(decide(flagsB).decision, 'APPROVE');
});

test('6. RULE_NON_POSITIVE_DURATION: handles 0 or negative elapsed time safely with LOW severity flag', () => {
  const zeroDurationBooking = createMockBooking({
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'complete', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true }
    ]
  });

  const evidence = buildSettlementEvidence(zeroDurationBooking);
  assert.strictEqual(evidence.active_seconds, 0);

  const flags = evaluateAnomalyRules(evidence);
  const zeroFlag = flags.find((f) => f.id === 'RULE_NON_POSITIVE_DURATION');
  assert.ok(zeroFlag);
  assert.strictEqual(zeroFlag.severity, 'low');
  assert.strictEqual(decide(flags).decision, 'APPROVE');
});

test('7. RULE_MANY_EXTRA_WORK_EVENTS: triggers LOW advisory flag when count > 3, allows APPROVE', () => {
  const booking = createMockBooking({
    authorizedCents: 1000,
    authorizedAmountUsd: '10.00',
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'extra_work', timestamp: '2026-11-11T10:05:00.000Z', client_reported: true, payload: { id: 'ew1', amount: 10, approved: true } },
      { type: 'extra_work', timestamp: '2026-11-11T10:10:00.000Z', client_reported: true, payload: { id: 'ew2', amount: 10, approved: true } },
      { type: 'extra_work', timestamp: '2026-11-11T10:15:00.000Z', client_reported: true, payload: { id: 'ew3', amount: 10, approved: true } },
      { type: 'extra_work', timestamp: '2026-11-11T10:20:00.000Z', client_reported: true, payload: { id: 'ew4', amount: 10, approved: true } },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z', client_reported: true }
    ]
  });

  const evidence = buildSettlementEvidence(booking);
  const flags = evaluateAnomalyRules(evidence);

  const manyFlag = flags.find((f) => f.id === 'RULE_MANY_EXTRA_WORK_EVENTS');
  assert.ok(manyFlag);
  assert.strictEqual(manyFlag.severity, 'low');

  // Low flags alone allow APPROVE
  const policy = decide(flags);
  assert.strictEqual(policy.decision, 'APPROVE');
  assert.ok(policy.reason.includes('advisory'));
});

test('8. RULE_EXCESSIVE_PAUSED_TIME: triggers LOW severity flag when paused time > 50% of elapsed time', () => {
  // Active = 20s, Paused = 40s (40 / 60 = 66% > 50%)
  const booking = createMockBooking({
    authorizedCents: 500,
    authorizedAmountUsd: '5.00',
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'pause_parts', timestamp: '2026-11-11T10:00:10.000Z', client_reported: true },
      { type: 'resume', timestamp: '2026-11-11T10:00:50.000Z', client_reported: true }, // paused 40s
      { type: 'complete', timestamp: '2026-11-11T10:01:00.000Z', client_reported: true } // total elapsed 60s
    ]
  });

  const evidence = buildSettlementEvidence(booking);
  assert.strictEqual(evidence.total_paused_seconds, 40);

  const flags = evaluateAnomalyRules(evidence);
  const pauseFlag = flags.find((f) => f.id === 'RULE_EXCESSIVE_PAUSED_TIME');
  assert.ok(pauseFlag);
  assert.strictEqual(pauseFlag.severity, 'low');
  assert.strictEqual(decide(flags).decision, 'APPROVE');
});

test('9. RULE_URGENCY_MISMATCH: triggers LOW advisory flag only when urgency diverges', () => {
  // Emergency booking with low urgency triage
  const bookingMismatch = createMockBooking({
    authorizedCents: 500,
    authorizedAmountUsd: '5.00',
    evidence: validateAndBuildEvidence({
      service_id: 's1',
      booking_type: 'emergency',
      distance_km: 0,
      first_time: false
    }),
    ai_triage: {
      trade_id: 's1',
      urgency: 'low',
      likely_parts: [],
      price_range_inr: { min: 100, max: 200 }
    },
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z', client_reported: true }
    ]
  });

  const evidence = buildSettlementEvidence(bookingMismatch);
  const flags = evaluateAnomalyRules(evidence);
  const mismatchFlag = flags.find((f) => f.id === 'RULE_URGENCY_MISMATCH');
  assert.ok(mismatchFlag);
  assert.strictEqual(mismatchFlag.severity, 'low');
  assert.strictEqual(decide(flags).decision, 'APPROVE');
});

test('10. decide() Invariant: Any high flag forces HOLD_FOR_HUMAN, even if multiple low flags exist', () => {
  const flags = [
    { id: 'RULE_MANY_EXTRA_WORK_EVENTS', severity: 'low', reason: 'Many extra work items' },
    { id: 'RULE_EXCESSIVE_EXTRAS', severity: 'high', reason: 'Extras exceed base bill' },
    { id: 'RULE_EXCESSIVE_PAUSED_TIME', severity: 'low', reason: 'High pause ratio' }
  ];

  const policy = decide(flags);
  assert.strictEqual(policy.decision, 'HOLD_FOR_HUMAN');
  assert.strictEqual(policy.reason, 'Extras exceed base bill');
  assert.strictEqual(policy.highFlags.length, 1);
  assert.strictEqual(policy.lowFlags.length, 2);
});

test('11. Dynamic Threshold Overrides: environment variables override rule defaults', () => {
  const defaultThresholds = getThresholds();
  assert.strictEqual(defaultThresholds.MIN_PLAUSIBLE_JOB_SECONDS, 20);
  assert.strictEqual(defaultThresholds.MAX_EXTRAS_RATIO, 1.0);

  // Custom overrides
  process.env.SETTLEMENT_MIN_PLAUSIBLE_JOB_SECONDS = '10';
  process.env.SETTLEMENT_MAX_EXTRAS_RATIO = '2.0';

  try {
    const customThresholds = getThresholds();
    assert.strictEqual(customThresholds.MIN_PLAUSIBLE_JOB_SECONDS, 10);
    assert.strictEqual(customThresholds.MAX_EXTRAS_RATIO, 2.0);

    // 15-second job with extras does not trigger with threshold = 10s
    const booking15s = createMockBooking({
      authorizedCents: 500,
      authorizedAmountUsd: '5.00',
      events: [
        { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
        { type: 'extra_work', timestamp: '2026-11-11T10:00:05.000Z', client_reported: true, payload: { id: 'ew1', amount: 30, approved: true } },
        { type: 'complete', timestamp: '2026-11-11T10:00:15.000Z', client_reported: true }
      ]
    });

    const evidence = buildSettlementEvidence(booking15s);
    const flags = evaluateAnomalyRules(evidence);
    assert.strictEqual(
      flags.some((f) => f.id === 'RULE_SUSPICIOUS_FAST_EXTRAS'),
      false
    );
  } finally {
    delete process.env.SETTLEMENT_MIN_PLAUSIBLE_JOB_SECONDS;
    delete process.env.SETTLEMENT_MAX_EXTRAS_RATIO;
  }
});
