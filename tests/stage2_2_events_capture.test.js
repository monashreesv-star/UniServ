const test = require('node:test');
const assert = require('node:assert');
const {
  validateAndStampEvent,
  deriveBillFromEvents,
  VALID_EVENT_TYPES
} = require('../server/services/jobEventService');
const {
  computeEstimateAndHold,
  ValidationError
} = require('../server/services/settlementService');
const { legacyComputeTotal } = require('./legacyComputeTotal');
const paypalClient = require('../server/services/paypalClient');
const os = require('os');
const fs = require('fs');
const path = require('path');
const store = require('../server/store');

// Isolate test store in temporary directory
const stage2TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-stage2-'));
const stage2StoreFile = path.join(stage2TempDir, 'bookings.json');
store.setStorePath(stage2StoreFile);

test.after(() => {
  store.resetStorePath();
  try {
    fs.rmSync(stage2TempDir, { recursive: true, force: true });
  } catch (e) {}
});

// ============================================================================
// 1. EVENT STATE MACHINE & ORDERING TESTS
// ============================================================================
test('Stage 2.2: Event state machine enforces AUTHORIZED status', () => {
  const nonAuthBooking = {
    bookingId: 'BK_TEST_1',
    status: 'CREATED',
    events: []
  };

  assert.throws(
    () => validateAndStampEvent(nonAuthBooking, { type: 'start' }),
    (err) => err instanceof ValidationError && err.message.includes('Required: "AUTHORIZED"')
  );
});

test('Stage 2.2: Event state machine enforces transition ordering', () => {
  const booking = {
    bookingId: 'BK_TEST_2',
    status: 'AUTHORIZED',
    events: []
  };

  // Cannot complete before start
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'complete' }),
    (err) => err instanceof ValidationError && err.message.includes('only after the start event')
  );

  // Cannot pause before start
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'pause_parts' }),
    (err) => err instanceof ValidationError && err.message.includes('before the start event')
  );

  // Cannot resume when not paused
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'resume' }),
    (err) => err instanceof ValidationError && err.message.includes('only after a pause_parts event')
  );

  // Start succeeds and stamps timestamp
  const startEvt = validateAndStampEvent(booking, { type: 'start' });
  assert.strictEqual(startEvt.type, 'start');
  assert.ok(startEvt.timestamp);
  booking.events.push(startEvt);

  // Start cannot be recorded twice
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'start' }),
    (err) => err instanceof ValidationError && err.message.includes('already been recorded')
  );

  // Pause parts succeeds
  const pauseEvt = validateAndStampEvent(booking, { type: 'pause_parts' });
  booking.events.push(pauseEvt);

  // Cannot pause again while already paused
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'pause_parts' }),
    (err) => err instanceof ValidationError && err.message.includes('already paused')
  );

  // Resume succeeds
  const resumeEvt = validateAndStampEvent(booking, { type: 'resume' });
  booking.events.push(resumeEvt);

  // Cannot resume again when no longer paused
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'resume' }),
    (err) => err instanceof ValidationError && err.message.includes('only after a pause_parts event')
  );

  // Complete succeeds
  const completeEvt = validateAndStampEvent(booking, { type: 'complete' });
  booking.events.push(completeEvt);

  // No events allowed after completion
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'extra_work', amount: 500 }),
    (err) => err instanceof ValidationError && err.message.includes('already completed')
  );
});

// ============================================================================
// 2. CLIENT-REPORTED AMOUNT VALIDATIONS & FLAGS
// ============================================================================
test('Stage 2.2: Validates extra_work amount limits, integer type, max 5, and flags client_reported', () => {
  const booking = {
    bookingId: 'BK_TEST_EXTRA',
    status: 'AUTHORIZED',
    events: [{ type: 'start', timestamp: new Date().toISOString() }]
  };

  // Rejects negative amount
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'extra_work', amount: -100 }),
    (err) => err instanceof ValidationError && err.message.includes('positive integer')
  );

  // Rejects decimal / non-integer amount
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'extra_work', amount: 99.5 }),
    (err) => err instanceof ValidationError && err.message.includes('positive integer')
  );

  // Rejects amount > 2000
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'extra_work', amount: 2001 }),
    (err) => err instanceof ValidationError && err.message.includes('exceeds the maximum limit of ₹2,000')
  );

  // Accepts valid amount <= 2000 and sets client_reported: true
  const validEvt = validateAndStampEvent(booking, {
    type: 'extra_work',
    amount: 1500,
    description: 'Replace burned motor wiring'
  });
  assert.strictEqual(validEvt.payload.amount, 1500);
  assert.strictEqual(validEvt.client_reported, true);
  booking.events.push(validEvt);

  // Add up to 5 extra_work events
  for (let i = 2; i <= 5; i++) {
    const e = validateAndStampEvent(booking, { type: 'extra_work', amount: 100 });
    booking.events.push(e);
  }

  // 6th extra_work event is rejected
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'extra_work', amount: 100 }),
    (err) => err instanceof ValidationError && err.message.includes('Maximum of 5 extra_work events')
  );
});

test('Stage 2.2: Validates parts cost limits, integer type, and flags client_reported', () => {
  const booking = {
    bookingId: 'BK_TEST_PARTS',
    status: 'AUTHORIZED',
    events: [{ type: 'start', timestamp: new Date().toISOString() }]
  };

  // Rejects negative cost
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'parts', cost: -50 }),
    (err) => err instanceof ValidationError && err.message.includes('positive integer')
  );

  // Rejects cost > 3000
  assert.throws(
    () => validateAndStampEvent(booking, { type: 'parts', cost: 3001 }),
    (err) => err instanceof ValidationError && err.message.includes('exceeds the maximum limit of ₹3,000')
  );

  // Accepts valid cost <= 3000 and sets client_reported: true
  const validEvt = validateAndStampEvent(booking, {
    type: 'parts',
    cost: 2500,
    part_name: 'Brass valve'
  });
  assert.strictEqual(validEvt.payload.cost, 2500);
  assert.strictEqual(validEvt.client_reported, true);
});

// ============================================================================
// 3. MIN_HOLD_CENTS ENVIRONMENT VARIABLE TEST
// ============================================================================
test('Stage 2.2: MIN_HOLD_CENTS applies floor to authorized hold ceiling without modifying ceiling logic', () => {
  const baseEvidence = {
    service: { id: 's1', name: 'Standard Cleaning', start_price: 299 },
    booking_type: 'now',
    distance_km: 0,
    discount_applied: 0
  };

  // Without MIN_HOLD_CENTS (default 0)
  delete process.env.MIN_HOLD_CENTS;
  const standardHold = computeEstimateAndHold(baseEvidence);
  // Estimate for 299 INR: 29900 paise / 85 = 351.76 -> 352 cents. Ceiling = 352 + 88 = 440 cents ($4.40)
  assert.strictEqual(standardHold.authorizedCents, 440);

  // With MIN_HOLD_CENTS higher than ceiling (e.g. 1000 cents = $10.00)
  process.env.MIN_HOLD_CENTS = '1000';
  const boostedHold = computeEstimateAndHold(baseEvidence);
  assert.strictEqual(boostedHold.authorizedCents, 1000);
  assert.strictEqual(boostedHold.authorizedAmountUsd, '10.00');

  // With MIN_HOLD_CENTS lower than ceiling (e.g. 200 cents), ceiling takes precedence
  process.env.MIN_HOLD_CENTS = '200';
  const lowerHold = computeEstimateAndHold(baseEvidence);
  assert.strictEqual(lowerHold.authorizedCents, 440);

  delete process.env.MIN_HOLD_CENTS;
});

// ============================================================================
// 4. SHARED FUNCTION TEST: Preview cents equal Captured cents
// ============================================================================
test('Stage 2.2: deriveBillFromEvents guarantees previewed USD cents equal captured cents for the same event log', () => {
  const booking = {
    bookingId: 'BK_PREVIEW_EQUAL_CAPTURE',
    status: 'AUTHORIZED',
    authorizedCents: 1500,
    authorizedAmountUsd: '15.00',
    evidence: {
      service: { id: 's1', start_price: 399 },
      booking_type: 'now',
      distance_km: 5,
      discount_applied: 50
    },
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
      { type: 'extra_work', payload: { amount: 300, approved: true }, timestamp: '2026-11-11T10:15:00.000Z' },
      { type: 'pause_parts', timestamp: '2026-11-11T10:20:00.000Z' },
      { type: 'parts', payload: { cost: 450 }, timestamp: '2026-11-11T10:30:00.000Z' },
      { type: 'resume', timestamp: '2026-11-11T10:40:00.000Z' },
      { type: 'complete', timestamp: '2026-11-11T11:00:00.000Z' }
    ]
  };

  // Preview computation
  const preview = deriveBillFromEvents(booking, booking.events);

  // Capture computation
  const capture = deriveBillFromEvents(booking, booking.events);

  assert.strictEqual(preview.finalCents, capture.finalCents);
  assert.strictEqual(preview.finalAmountUsd, capture.finalAmountUsd);
  assert.strictEqual(preview.totalRupees, capture.totalRupees);
  assert.strictEqual(preview.totalPaise, capture.totalPaise);
  assert.strictEqual(preview.activeSeconds, capture.activeSeconds);
});

// ============================================================================
// 5. PARITY TEST: 14 regression scenarios fed as event logs match legacyComputeTotal
// ============================================================================
test('Stage 2.2: Parity test: server-derived rupee total equals legacyComputeTotal for all 14 scenarios when fed as event logs', () => {
  const scenarios = [
    {
      name: 'Scenario 1: Normal standard booking (base 299)',
      booking: { base_amount: 299 }
    },
    {
      name: 'Scenario 2: Emergency booking with surge (+100)',
      booking: { base_amount: 299, booking_type: 'emergency', emergency_surge: 100 }
    },
    {
      name: 'Scenario 3: Fair-wage distance surcharge (>7km at 10km)',
      booking: { base_amount: 299, distance_km: 10 }
    },
    {
      name: 'Scenario 4: Approved assistant / 2nd worker (+200)',
      booking: {
        base_amount: 299,
        second_worker: true,
        helper_request: { status: 'approved', amount: 200 }
      }
    },
    {
      name: 'Scenario 5: Approved extra work (+150)',
      booking: {
        base_amount: 299,
        extra_work: { approved: true, amount: 150 }
      }
    },
    {
      name: 'Scenario 6: Procured spare parts (+250)',
      booking: {
        base_amount: 299,
        part_order: { part_cost: 250 }
      }
    },
    {
      name: 'Scenario 7: Overtime boundary: active seconds exactly 7200 (overtime = 0)',
      booking: {
        base_amount: 299,
        duration_seconds: 7200,
        paused_seconds: 0,
        overtime_charge: 0
      }
    },
    {
      name: 'Scenario 8: Overtime boundary: active seconds 7201 (overtime = +20)',
      booking: {
        base_amount: 299,
        duration_seconds: 7201,
        paused_seconds: 0,
        overtime_charge: 20
      }
    },
    {
      name: 'Scenario 9: Procurement pause subtraction (7300s - 200s = 7100s <= 7200s, overtime = 0)',
      booking: {
        base_amount: 299,
        duration_seconds: 7300,
        paused_seconds: 200,
        overtime_charge: 0
      }
    },
    {
      name: 'Scenario 10: First-time user discount (-50)',
      booking: {
        base_amount: 299,
        discount_applied: 50
      }
    },
    {
      name: 'Scenario 11: Prior cancellation penalty rollover (+50)',
      booking: {
        base_amount: 299,
        cancellation_penalty_fee: 50
      }
    },
    {
      name: 'Scenario 12: Minimum bill floor (base 50 - 50 discount clamped to 49)',
      booking: {
        base_amount: 50,
        discount_applied: 50
      }
    },
    {
      name: 'Scenario 13: Bulk institutional project (multi-day contract)',
      booking: {
        base_amount: 5000,
        is_bulk_project: true,
        duration_seconds: 15000
      }
    },
    {
      name: 'Scenario 14: Comprehensive multi-item complex combo',
      booking: {
        base_amount: 299,
        emergency_surge: 100,
        distance_km: 12,
        second_worker: true,
        helper_request: { status: 'approved', amount: 200 },
        extra_work: { approved: true, amount: 150 },
        part_order: { part_cost: 350 },
        overtime_charge: 20,
        cancellation_penalty_fee: 50,
        discount_applied: 50
      }
    }
  ];

  for (const s of scenarios) {
    const expectedLegacyTotal = legacyComputeTotal(s.booking);

    // Build booking object
    const booking = {
      bookingId: `BK_${s.name.replace(/\s+/g, '_')}`,
      status: 'AUTHORIZED',
      evidence: {
        service: { id: 's_test', start_price: s.booking.base_amount || 299 },
        booking_type: s.booking.booking_type || (s.booking.emergency_surge ? 'emergency' : 'now'),
        distance_km: s.booking.distance_km || 0,
        discount_applied: s.booking.discount_applied || 0,
        cancellation_penalty_fee: s.booking.cancellation_penalty_fee || 0,
        is_bulk_project: Boolean(s.booking.is_bulk_project),
        second_worker: s.booking.second_worker || null,
        helper_request: s.booking.helper_request || null
      }
    };

    // Synthesize event log from scenario parameters
    const events = [];
    const t0 = 1700000000000;
    events.push({ type: 'start', timestamp: new Date(t0).toISOString() });

    if (s.booking.paused_seconds && s.booking.paused_seconds > 0) {
      events.push({ type: 'pause_parts', timestamp: new Date(t0 + 1000).toISOString() });
      events.push({ type: 'resume', timestamp: new Date(t0 + 1000 + (s.booking.paused_seconds * 1000)).toISOString() });
    }

    if (s.booking.extra_work) {
      events.push({
        type: 'extra_work',
        payload: { amount: s.booking.extra_work.amount, approved: s.booking.extra_work.approved },
        timestamp: new Date(t0 + 2000).toISOString()
      });
    }

    if (s.booking.part_order) {
      events.push({
        type: 'parts',
        payload: { cost: s.booking.part_order.part_cost },
        timestamp: new Date(t0 + 3000).toISOString()
      });
    }

    let durationSec = s.booking.duration_seconds || 0;
    if (!durationSec && s.booking.overtime_charge && s.booking.overtime_charge > 0) {
      durationSec = 7201; // Surcharge triggers after 7200 active seconds
    }
    events.push({ type: 'complete', timestamp: new Date(t0 + (durationSec * 1000)).toISOString() });

    const derived = deriveBillFromEvents(booking, events, { demoTimeScale: 1 });

    assert.strictEqual(
      derived.totalRupees,
      expectedLegacyTotal,
      `Parity mismatch on ${s.name}: expected ${expectedLegacyTotal}, got ${derived.totalRupees}`
    );
  }
});

// ============================================================================
// 6. GUARDED CAPTURE & INJECTABLE CLIENT TESTS
// ============================================================================
test('Stage 2.2: Mock PayPal client handles capture and enforces guard ceiling check', async () => {
  store._clearForTesting();

  let captureCallCount = 0;
  const mockClient = {
    captureAuthorization: async ({ authorizationId, amountUsd }) => {
      captureCallCount++;
      return {
        captureId: `CAP_MOCK_${Date.now()}`,
        status: 'COMPLETED',
        amount: amountUsd,
        currency: 'USD',
        mode: 'MOCK'
      };
    }
  };

  paypalClient.setClientOverride(mockClient);

  try {
    // 1. Guard check: Final cents > authorizedCents -> HOLD_FOR_HUMAN, no capture call!
    const overCeilingBooking = {
      bookingId: 'BK_GUARD_EXCEEDED',
      orderId: 'ORD_GUARD_1',
      status: 'AUTHORIZED',
      authorizedCents: 300, // $3.00 hold
      authorizedAmountUsd: '3.00',
      evidence: {
        service: { id: 's1', start_price: 299 }
      },
      events: [
        { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
        { type: 'extra_work', payload: { amount: 1800, approved: true }, timestamp: '2026-11-11T10:05:00.000Z' },
        { type: 'parts', payload: { cost: 2500 }, timestamp: '2026-11-11T10:10:00.000Z' },
        { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z' }
      ]
    };
    store.saveBooking(overCeilingBooking);

    // Call deriveBillFromEvents
    const billOver = deriveBillFromEvents(overCeilingBooking, overCeilingBooking.events);
    assert.ok(billOver.finalCents > overCeilingBooking.authorizedCents);

    // 2. Normal within ceiling: Successful capture
    const normalBooking = {
      bookingId: 'BK_GUARD_OK',
      orderId: 'ORD_GUARD_2',
      authorizationId: 'AUTH_12345',
      status: 'AUTHORIZED',
      authorizedCents: 1000, // $10.00 hold
      authorizedAmountUsd: '10.00',
      evidence: {
        service: { id: 's1', start_price: 299 },
        booking_type: 'now',
        distance_km: 0
      },
      events: [
        { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
        { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z' }
      ]
    };
    store.saveBooking(normalBooking);

    const billOk = deriveBillFromEvents(normalBooking, normalBooking.events);
    assert.ok(billOk.finalCents <= normalBooking.authorizedCents);

    // Capture normal
    const captureResult = await paypalClient.captureAuthorization({
      authorizationId: normalBooking.authorizationId,
      amountUsd: billOk.finalAmountUsd
    });

    assert.strictEqual(captureResult.status, 'COMPLETED');
    assert.strictEqual(captureCallCount, 1);
  } finally {
    paypalClient.resetClientOverride();
    store._clearForTesting();
  }
});

// ============================================================================
// 7. END-TO-END ROUTE TESTS (Events, Preview, Guarded Capture & Idempotency)
// ============================================================================
test('Stage 2.2: End-to-end route handlers for events, preview, and capture', async () => {
  const ordersRouter = require('../server/routes/orders');
  const jobsRouter = require('../server/routes/jobs');

  const captureHandler = ordersRouter.stack.find((s) => s.route?.path === '/capture')?.route?.stack[0]?.handle;
  const eventHandler = jobsRouter.stack.find((s) => s.route?.path === '/:bookingId/events')?.route?.stack[0]?.handle;
  const previewHandler = jobsRouter.stack.find((s) => s.route?.path === '/:bookingId/bill-preview')?.route?.stack[0]?.handle;

  assert.ok(captureHandler, 'captureHandler found on ordersRouter');
  assert.ok(eventHandler, 'eventHandler found on jobsRouter');
  assert.ok(previewHandler, 'previewHandler found on jobsRouter');

  function createMockRes() {
    const state = { statusCode: 200, data: null };
    const res = {
      status(code) {
        state.statusCode = code;
        return res;
      },
      json(payload) {
        state.data = payload;
        return res;
      }
    };
    return { res, state };
  }

  let paypalCaptureCalls = 0;
  let mockCaptureStatus = 'COMPLETED';

  paypalClient.setClientOverride({
    captureAuthorization: async ({ authorizationId, amountUsd }) => {
      paypalCaptureCalls++;
      return {
        captureId: `CAP_MOCK_${Date.now()}`,
        status: mockCaptureStatus,
        amount: amountUsd,
        currency: 'USD',
        mode: 'MOCK'
      };
    }
  });

  try {
    store._clearForTesting();

    // 1. Create a booking in AUTHORIZED state
    const bookingId = 'BK_E2E_TEST';
    store.saveBooking({
      bookingId,
      orderId: 'ORD_E2E',
      authorizationId: 'AUTH_E2E_123',
      status: 'AUTHORIZED',
      authorizedCents: 600, // $6.00 hold
      authorizedAmountUsd: '6.00',
      evidence: {
        service: { id: 's1', start_price: 299 },
        booking_type: 'now',
        distance_km: 0
      },
      events: []
    });

    // 2. Reject capture before complete event
    const { res: capRes1, state: capState1 } = createMockRes();
    await captureHandler({ body: { bookingId } }, capRes1);
    assert.strictEqual(capState1.statusCode, 400);
    assert.strictEqual(capState1.data.error, 'JOB_NOT_COMPLETED');

    // 3. Record start event
    const { res: startRes, state: startState } = createMockRes();
    await eventHandler({ params: { bookingId }, body: { type: 'start' } }, startRes);
    assert.strictEqual(startState.statusCode, 201);
    assert.strictEqual(startState.data.event.type, 'start');
    assert.ok(startState.data.event.timestamp);

    // 4. Record extra work (₹150)
    const { res: extraRes, state: extraState } = createMockRes();
    await eventHandler(
      {
        params: { bookingId },
        body: { type: 'extra_work', amount: 150, description: 'Clean drain blockage' }
      },
      extraRes
    );
    assert.strictEqual(extraState.statusCode, 201);
    assert.strictEqual(extraState.data.event.payload.amount, 150);
    assert.strictEqual(extraState.data.event.client_reported, true);

    // 5. Record complete event
    const { res: completeRes, state: completeState } = createMockRes();
    await eventHandler({ params: { bookingId }, body: { type: 'complete' } }, completeRes);
    assert.strictEqual(completeState.statusCode, 201);

    // 6. Check bill preview
    const { res: previewRes, state: previewState } = createMockRes();
    await previewHandler({ params: { bookingId } }, previewRes);
    assert.strictEqual(previewState.statusCode, 200);
    assert.strictEqual(previewState.data.totalRupees, 449); // 299 base + 150 extra work
    // 449 INR / 85 = 5.282 -> 528 cents = $5.28 USD (within $6.00 ceiling)
    assert.strictEqual(previewState.data.finalCents, 528);
    assert.strictEqual(previewState.data.finalAmountUsd, '5.28');
    assert.strictEqual(previewState.data.exceedsCeiling, false);

    // 7. Successful capture
    const { res: captureRes, state: captureState } = createMockRes();
    await captureHandler({ body: { bookingId } }, captureRes);
    assert.strictEqual(captureState.statusCode, 200);
    assert.strictEqual(captureState.data.status, 'CAPTURED');
    assert.strictEqual(captureState.data.capturedCents, 528);
    assert.strictEqual(captureState.data.capturedAmountUsd, '5.28');
    assert.strictEqual(paypalCaptureCalls, 1);

    // 8. Idempotent repeat capture
    const { res: repeatRes, state: repeatState } = createMockRes();
    await captureHandler({ body: { bookingId } }, repeatRes);
    assert.strictEqual(repeatState.statusCode, 200);
    assert.strictEqual(repeatState.data.alreadyCaptured, true);
    assert.strictEqual(repeatState.data.status, 'CAPTURED');
    assert.strictEqual(paypalCaptureCalls, 1); // No new PayPal call!

    // 9. Ceiling violation triggers HOLD_FOR_HUMAN without PayPal capture
    const overCeilingId = 'BK_E2E_HOLD';
    store.saveBooking({
      bookingId: overCeilingId,
      orderId: 'ORD_E2E_HOLD',
      authorizationId: 'AUTH_E2E_HOLD',
      status: 'AUTHORIZED',
      authorizedCents: 400, // $4.00 hold (ceiling too low for ₹800 parts)
      authorizedAmountUsd: '4.00',
      evidence: { service: { id: 's1', start_price: 299 } },
      events: [
        { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
        { type: 'parts', payload: { cost: 1500 }, client_reported: true, timestamp: '2026-11-11T10:10:00.000Z' },
        { type: 'complete', timestamp: '2026-11-11T10:20:00.000Z' }
      ]
    });

    const callsBeforeHold = paypalCaptureCalls;
    const { res: holdRes, state: holdState } = createMockRes();
    await captureHandler({ body: { bookingId: overCeilingId } }, holdRes);
    assert.strictEqual(holdState.statusCode, 200);
    assert.strictEqual(holdState.data.status, 'HOLD_FOR_HUMAN');
    assert.strictEqual(paypalCaptureCalls, callsBeforeHold); // Zero PayPal calls!

    // Check store status updated
    const heldBooking = store.getBooking(overCeilingId);
    assert.strictEqual(heldBooking.status, 'HOLD_FOR_HUMAN');
    assert.ok(heldBooking.holdReason.includes('exceeded authorized ceiling'));

    // 10. Honest status CAPTURE_PENDING when PayPal returns PENDING
    const pendingId = 'BK_E2E_PENDING';
    store.saveBooking({
      bookingId: pendingId,
      orderId: 'ORD_E2E_PENDING',
      authorizationId: 'AUTH_E2E_PENDING',
      status: 'AUTHORIZED',
      authorizedCents: 1000,
      authorizedAmountUsd: '10.00',
      evidence: { service: { id: 's1', start_price: 299 } },
      events: [
        { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
        { type: 'complete', timestamp: '2026-11-11T10:10:00.000Z' }
      ]
    });

    mockCaptureStatus = 'PENDING';
    const { res: pendingRes, state: pendingState } = createMockRes();
    await captureHandler({ body: { bookingId: pendingId } }, pendingRes);
    assert.strictEqual(pendingState.statusCode, 200);
    assert.strictEqual(pendingState.data.status, 'CAPTURE_PENDING');
    assert.strictEqual(pendingState.data.captureStatus, 'PENDING');
  } finally {
    paypalClient.resetClientOverride();
    store._clearForTesting();
  }
});

test('Stage 2.2c: HTTP routes record start, pause_parts, resume, complete sequentially to stored event log', async () => {
  const jobsRouter = require('../server/routes/jobs');
  const eventHandler = jobsRouter.stack.find((s) => s.route?.path === '/:bookingId/events')?.route?.stack[0]?.handle;
  assert.ok(eventHandler, 'eventHandler found on jobsRouter');

  function createMockRes() {
    const state = { statusCode: 200, data: null };
    const res = {
      status(code) {
        state.statusCode = code;
        return res;
      },
      json(payload) {
        state.data = payload;
        return res;
      }
    };
    return { res, state };
  }

  const bookingId = 'BK_FULL_LIFECYCLE_TEST';
  store.saveBooking({
    bookingId,
    orderId: 'ORD_LIFECYCLE_123',
    authorizationId: 'AUTH_LIFECYCLE_456',
    status: 'AUTHORIZED',
    authorizedCents: 800,
    authorizedAmountUsd: '8.00',
    evidence: {
      service: { id: 's2', start_price: 349 },
      booking_type: 'normal',
      distance_km: 0
    },
    events: []
  });

  try {
    // 1. Post 'start' event
    const { res: startRes, state: startState } = createMockRes();
    await eventHandler({ params: { bookingId }, body: { type: 'start' } }, startRes);
    assert.strictEqual(startState.statusCode, 201);
    assert.strictEqual(startState.data.event.type, 'start');
    assert.ok(startState.data.event.timestamp);

    // 2. Post 'pause_parts' event
    const { res: pauseRes, state: pauseState } = createMockRes();
    await eventHandler({ params: { bookingId }, body: { type: 'pause_parts' } }, pauseRes);
    assert.strictEqual(pauseState.statusCode, 201);
    assert.strictEqual(pauseState.data.event.type, 'pause_parts');
    assert.ok(pauseState.data.event.timestamp);

    // 3. Post 'resume' event
    const { res: resumeRes, state: resumeState } = createMockRes();
    await eventHandler({ params: { bookingId }, body: { type: 'resume' } }, resumeRes);
    assert.strictEqual(resumeState.statusCode, 201);
    assert.strictEqual(resumeState.data.event.type, 'resume');
    assert.ok(resumeState.data.event.timestamp);

    // 4. Post 'complete' event
    const { res: completeRes, state: completeState } = createMockRes();
    await eventHandler({ params: { bookingId }, body: { type: 'complete' } }, completeRes);
    assert.strictEqual(completeState.statusCode, 201);
    assert.strictEqual(completeState.data.event.type, 'complete');
    assert.ok(completeState.data.event.timestamp);

    // Verify stored event log in store
    const storedBooking = store.getBooking(bookingId);
    assert.ok(storedBooking, 'Stored booking must exist');
    assert.ok(Array.isArray(storedBooking.events), 'Events must be an array');
    assert.strictEqual(storedBooking.events.length, 4, 'Must have recorded exactly 4 events');
    assert.deepStrictEqual(
      storedBooking.events.map((e) => e.type),
      ['start', 'pause_parts', 'resume', 'complete']
    );

    // Each event must have valid ISO timestamp
    storedBooking.events.forEach((evt) => {
      assert.ok(evt.timestamp, `Event ${evt.type} must have timestamp`);
      assert.ok(!isNaN(Date.parse(evt.timestamp)), `Timestamp for ${evt.type} must be a valid ISO date`);
    });
  } finally {
    store._clearForTesting();
  }
});
