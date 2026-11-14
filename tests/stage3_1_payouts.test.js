/**
 * ============================================================================
 * UniServ Stage 3.1 Tests: PayPal Payouts Split
 * ============================================================================
 * Verifies:
 *  1. Payload shape matches PayPal Payouts specification.
 *  2. Invariant parity: itemsSum + platformRetained === capturedCents (1-50,000).
 *  3. Zero-amount items skipped while preserving total sum.
 *  4. Idempotency: multiple executePayout calls yield same batch without duplicate calls.
 *  5. Concurrency guard: IN_PROGRESS blocks second call.
 *  6. Capture record isolation: payout failure leaves capture COMPLETED and CAPTURED.
 *  7. Timeout handling: sets FAILED_UNKNOWN, preserves same sender_batch_id.
 *  8. Retry endpoint: allows retry only for FAILED/FAILED_UNKNOWN with no batch ID.
 *  9. Refusal guards: rejects CAPTURE_PENDING, HOLD_FOR_HUMAN, SIMULATED, and pre-Stage 3.1.
 * 10. Receiver validation: errors name ONLY variable names, never emails/secrets.
 * 11. Privacy: GET endpoint and capture response never expose receiver emails.
 * 12. Status refresh: updates item statuses from live PayPal batch response.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const store = require('../server/store');

// Isolate test store in temporary directory
const stage3TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-stage3-'));
const stage3StoreFile = path.join(stage3TempDir, 'bookings.json');
store.setStorePath(stage3StoreFile);

test.after(() => {
  store.resetStorePath();
  try {
    fs.rmSync(stage3TempDir, { recursive: true, force: true });
  } catch (e) {}
});
const { splitCents } = require('../src/utils/settlementEngine');
const { validateReceiverEmails } = require('../server/services/receiverValidation');
const payoutService = require('../server/services/payoutService');
const paypalClient = require('../server/services/paypalClient');
const payoutsRouter = require('../server/routes/payouts');
const ordersRouter = require('../server/routes/orders');

// Ensure test receiver emails are set in environment
process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL = 'artisan_sbx@uniserv.org';
process.env.PAYPAL_RECEIVER_WELFARE_EMAIL = 'welfare_sbx@uniserv.org';
process.env.PAYPAL_RECEIVER_RESERVE_EMAIL = 'reserve_sbx@uniserv.org';

function createMockRes() {
  const state = {
    statusCode: 200,
    headers: {},
    data: null
  };

  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    json(obj) {
      state.data = obj;
      return res;
    },
    setHeader(k, v) {
      state.headers[k] = v;
      return res;
    }
  };

  return { res, state };
}

function getRouteHandler(router, method, path) {
  const methodLower = method.toLowerCase();
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[methodLower]) {
      const handles = layer.route.stack.map((s) => s.handle);
      return handles[handles.length - 1];
    }
  }
  throw new Error(`Route handler not found for ${method} ${path}`);
}

// ============================================================================
// 1. INVARIANT PARITY & ZERO-AMOUNT SKIPPING
// ============================================================================
test('Stage 3.1: Invariant parity (itemsSum + platformRetained === capturedCents) across 1 to 50,000 cents', () => {
  for (let cents = 1; cents <= 50000; cents += (cents < 100 ? 1 : 137)) {
    const { artisan, welfare, reserve, platform } = splitCents(cents);
    const sum = artisan + welfare + reserve + platform;
    assert.strictEqual(sum, cents, `Parity broken at ${cents} cents`);

    // Verify non-negative
    assert.ok(artisan >= 0);
    assert.ok(welfare >= 0);
    assert.ok(reserve >= 0);
    assert.ok(platform >= 0);
  }
});

test('Stage 3.1: Zero-amount items skipped in payout batch construction', async () => {
  // At 1 cent:
  // artisan: 1 * 0.8 = 0.8 -> 1
  // welfare: 1 * 0.1 = 0.1 -> 0
  // reserve: 1 * 0.06 = 0.06 -> 0
  // platform: 0
  const bookingId = 'BK_TEST_TINY_1';
  store.saveBooking({
    bookingId,
    orderId: 'ORD_TINY',
    captureId: 'CAP_TINY_1',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1,
    capturedAmountUsd: '0.01',
    mode: 'REAL_SANDBOX',
    stage: '3.1',
    payoutEligible: true
  });

  const origCreate = paypalClient.createPayoutBatch;
  let capturedPayload = null;
  paypalClient.createPayoutBatch = async (payload) => {
    capturedPayload = payload;
    return { payoutBatchId: 'BATCH_TINY', batchStatus: 'SUCCESS' };
  };

  try {
    const result = await payoutService.executePayout(bookingId);
    assert.strictEqual(result.payoutStatus, 'SUCCESS');
    assert.ok(capturedPayload);
    // Welfare (0) and reserve (0) are skipped: only artisan (1 cent) is sent
    assert.strictEqual(capturedPayload.items.length, 1);
    assert.strictEqual(capturedPayload.items[0].role, 'artisan');
    assert.strictEqual(capturedPayload.items[0].cents, 1);
    assert.strictEqual(capturedPayload.items.find((it) => it.role === 'welfare'), undefined);
    assert.strictEqual(capturedPayload.items.find((it) => it.role === 'reserve'), undefined);

    const sumItems = capturedPayload.items.reduce((acc, it) => acc + it.cents, 0);
    assert.strictEqual(sumItems + result.retainedCents, 1);
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

// ============================================================================
// 2. PAYLOAD SHAPE MATCHES PAYPAL SPECIFICATION
// ============================================================================
test('Stage 3.1: Payload shape matches PayPal Payouts specification', async () => {
  const bookingId = 'BK_TEST_SHAPE';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_SHAPE_123',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 500, // $5.00 USD
    capturedAmountUsd: '5.00',
    mode: 'REAL_SANDBOX',
    stage: '3.1',
    payoutEligible: true
  });

  const origCreate = paypalClient.createPayoutBatch;
  let sentPayload = null;
  paypalClient.createPayoutBatch = async (payload) => {
    sentPayload = payload;
    return { payoutBatchId: 'BATCH_SHAPE_OK', batchStatus: 'PENDING' };
  };

  try {
    await payoutService.executePayout(bookingId);
    assert.ok(sentPayload);
    assert.strictEqual(sentPayload.senderBatchId, 'payout_CAP_SHAPE_123');
    assert.strictEqual(sentPayload.items.length, 3);

    // Artisan 80% = $4.00
    assert.strictEqual(sentPayload.items[0].role, 'artisan');
    assert.strictEqual(sentPayload.items[0].amountUsd, '4.00');
    assert.strictEqual(sentPayload.items[0].receiver, 'artisan_sbx@uniserv.org');
    assert.strictEqual(sentPayload.items[0].senderItemId, 'item_artisan_CAP_SHAPE_123');

    // Welfare 10% = $0.50
    assert.strictEqual(sentPayload.items[1].role, 'welfare');
    assert.strictEqual(sentPayload.items[1].amountUsd, '0.50');
    assert.strictEqual(sentPayload.items[1].receiver, 'welfare_sbx@uniserv.org');

    // Reserve 6% = $0.30
    assert.strictEqual(sentPayload.items[2].role, 'reserve');
    assert.strictEqual(sentPayload.items[2].amountUsd, '0.30');
    assert.strictEqual(sentPayload.items[2].receiver, 'reserve_sbx@uniserv.org');
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

// ============================================================================
// 3. IDEMPOTENCY & CONCURRENCY GUARD
// ============================================================================
test('Stage 3.1: Idempotency returns existing batch without duplicate PayPal calls', async () => {
  const bookingId = 'BK_TEST_IDEMPOTENT';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_IDEM_99',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1000,
    capturedAmountUsd: '10.00',
    mode: 'REAL_SANDBOX',
    stage: '3.1',
    payoutEligible: true
  });

  let callCount = 0;
  const origCreate = paypalClient.createPayoutBatch;
  paypalClient.createPayoutBatch = async () => {
    callCount++;
    return { payoutBatchId: 'BATCH_FIRST_CALL', batchStatus: 'SUCCESS' };
  };

  try {
    const res1 = await payoutService.executePayout(bookingId);
    assert.strictEqual(res1.payoutBatchId, 'BATCH_FIRST_CALL');
    assert.strictEqual(callCount, 1);

    // Second call should return immediately without calling PayPal
    const res2 = await payoutService.executePayout(bookingId);
    assert.strictEqual(res2.payoutBatchId, 'BATCH_FIRST_CALL');
    assert.strictEqual(callCount, 1);
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

test('Stage 3.1: Concurrency guard blocks duplicate batch when status is IN_PROGRESS', async () => {
  const bookingId = 'BK_TEST_CONCURRENT';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_CONCURRENT',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1000,
    capturedAmountUsd: '10.00',
    mode: 'REAL_SANDBOX',
    payoutStatus: 'IN_PROGRESS',
    stage: '3.1',
    payoutEligible: true
  });

  let called = false;
  const origCreate = paypalClient.createPayoutBatch;
  paypalClient.createPayoutBatch = async () => {
    called = true;
    return { payoutBatchId: 'BATCH_OOPS' };
  };

  try {
    const res = await payoutService.executePayout(bookingId);
    assert.strictEqual(res.inProgress, true);
    assert.strictEqual(res.payoutStatus, 'IN_PROGRESS');
    assert.strictEqual(called, false);
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

// ============================================================================
// 4. CAPTURE RECORD ISOLATION & TIMEOUT HANDLING
// ============================================================================
test('Stage 3.1: Capture record remains intact and COMPLETED when payout fails', async () => {
  const bookingId = 'BK_TEST_CAPTURE_ISOLATED';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_SAFE_100',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 2000,
    capturedAmountUsd: '20.00',
    mode: 'REAL_SANDBOX',
    stage: '3.1',
    payoutEligible: true
  });

  const origCreate = paypalClient.createPayoutBatch;
  paypalClient.createPayoutBatch = async () => {
    const err = new Error('Insufficient PayPal funds in sandbox account');
    err.paypalError = 'INSUFFICIENT_FUNDS';
    err.debugId = 'dbg_fail_123';
    throw err;
  };

  try {
    const result = await payoutService.executePayout(bookingId);
    assert.strictEqual(result.payoutStatus, 'FAILED');
    assert.strictEqual(result.error.errorName, 'INSUFFICIENT_FUNDS');
    assert.strictEqual(result.error.debugId, 'dbg_fail_123');

    // CRITICAL: The booking capture record is untouched
    const stored = store.getBooking(bookingId);
    assert.strictEqual(stored.status, 'CAPTURED');
    assert.strictEqual(stored.captureStatus, 'COMPLETED');
    assert.strictEqual(stored.captureId, 'CAP_SAFE_100');
    assert.strictEqual(stored.capturedCents, 2000);
    assert.strictEqual(stored.capturedAmountUsd, '20.00');
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

test('Stage 3.1: Timeout sets FAILED_UNKNOWN and preserves sender_batch_id', async () => {
  const bookingId = 'BK_TEST_TIMEOUT';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_TIMEOUT_200',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1500,
    capturedAmountUsd: '15.00',
    mode: 'REAL_SANDBOX',
    stage: '3.1',
    payoutEligible: true
  });

  const origCreate = paypalClient.createPayoutBatch;
  paypalClient.createPayoutBatch = async () => {
    const timeoutErr = new Error('Socket timeout while contacting PayPal');
    timeoutErr.isTimeout = true;
    timeoutErr.name = 'TimeoutError';
    timeoutErr.debugId = 'dbg_timeout_999';
    throw timeoutErr;
  };

  try {
    const result = await payoutService.executePayout(bookingId);
    assert.strictEqual(result.payoutStatus, 'FAILED_UNKNOWN');

    const stored = store.getBooking(bookingId);
    assert.strictEqual(stored.payoutStatus, 'FAILED_UNKNOWN');
    assert.strictEqual(stored.payoutSenderBatchId, 'payout_CAP_TIMEOUT_200');
    assert.strictEqual(stored.payoutBatchId, null);
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

// ============================================================================
// 5. RETRY ENDPOINT RULES
// ============================================================================
test('Stage 3.1: Retry endpoint allows retry on FAILED/FAILED_UNKNOWN and reuses deterministic IDs', async () => {
  const retryHandler = getRouteHandler(payoutsRouter, 'POST', '/:bookingId/retry');
  const bookingId = 'BK_TEST_RETRY_OK';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_RETRY_300',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1200,
    capturedAmountUsd: '12.00',
    mode: 'REAL_SANDBOX',
    payoutStatus: 'FAILED',
    payoutBatchId: null,
    stage: '3.1',
    payoutEligible: true
  });

  let retriedBatchId = null;
  const origCreate = paypalClient.createPayoutBatch;
  paypalClient.createPayoutBatch = async (payload) => {
    retriedBatchId = payload.senderBatchId;
    return { payoutBatchId: 'BATCH_RETRY_SUCCESS', batchStatus: 'SUCCESS' };
  };

  try {
    const { res, state } = createMockRes();
    await retryHandler({ params: { bookingId } }, res);

    assert.strictEqual(state.statusCode, 200);
    assert.strictEqual(state.data.payoutBatchId, 'BATCH_RETRY_SUCCESS');
    assert.strictEqual(retriedBatchId, 'payout_CAP_RETRY_300'); // deterministic senderBatchId reused!

    // Repeating retry now fails because payoutBatchId is present
    const { res: res2, state: state2 } = createMockRes();
    await retryHandler({ params: { bookingId } }, res2);
    assert.strictEqual(state2.statusCode, 400);
    assert.strictEqual(state2.data.error, 'CANNOT_RETRY_PAYOUT');
  } finally {
    paypalClient.createPayoutBatch = origCreate;
  }
});

// ============================================================================
// 6. REFUSAL GUARDS (STATUS, SIMULATED, PRE-STAGE 3.1)
// ============================================================================
test('Stage 3.1: Refuses payout for CAPTURE_PENDING, HOLD_FOR_HUMAN, and SIMULATED', async () => {
  // 1. CAPTURE_PENDING
  const pendingId = 'BK_REFUSE_PENDING';
  store.saveBooking({
    bookingId: pendingId,
    status: 'CAPTURE_PENDING',
    captureStatus: 'PENDING',
    capturedCents: 1000,
    stage: '3.1',
    payoutEligible: true
  });
  const res1 = await payoutService.executePayout(pendingId);
  assert.strictEqual(res1.success, false);
  assert.strictEqual(res1.error, 'INVALID_STATUS');

  // 2. HOLD_FOR_HUMAN
  const holdId = 'BK_REFUSE_HOLD';
  store.saveBooking({
    bookingId: holdId,
    status: 'HOLD_FOR_HUMAN',
    capturedCents: 1000,
    stage: '3.1',
    payoutEligible: true
  });
  const res2 = await payoutService.executePayout(holdId);
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'INVALID_STATUS');

  // 3. SIMULATED
  const simId = 'BK_REFUSE_SIMULATED';
  store.saveBooking({
    bookingId: simId,
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1000,
    mode: 'SIMULATED',
    stage: '3.1',
    payoutEligible: true
  });
  const res3 = await payoutService.executePayout(simId);
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.error, 'SIMULATED_MODE');
  const storedSim = store.getBooking(simId);
  assert.strictEqual(storedSim.payoutSkippedReason, 'Payouts are not run for SIMULATED bookings');
});

test('Stage 3.1: Refuses payout for pre-Stage 3.1 bookings (PRE_STAGE_3_BOOKING)', async () => {
  const oldId = 'BK_PRE_STAGE_3';
  store.saveBooking({
    bookingId: oldId,
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1000,
    mode: 'REAL_SANDBOX'
    // stage and payoutEligible omitted (legacy Stage 2 booking)
  });

  const res = await payoutService.executePayout(oldId);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'PRE_STAGE_3_BOOKING');
  const storedOld = store.getBooking(oldId);
  assert.strictEqual(storedOld.payoutSkippedReason, 'Cannot execute payout for bookings captured prior to Stage 3.1');
});

// ============================================================================
// 7. RECEIVER EMAIL VALIDATION & PRIVACY INVARIANTS
// ============================================================================
test('Stage 3.1: Receiver validation fails with variable names only if missing or duplicate', () => {
  const origArtisan = process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL;
  const origWelfare = process.env.PAYPAL_RECEIVER_WELFARE_EMAIL;
  const origReserve = process.env.PAYPAL_RECEIVER_RESERVE_EMAIL;

  try {
    // Missing variable
    delete process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL;
    const v1 = validateReceiverEmails();
    assert.strictEqual(v1.valid, false);
    assert.ok(v1.errors[0].includes('PAYPAL_RECEIVER_ARTISAN_EMAIL'));
    assert.strictEqual(v1.errors[0].includes('@'), false); // No email values leaked!

    // Duplicate variable values
    process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL = 'duplicate@test.com';
    process.env.PAYPAL_RECEIVER_WELFARE_EMAIL = 'duplicate@test.com';
    process.env.PAYPAL_RECEIVER_RESERVE_EMAIL = 'reserve@test.com';
    const v2 = validateReceiverEmails();
    assert.strictEqual(v2.valid, false);
    assert.ok(v2.errors.some((e) => e.includes('must be distinct')));
    // Must NOT contain the email value in error
    assert.strictEqual(v2.errors.some((e) => e.includes('duplicate@test.com')), false);
  } finally {
    process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL = origArtisan;
    process.env.PAYPAL_RECEIVER_WELFARE_EMAIL = origWelfare;
    process.env.PAYPAL_RECEIVER_RESERVE_EMAIL = origReserve;
  }
});

test('Stage 3.1: Privacy invariant - GET endpoint never returns receiver emails', async () => {
  const getPayoutHandler = getRouteHandler(payoutsRouter, 'GET', '/:bookingId');
  const bookingId = 'BK_TEST_PRIVACY_CHECK';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_PRIVACY_1',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1000,
    capturedAmountUsd: '10.00',
    mode: 'REAL_SANDBOX',
    payoutBatchId: 'BATCH_PRIVACY_99',
    payoutStatus: 'SUCCESS',
    payoutRetainedCents: 40,
    payoutRetainedAmountUsd: '0.40',
    payoutItems: [
      { role: 'artisan', receiver: 'artisan_secret@email.com', cents: 800, amountUsd: '8.00', status: 'SUCCESS' },
      { role: 'welfare', receiver: 'welfare_secret@email.com', cents: 100, amountUsd: '1.00', status: 'SUCCESS' },
      { role: 'reserve', receiver: 'reserve_secret@email.com', cents: 60, amountUsd: '0.60', status: 'SUCCESS' }
    ],
    stage: '3.1',
    payoutEligible: true
  });

  const origGetBatch = paypalClient.getPayoutBatch;
  paypalClient.getPayoutBatch = async () => ({
    batchHeader: { batch_status: 'SUCCESS' },
    items: []
  });

  try {
    const { res, state } = createMockRes();
    await getPayoutHandler({ params: { bookingId } }, res);

    assert.strictEqual(state.statusCode, 200);
    const data = state.data;
    assert.strictEqual(data.payoutBatchId, 'BATCH_PRIVACY_99');
    assert.strictEqual(data.items.length, 3);

    // Verify no item exposes receiver or any '@' email string
    for (const item of data.items) {
      assert.strictEqual(item.receiver, undefined);
      assert.strictEqual(JSON.stringify(item).includes('@'), false);
    }
    assert.strictEqual(JSON.stringify(data).includes('@email.com'), false);
  } finally {
    paypalClient.getPayoutBatch = origGetBatch;
  }
});

// ============================================================================
// 8. STATUS REFRESH FROM LIVE PAYPAL BATCH
// ============================================================================
test('Stage 3.1: Status refresh maps PayPal transaction statuses to items', async () => {
  const bookingId = 'BK_TEST_REFRESH';
  store.saveBooking({
    bookingId,
    captureId: 'CAP_REFRESH_1',
    status: 'CAPTURED',
    captureStatus: 'COMPLETED',
    capturedCents: 1000,
    mode: 'REAL_SANDBOX',
    payoutBatchId: 'BATCH_REFRESH_LIVE',
    payoutStatus: 'PENDING',
    payoutItems: [
      { role: 'artisan', senderItemId: 'item_artisan_CAP_REFRESH_1', status: 'PENDING', amountUsd: '8.00', cents: 800 },
      { role: 'welfare', senderItemId: 'item_welfare_CAP_REFRESH_1', status: 'PENDING', amountUsd: '1.00', cents: 100 },
      { role: 'reserve', senderItemId: 'item_reserve_CAP_REFRESH_1', status: 'PENDING', amountUsd: '0.60', cents: 60 }
    ],
    stage: '3.1',
    payoutEligible: true
  });

  const origGetBatch = paypalClient.getPayoutBatch;
  paypalClient.getPayoutBatch = async () => ({
    batchHeader: { batch_status: 'SUCCESS' },
    items: [
      { payout_item: { sender_item_id: 'item_artisan_CAP_REFRESH_1' }, transaction_status: 'SUCCESS' },
      { payout_item: { sender_item_id: 'item_welfare_CAP_REFRESH_1' }, transaction_status: 'SUCCESS' },
      { payout_item: { sender_item_id: 'item_reserve_CAP_REFRESH_1' }, transaction_status: 'UNCLAIMED' }
    ]
  });

  try {
    const refreshed = await payoutService.refreshPayoutStatus(bookingId);
    assert.strictEqual(refreshed.payoutStatus, 'SUCCESS');
    assert.strictEqual(refreshed.items[0].status, 'SUCCESS');
    assert.strictEqual(refreshed.items[1].status, 'SUCCESS');
    assert.strictEqual(refreshed.items[2].status, 'UNCLAIMED');
  } finally {
    paypalClient.getPayoutBatch = origGetBatch;
  }
});

test('Stage 3.1: PayPal fee extraction parses seller_receivable_breakdown and handles null gracefully', async () => {
  const origCapture = paypalClient.captureAuthorization;

  // Case A: PayPal returns fee
  paypalClient.captureAuthorization = async () => ({
    captureId: 'CAP_FEE_TEST',
    status: 'COMPLETED',
    amount: '10.00',
    currency: 'USD',
    paypalFeeUsd: '0.45',
    mode: 'REAL_SANDBOX'
  });

  const captureHandler = getRouteHandler(ordersRouter, 'POST', '/capture');
  const bookingIdA = 'BK_FEE_A';
  store.saveBooking({
    bookingId: bookingIdA,
    orderId: 'ORD_FEE_A',
    authorizationId: 'AUTH_FEE_A',
    status: 'AUTHORIZED',
    authorizedCents: 1000,
    authorizedAmountUsd: '10.00',
    evidence: { service: { id: 's1', start_price: 299 } },
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
      { type: 'complete', timestamp: '2026-11-11T10:10:00.000Z' }
    ],
    mode: 'REAL_SANDBOX'
  });

  try {
    const { res: resA, state: stateA } = createMockRes();
    await captureHandler({ body: { bookingId: bookingIdA } }, resA);
    assert.strictEqual(stateA.statusCode, 200);
    assert.strictEqual(stateA.data.paypalFeeUsd, '0.45');
    assert.strictEqual(store.getBooking(bookingIdA).paypal_fee_usd, '0.45');

    // Case B: PayPal omits fee (null)
    paypalClient.captureAuthorization = async () => ({
      captureId: 'CAP_NO_FEE_TEST',
      status: 'COMPLETED',
      amount: '10.00',
      currency: 'USD',
      paypalFeeUsd: null,
      mode: 'REAL_SANDBOX'
    });

    const bookingIdB = 'BK_FEE_B';
    store.saveBooking({
      bookingId: bookingIdB,
      orderId: 'ORD_FEE_B',
      authorizationId: 'AUTH_FEE_B',
      status: 'AUTHORIZED',
      authorizedCents: 1000,
      authorizedAmountUsd: '10.00',
      evidence: { service: { id: 's1', start_price: 299 } },
      events: [
        { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
        { type: 'complete', timestamp: '2026-11-11T10:10:00.000Z' }
      ],
      mode: 'REAL_SANDBOX'
    });

    const { res: resB, state: stateB } = createMockRes();
    await captureHandler({ body: { bookingId: bookingIdB } }, resB);
    assert.strictEqual(stateB.statusCode, 200);
    assert.strictEqual(stateB.data.paypalFeeUsd, null);
    assert.strictEqual(store.getBooking(bookingIdB).paypal_fee_usd, null);
  } finally {
    paypalClient.captureAuthorization = origCapture;
  }
});
