/**
 * ============================================================================
 * UniServ Stage 6.1 Co-op Treasury Ledger Test Suite
 * ============================================================================
 * Verifies:
 *  1. Privacy Invariant: Zero receiver emails, zero 17-char PayPal IDs,
 *     zero un-truncated booking IDs (>8 chars), zero API keys in responses.
 *  2. Decision Invariant: Values are strictly SETTLED, HELD, PENDING, FAILED,
 *     or "n/a". No APPROVE or SIMULATED_APPROVE labels anywhere.
 *  3. Mode Separation: data_mode and agent_mode exposed as two distinct columns.
 *  4. Payout Integrity: Amounts derived from stored payoutItems (actual status),
 *     zero paid for held bookings, pending/unclaimed counted separately.
 *  5. Integer Math Consistency: Summary totals match the sum of row records.
 *  6. Anomaly & Diagnostic Fields: Policy flags, active seconds, PayPal fees.
 *  7. Legacy Resilience: Pre-Stage 3.1 bookings render cleanly with 'n/a'.
 *  8. XSS & Payload Safety: Extra work HTML payloads stay inert as text;
 *     ledger.js uses textContent throughout.
 *  9. Read-Only Invariant: Endpoints never modify the store file.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Isolate test store in a fresh temporary directory
const stage6TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-stage6-1-ledger-'));
const stage6StoreFile = path.join(stage6TempDir, 'bookings.json');

const store = require('../server/store');
store.setStorePath(stage6StoreFile);

test.after(() => {
  store.resetStorePath();
  try {
    fs.rmSync(stage6TempDir, { recursive: true, force: true });
  } catch (e) {}
});

const ledgerRouter = require('../server/routes/ledgerApi');

// Helper to invoke Express router directly
function invokeRoute(router, method, url, body = {}, appLocals = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      path: url,
      params: {},
      query: {},
      body,
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
      headers: {},
      app: { locals: appLocals }
    };

    const res = {
      statusCode: 200,
      _headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this._headers[name] = value;
        return this;
      },
      json(data) {
        resolve({ status: this.statusCode, body: data });
      },
      send(data) {
        resolve({ status: this.statusCode, body: data });
      }
    };

    router(req, res, (err) => {
      if (err) {
        resolve({ status: 500, body: { error: err.message } });
      } else {
        resolve({ status: 404, body: { error: 'NOT_FOUND' } });
      }
    });
  });
}

// Seed the temporary store with diverse realistic booking records
function populateTestBookings() {
  const bookings = {
    // 1. Settled booking with completed capture and successful payouts
    'BK_1794395032663_ltad2': {
      bookingId: 'BK_1794395032663_ltad2',
      orderId: '7NK11526SH761643Y',
      authorizationId: '49W87453DE524663G',
      captureId: '5CS04488UH4325355',
      payoutBatchId: 'BATCH_78945612301234',
      status: 'CAPTURED',
      captureStatus: 'COMPLETED',
      mode: 'REAL_SANDBOX',
      settlement_mode: 'AI_AGENT',
      settlement_decision: 'APPROVE', // Internal decision: should be presented as SETTLED
      authorizedCents: 293,
      capturedCents: 234,
      payoutRetainedCents: 9,
      paypal_fee_usd: '0.45',
      activeSeconds: 1420,
      createdAt: '2026-11-11T12:00:00.000Z',
      payer: {
        name: 'Priya Sharma',
        country: 'United States',
        payerId: '8W3Q2JGASCFXU'
      },
      evidence: {
        service: { id: 's1', name: 'Electrician', start_price: 99 },
        booking_type: 'emergency',
        extra_work: { description: 'Replaced charred 16A breaker' }
      },
      payoutItems: [
        {
          role: 'artisan',
          receiver: 'artisan_private_email@example.com',
          cents: 187,
          amountUsd: '1.87',
          status: 'SUCCESS'
        },
        {
          role: 'welfare',
          receiver: 'welfare_private_email@example.com',
          cents: 24,
          amountUsd: '0.24',
          status: 'SUCCESS'
        },
        {
          role: 'reserve',
          receiver: 'reserve_private_email@example.com',
          cents: 14,
          amountUsd: '0.14',
          status: 'SUCCESS'
        }
      ],
      settlement_trace: [
        {
          step: 1,
          type: 'evidence_built',
          booking_id: 'BK_1794395032663_ltad2',
          timestamp: '2026-11-11T12:05:00.000Z'
        },
        {
          step: 2,
          type: 'policy_evaluated',
          high_flags: [],
          low_flags: ['RULE_URGENCY_MISMATCH'],
          timestamp: '2026-11-11T12:05:01.000Z'
        },
        {
          step: 3,
          type: 'capture_executed',
          capture_id: '5CS04488UH4325355',
          timestamp: '2026-11-11T12:05:03.000Z'
        }
      ]
    },

    // 2. Held booking (HOLD_FOR_HUMAN) - must show 0.00 captured and 0.00 payouts
    'BK_1794395512321_pyi51': {
      bookingId: 'BK_1794395512321_pyi51',
      orderId: '8PL9876543210987A',
      authorizationId: '38K1234567890123B',
      status: 'HOLD_FOR_HUMAN',
      captureStatus: null,
      mode: 'REAL_SANDBOX',
      settlement_mode: 'RULES_ONLY',
      settlement_decision: 'HOLD_FOR_HUMAN',
      authorizedCents: 500,
      capturedCents: null,
      activeSeconds: 600,
      createdAt: '2026-11-11T13:00:00.000Z',
      payer: {
        country: 'Canada',
        payerId: 'CANPAYER12345678'
      },
      evidence: {
        service: { id: 's2', name: 'Plumber', start_price: 149 },
        booking_type: 'normal'
      },
      settlement_trace: [
        {
          step: 1,
          type: 'policy_evaluated',
          high_flags: ['RULE_EXCESSIVE_EXTRAS'],
          low_flags: []
        }
      ]
    },

    // 3. Pending booking (in progress agent run) with in-flight payout items
    'BK_1794400000000_pend1': {
      bookingId: 'BK_1794400000000_pend1',
      orderId: '9QA1112223334445B',
      status: 'CAPTURE_PENDING',
      settlementStatus: 'IN_PROGRESS',
      mode: 'SIMULATED',
      settlement_mode: 'REDUCED_AGENT',
      authorizedCents: 400,
      createdAt: '2026-11-11T14:00:00.000Z',
      payerCountry: 'United Kingdom',
      evidence: {
        service: { id: 's3', name: 'Carpenter' },
        booking_type: 'normal',
        extra_work: {
          description: '<img src=x onerror=alert(1)>' // XSS probe payload
        }
      },
      payoutItems: [
        {
          role: 'artisan',
          cents: 250,
          amountUsd: '2.50',
          status: 'PENDING'
        },
        {
          role: 'welfare',
          cents: 30,
          amountUsd: '0.30',
          status: 'UNCLAIMED'
        }
      ]
    },

    // 4. Legacy pre-Stage 3.1 booking with missing fields
    'BK_LEGACY_0001': {
      bookingId: 'BK_LEGACY_0001',
      orderId: 'OLDER_ORDER_1234',
      status: 'CREATED',
      createdAt: '2026-10-01T10:00:00.000Z'
    }
  };

  store.writeAll(bookings);
}

// ----------------------------------------------------------------------------
// Test 1: Privacy Invariant & Redaction
// ----------------------------------------------------------------------------
test('Test 1: Privacy Invariant across all endpoints', async () => {
  populateTestBookings();

  const [resRecords, resSummary] = await Promise.all([
    invokeRoute(ledgerRouter, 'GET', '/records'),
    invokeRoute(ledgerRouter, 'GET', '/summary')
  ]);

  assert.strictEqual(resRecords.status, 200);
  assert.strictEqual(resSummary.status, 200);

  const recordsJson = JSON.stringify(resRecords.body);
  const summaryJson = JSON.stringify(resSummary.body);

  // 1. Zero email patterns
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  assert.strictEqual(
    (recordsJson.match(emailRegex) || []).length,
    0,
    'Records response must contain 0 email addresses'
  );
  assert.strictEqual(
    (summaryJson.match(emailRegex) || []).length,
    0,
    'Summary response must contain 0 email addresses'
  );

  // 2. Zero 17-character uppercase alphanumeric PayPal IDs
  const paypal17Regex = /\b[A-Z0-9]{17}\b/g;
  assert.strictEqual(
    (recordsJson.match(paypal17Regex) || []).length,
    0,
    'Records response must contain 0 17-character PayPal IDs'
  );
  assert.strictEqual(
    (summaryJson.match(paypal17Regex) || []).length,
    0,
    'Summary response must contain 0 17-character PayPal IDs'
  );

  // 3. Zero un-truncated booking IDs (BK_ followed by >6 alphanumeric/underscore chars, total length > 8)
  const longBookingIdRegex = /\bBK_[A-Za-z0-9_]{6,}\b/gi;
  assert.strictEqual(
    (recordsJson.match(longBookingIdRegex) || []).length,
    0,
    'Records response must not contain full booking IDs longer than 8 characters'
  );

  // 4. Zero API key patterns
  const apiKeyRegex = /AIza[0-9A-Za-z-_]{35}/g;
  assert.strictEqual(
    (recordsJson.match(apiKeyRegex) || []).length,
    0,
    'Records response must not contain Gemini API keys'
  );

  // 5. Booking IDs in records are strictly truncated to <= 8 chars
  for (const r of resRecords.body.records) {
    assert.ok(
      r.booking_id.length <= 8,
      `booking_id "${r.booking_id}" exceeds 8 characters`
    );
  }
});

// ----------------------------------------------------------------------------
// Test 2: Honest Decision Values & Mode Separation
// ----------------------------------------------------------------------------
test('Test 2: Honest Decision Values and Separate Mode Columns', async () => {
  populateTestBookings();

  const res = await invokeRoute(ledgerRouter, 'GET', '/records');
  assert.strictEqual(res.status, 200);

  const allowedDecisions = new Set(['SETTLED', 'HELD', 'PENDING', 'FAILED', 'n/a']);
  const allowedDataModes = new Set(['REAL_SANDBOX', 'SIMULATED', 'n/a']);
  const allowedAgentModes = new Set(['AI_AGENT', 'REDUCED_AGENT', 'RULES_ONLY', 'n/a']);

  for (const r of res.body.records) {
    // Decision checks
    assert.ok(
      allowedDecisions.has(r.decision),
      `Unexpected decision "${r.decision}" on booking ${r.booking_id}`
    );
    assert.notStrictEqual(r.decision, 'APPROVE', 'APPROVE must never appear in ledger');
    assert.notStrictEqual(r.decision, 'SIMULATED_APPROVE', 'SIMULATED_APPROVE must never appear in ledger');

    // Mode separation
    assert.ok(
      allowedDataModes.has(r.data_mode),
      `Invalid data_mode "${r.data_mode}" on booking ${r.booking_id}`
    );
    assert.ok(
      allowedAgentModes.has(r.agent_mode),
      `Invalid agent_mode "${r.agent_mode}" on booking ${r.booking_id}`
    );
  }

  // Specifically verify mapped records
  const settledRec = res.body.records.find((r) => r.booking_id === '63_ltad2');
  assert.ok(settledRec, 'Settled record should exist');
  assert.strictEqual(settledRec.decision, 'SETTLED');
  assert.strictEqual(settledRec.data_mode, 'REAL_SANDBOX');
  assert.strictEqual(settledRec.agent_mode, 'AI_AGENT');

  const heldRec = res.body.records.find((r) => r.booking_id === '21_pyi51');
  assert.ok(heldRec, 'Held record should exist');
  assert.strictEqual(heldRec.decision, 'HELD');
  assert.strictEqual(heldRec.captured_usd, '0.00');
  assert.strictEqual(heldRec.breakdown.artisan_wages_usd, '0.00');

  const pendRec = res.body.records.find((r) => r.booking_id === '00_pend1');
  assert.ok(pendRec, 'Pending record should exist');
  assert.strictEqual(pendRec.decision, 'PENDING');
  assert.strictEqual(pendRec.data_mode, 'SIMULATED');
  assert.strictEqual(pendRec.agent_mode, 'REDUCED_AGENT');
});

// ----------------------------------------------------------------------------
// Test 3: Payout Amounts & Integer Cent Consistency
// ----------------------------------------------------------------------------
test('Test 3: Payout Amounts from Stored Items and Exact Integer Math', async () => {
  populateTestBookings();

  const [resRecords, resSummary] = await Promise.all([
    invokeRoute(ledgerRouter, 'GET', '/records'),
    invokeRoute(ledgerRouter, 'GET', '/summary')
  ]);

  const records = resRecords.body.records;
  const summary = resSummary.body;

  // 1. Verify summary totals match sum of records exactly
  let sumAuthCents = 0;
  let sumCapCents = 0;
  let sumArtisanCents = 0;
  let sumWelfareCents = 0;
  let sumReserveCents = 0;
  let sumPlatformCents = 0;

  for (const r of records) {
    sumAuthCents += Math.round(parseFloat(r.authorized_usd) * 100);
    sumCapCents += Math.round(parseFloat(r.captured_usd) * 100);
    sumArtisanCents += Math.round(parseFloat(r.breakdown.artisan_wages_usd) * 100);
    sumWelfareCents += Math.round(parseFloat(r.breakdown.welfare_usd) * 100);
    sumReserveCents += Math.round(parseFloat(r.breakdown.reserve_usd) * 100);
    sumPlatformCents += Math.round(parseFloat(r.breakdown.platform_retained_usd) * 100);
  }

  assert.strictEqual((sumAuthCents / 100).toFixed(2), summary.total_authorized_usd);
  assert.strictEqual((sumCapCents / 100).toFixed(2), summary.total_captured_usd);
  assert.strictEqual((sumArtisanCents / 100).toFixed(2), summary.total_artisan_wages_paid_usd);
  assert.strictEqual((sumWelfareCents / 100).toFixed(2), summary.total_welfare_paid_usd);
  assert.strictEqual((sumReserveCents / 100).toFixed(2), summary.total_reserve_paid_usd);
  assert.strictEqual((sumPlatformCents / 100).toFixed(2), summary.total_platform_retained_usd);

  // 2. Verify pending and unclaimed totals are separated
  assert.strictEqual(summary.total_payouts_pending_usd, '2.50');
  assert.strictEqual(summary.total_payouts_unclaimed_usd, '0.30');

  // 3. Verify counts by decision match exact counts in records
  const expectedCounts = { SETTLED: 1, HELD: 1, PENDING: 1, FAILED: 0, 'n/a': 1 };
  assert.deepStrictEqual(summary.counts_by_decision, expectedCounts);
});

// ----------------------------------------------------------------------------
// Test 4: Diagnostic Fields & Legacy Booking Resilience
// ----------------------------------------------------------------------------
test('Test 4: Policy Flags, Active Seconds, Fees, and Legacy Resilience', async () => {
  populateTestBookings();

  const res = await invokeRoute(ledgerRouter, 'GET', '/records');
  const records = res.body.records;

  // Settled booking has policy flag RULE_URGENCY_MISMATCH and fee
  const settledRec = records.find((r) => r.booking_id === '63_ltad2');
  assert.deepStrictEqual(settledRec.policy_flags, ['RULE_URGENCY_MISMATCH']);
  assert.strictEqual(settledRec.active_seconds, 1420);
  assert.strictEqual(settledRec.breakdown.paypal_fee_usd, '0.45');
  assert.strictEqual(settledRec.capture_id, '5355');
  assert.strictEqual(settledRec.payout_batch_id, '1234');

  // Legacy booking from before Stage 3.1
  const legacyRec = records.find((r) => r.booking_id === 'ACY_0001');
  assert.ok(legacyRec, 'Legacy booking should render');
  assert.strictEqual(legacyRec.decision, 'n/a');
  assert.strictEqual(legacyRec.agent_mode, 'n/a');
  assert.strictEqual(legacyRec.policy_flags, 'n/a');
  assert.strictEqual(legacyRec.active_seconds, 'n/a');
  assert.strictEqual(legacyRec.breakdown.paypal_fee_usd, 'n/a');
});

// ----------------------------------------------------------------------------
// Test 5: XSS Payload Safety & textContent Invariant
// ----------------------------------------------------------------------------
test('Test 5: XSS Payload Safety and textContent Invariant in Client Code', async () => {
  populateTestBookings();

  const res = await invokeRoute(ledgerRouter, 'GET', '/records');
  const pendRec = res.body.records.find((r) => r.booking_id === '00_pend1');

  // Extra work HTML payload returned as inert string data
  assert.strictEqual(pendRec.extra_work_description, '<img src=x onerror=alert(1)>');

  // Inspect server/public/ledger.js to ensure no innerHTML usage for store-derived data
  const ledgerJsPath = path.resolve(__dirname, '../server/public/ledger.js');
  const ledgerJsContent = fs.readFileSync(ledgerJsPath, 'utf8');

  // Assert .innerHTML is never assigned store data
  assert.ok(
    !ledgerJsContent.includes('.innerHTML ='),
    'ledger.js must not contain any innerHTML assignments'
  );
  assert.ok(
    ledgerJsContent.includes('.textContent ='),
    'ledger.js must use textContent for rendering text'
  );
});

// ----------------------------------------------------------------------------
// Test 6: Read-Only Invariant
// ----------------------------------------------------------------------------
test('Test 6: Read-Only Invariant: store file remains byte-for-byte unchanged', async () => {
  populateTestBookings();

  const hashBefore = crypto
    .createHash('sha256')
    .update(fs.readFileSync(stage6StoreFile))
    .digest('hex');

  // Invoke endpoints repeatedly
  await Promise.all([
    invokeRoute(ledgerRouter, 'GET', '/records'),
    invokeRoute(ledgerRouter, 'GET', '/summary'),
    invokeRoute(ledgerRouter, 'GET', '/records'),
    invokeRoute(ledgerRouter, 'GET', '/summary')
  ]);

  const hashAfter = crypto
    .createHash('sha256')
    .update(fs.readFileSync(stage6StoreFile))
    .digest('hex');

  assert.strictEqual(hashBefore, hashAfter, 'Store file hash must not change across ledger requests');
});
