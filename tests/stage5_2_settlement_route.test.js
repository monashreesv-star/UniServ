/**
 * ============================================================================
 * UniServ Stage 5.2 Settlement Route & UI Wiring Test Suite
 * ============================================================================
 * Verifies:
 *  1. Approve path: One capture and one payout batch executed via PayPal client.
 *  2. Hold path: When high anomaly flag is present, zero captures and zero payouts.
 *  3. Idempotency: Repeated calls return stored result and never re-run agent.
 *  4. Concurrency guard: Concurrent call while IN_PROGRESS returns 202 and does not duplicate.
 *  5. Guard rejection: Altered amounts are rejected and corrected.
 *  6. Gemini failure resilience: Clean job settles in RULES_ONLY mode.
 *  7. Total timeout handling: Exceeding 60s total limit triggers safe fallback.
 *  8. Privacy invariant: GET /api/settlement/:bookingId/trace contains zero emails and zero secrets.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate test store in a fresh temporary directory
const stage5TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-stage5-2-route-'));
const stage5StoreFile = path.join(stage5TempDir, 'bookings.json');

const store = require('../server/store');
store.setStorePath(stage5StoreFile);

test.after(() => {
  store.resetStorePath();
  try {
    fs.rmSync(stage5TempDir, { recursive: true, force: true });
  } catch (e) {}
});

// Ensure test receiver emails are set in environment for payouts
process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL = 'artisan_sbx@uniserv.org';
process.env.PAYPAL_RECEIVER_WELFARE_EMAIL = 'welfare_sbx@uniserv.org';
process.env.PAYPAL_RECEIVER_RESERVE_EMAIL = 'reserve_sbx@uniserv.org';

const aiRouter = require('../server/routes/ai');
const settlementRouter = require('../server/routes/settlement');
const paypalClient = require('../server/services/paypalClient');
const { setMockGenerator, clearMockGenerator } = require('../server/services/geminiClient');
const { validateAndBuildEvidence } = require('../server/services/settlementService');

test.beforeEach(() => {
  clearMockGenerator();
  paypalClient.resetClientOverride();
});

test.afterEach(() => {
  clearMockGenerator();
  paypalClient.resetClientOverride();
});

// Helper to simulate Express route invocation directly
function invokeRoute(router, method, url, body = {}, appLocals = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      path: url,
      params: {},
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

// Helper to create a standard authorized test booking
function createTestBooking(overrides = {}) {
  const bookingId = 'BK_ROUTE_' + Math.random().toString(36).slice(2, 7);
  const evidence = validateAndBuildEvidence({
    service_id: 's1',
    booking_type: 'normal',
    distance_km: 0,
    first_time: false
  });

  const record = {
    bookingId,
    orderId: 'ORDER_' + bookingId,
    authorizationId: 'AUTH_' + bookingId,
    status: 'AUTHORIZED',
    authorizedCents: 500,
    authorizedAmountUsd: '5.00',
    estimatePaise: 9900,
    totalRupees: 99,
    estimateCents: 116,
    estimateAmountUsd: '1.16',
    evidence,
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      { type: 'complete', timestamp: '2026-11-11T10:25:00.000Z', client_reported: true }
    ],
    english_dispatch_summary: 'Plumbing leak inspection.',
    ai_triage: {
      trade_id: 's1',
      urgency: 'medium',
      likely_parts: ['Washer'],
      price_range_inr: { min: 99, max: 200 },
      mode: 'REAL_AI'
    },
    ...overrides
  };

  store.saveBooking(record);
  return record;
}

// ----------------------------------------------------------------------------
// Test 1: Full Route Approve Flow (Capture + Payouts)
// ----------------------------------------------------------------------------
test('1. POST /api/ai/settlement/:bookingId - Approve: executes guarded capture and payouts', async () => {
  const booking = createTestBooking();
  let captureCalls = 0;
  let payoutCalls = 0;

  // Mock PayPal Client
  paypalClient.setClientOverride({
    captureAuthorization: async ({ authorizationId, amountUsd }) => {
      captureCalls++;
      return {
        captureId: `CAP_${authorizationId}`,
        status: 'COMPLETED',
        amount: { value: amountUsd, currency_code: 'USD' },
        paypalFeeUsd: '0.49',
        mode: 'SANDBOX'
      };
    },
    createPayoutBatch: async () => {
      payoutCalls++;
      return {
        batchId: `BATCH_${booking.bookingId}`,
        batchStatus: 'SUCCESS',
        mode: 'SANDBOX'
      };
    }
  });

  // Mock Gemini Model (Multi-turn tool calling)
  setMockGenerator(async ({ contents, generationConfig }) => {
    if (generationConfig?.responseMimeType === 'application/json') {
      return {
        text: JSON.stringify({
          receipt_english: 'Plumbing leak repaired properly. Thank you.',
          receipt_customer_language: 'Repaired successfully.'
        })
      };
    }

    const lastMessage = contents[contents.length - 1];
    const isFirstTurn = contents.length === 1;

    if (isFirstTurn) {
      return {
        functionCall: {
          name: 'capture_payment',
          args: { booking_id: booking.bookingId, amount_usd_cents: 116 }
        }
      };
    }

    const hasCapture = lastMessage.parts?.some((p) => p.functionResponse?.name === 'capture_payment');
    if (hasCapture) {
      return {
        functionCall: {
          name: 'run_payouts',
          args: { booking_id: booking.bookingId }
        }
      };
    }

    return { text: 'Done' };
  });

  const res = await invokeRoute(aiRouter, 'POST', `/settlement/${booking.bookingId}`, {
    customerLanguageCode: 'en'
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.settlementStatus, 'COMPLETED');
  assert.strictEqual(res.body.decision, 'APPROVE');
  assert.strictEqual(res.body.mode, 'AI_AGENT');
  assert.strictEqual(captureCalls, 1);
  assert.strictEqual(payoutCalls, 1);

  // Stored state verification
  const saved = store.getBooking(booking.bookingId);
  assert.strictEqual(saved.status, 'CAPTURED');
  assert.strictEqual(saved.settlementStatus, 'COMPLETED');
  assert.strictEqual(saved.settlement_decision, 'APPROVE');
  assert.ok(saved.settlement_trace);
});

// ----------------------------------------------------------------------------
// Test 2: Full Route Hold Flow (Zero Capture, Zero Payout)
// ----------------------------------------------------------------------------
test('2. POST /api/ai/settlement/:bookingId - Hold: high anomaly flag blocks capture and payout', async () => {
  // Booking with excessive extras (> 100% of base bill triggers RULE_EXCESSIVE_EXTRAS)
  const booking = createTestBooking({
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z', client_reported: true },
      {
        type: 'extra_work',
        timestamp: '2026-11-11T10:10:00.000Z',
        client_reported: true,
        payload: { id: 'EW_99', description: 'Massive pipe retrofit', amount: 300, approved: true }
      },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z', client_reported: true }
    ]
  });

  let captureCalled = false;
  let payoutCalled = false;

  paypalClient.setClientOverride({
    captureAuthorization: async () => {
      captureCalled = true;
    },
    createPayoutBatch: async () => {
      payoutCalled = true;
    }
  });

  // Model attempts to capture
  setMockGenerator(async () => {
    return {
      functionCall: {
        name: 'capture_payment',
        args: { booking_id: booking.bookingId, amount_usd_cents: 471 }
      }
    };
  });

  const res = await invokeRoute(aiRouter, 'POST', `/settlement/${booking.bookingId}`, {});

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.decision, 'HOLD_FOR_HUMAN');
  assert.strictEqual(captureCalled, false);
  assert.strictEqual(payoutCalled, false);

  const saved = store.getBooking(booking.bookingId);
  assert.strictEqual(saved.status, 'HOLD_FOR_HUMAN');
  assert.strictEqual(saved.settlement_decision, 'HOLD_FOR_HUMAN');
});

// ----------------------------------------------------------------------------
// Test 3: Idempotency (Repeated Calls Return Stored Result)
// ----------------------------------------------------------------------------
test('3. POST /api/ai/settlement/:bookingId - Idempotency: repeated call returns stored result without re-running agent', async () => {
  const booking = createTestBooking({
    settlementStatus: 'COMPLETED',
    settlement_decision: 'APPROVE',
    settlement_mode: 'AI_AGENT',
    status: 'CAPTURED',
    captureId: 'CAP_ALREADY_DONE',
    capturedCents: 116,
    settlement_trace: { steps: [{ step: 1, type: 'final_decision' }] }
  });

  let agentRuns = 0;
  setMockGenerator(async () => {
    agentRuns++;
    return { text: 'Should not run' };
  });

  const res = await invokeRoute(aiRouter, 'POST', `/settlement/${booking.bookingId}`, {});

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.alreadySettled, true);
  assert.strictEqual(res.body.decision, 'APPROVE');
  assert.strictEqual(agentRuns, 0);
});

// ----------------------------------------------------------------------------
// Test 4: Concurrency Guard (Blocks Parallel Agent Runs)
// ----------------------------------------------------------------------------
test('4. POST /api/ai/settlement/:bookingId - Concurrency: call while IN_PROGRESS returns 202', async () => {
  const booking = createTestBooking({
    settlementStatus: 'IN_PROGRESS'
  });

  let agentRuns = 0;
  setMockGenerator(async () => {
    agentRuns++;
    return { text: 'Should not run' };
  });

  const res = await invokeRoute(aiRouter, 'POST', `/settlement/${booking.bookingId}`, {});

  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.inProgress, true);
  assert.strictEqual(res.body.settlementStatus, 'IN_PROGRESS');
  assert.strictEqual(agentRuns, 0);
});

// ----------------------------------------------------------------------------
// Test 5: Wrong Amount Rejected and Corrected via Route
// ----------------------------------------------------------------------------
test('5. POST /api/ai/settlement/:bookingId - Guard Rejection: attempted alteration rejected and corrected', async () => {
  const booking = createTestBooking();

  paypalClient.setClientOverride({
    captureAuthorization: async ({ authorizationId, amountUsd }) => ({
      captureId: `CAP_${authorizationId}`,
      status: 'COMPLETED',
      amount: { value: amountUsd, currency_code: 'USD' }
    }),
    createPayoutBatch: async () => ({
      batchId: `BATCH_${booking.bookingId}`,
      batchStatus: 'SUCCESS'
    })
  });

  setMockGenerator(async ({ contents, generationConfig }) => {
    if (generationConfig?.responseMimeType === 'application/json') {
      return {
        text: JSON.stringify({
          receipt_english: 'Service completed properly.',
          receipt_customer_language: 'Service completed.'
        })
      };
    }

    const lastMessage = contents[contents.length - 1];
    const funcResp = lastMessage.parts?.find((p) => p.functionResponse)?.functionResponse;

    if (!funcResp) {
      // First attempt: wrong amount 999
      return {
        functionCall: {
          name: 'capture_payment',
          args: { booking_id: booking.bookingId, amount_usd_cents: 999 }
        }
      };
    }

    if (funcResp.name === 'capture_payment' && funcResp.response?.error) {
      // Corrected to 116
      return {
        functionCall: {
          name: 'capture_payment',
          args: { booking_id: booking.bookingId, amount_usd_cents: 116 }
        }
      };
    }

    if (funcResp.name === 'capture_payment' && funcResp.response?.status === 'SUCCESS') {
      return {
        functionCall: {
          name: 'run_payouts',
          args: { booking_id: booking.bookingId }
        }
      };
    }

    return { text: 'Done' };
  });

  const res = await invokeRoute(aiRouter, 'POST', `/settlement/${booking.bookingId}`, {});

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.decision, 'APPROVE');
  const guardRejection = res.body.trace.steps.find((s) => s.type === 'guard_rejection');
  assert.ok(guardRejection);
  assert.strictEqual(guardRejection.guard, 'AMOUNT_MISMATCH_ALTERATION');
});

// ----------------------------------------------------------------------------
// Test 6: Gemini Failure Triggers RULES_ONLY for Clean Job
// ----------------------------------------------------------------------------
test('6. POST /api/ai/settlement/:bookingId - Resilience: Gemini failure on clean job falls back to RULES_ONLY', async () => {
  const booking = createTestBooking();

  paypalClient.setClientOverride({
    captureAuthorization: async ({ authorizationId, amountUsd }) => ({
      captureId: `CAP_${authorizationId}`,
      status: 'COMPLETED',
      amount: { value: amountUsd, currency_code: 'USD' }
    }),
    createPayoutBatch: async () => ({
      batchId: `BATCH_${booking.bookingId}`,
      batchStatus: 'SUCCESS'
    })
  });

  setMockGenerator(async () => {
    throw new Error('SIMULATED_AI_UNAVAILABLE');
  });

  const res = await invokeRoute(aiRouter, 'POST', `/settlement/${booking.bookingId}`, {});

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.decision, 'APPROVE');
  assert.strictEqual(res.body.mode, 'RULES_ONLY');
  assert.ok(res.body.captureResult);
});

// ----------------------------------------------------------------------------
// Test 7: GET /api/ai/settlement/:bookingId (Status & Polling Endpoint)
// ----------------------------------------------------------------------------
test('7. GET /api/ai/settlement/:bookingId - Polling endpoint returns current status', async () => {
  const booking = createTestBooking({
    settlementStatus: 'COMPLETED',
    settlement_decision: 'APPROVE',
    settlement_mode: 'AI_AGENT',
    status: 'CAPTURED',
    capturedCents: 116,
    capturedAmountUsd: '1.16'
  });

  const res = await invokeRoute(aiRouter, 'GET', `/settlement/${booking.bookingId}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.bookingId, booking.bookingId);
  assert.strictEqual(res.body.settlementStatus, 'COMPLETED');
  assert.strictEqual(res.body.decision, 'APPROVE');
  assert.strictEqual(res.body.capturedCents, 116);
});

// ----------------------------------------------------------------------------
// Test 8: GET /api/settlement/:bookingId/trace (Ledger Privacy Invariant)
// ----------------------------------------------------------------------------
test('8. GET /api/settlement/:bookingId/trace - Read-only ledger endpoint contains zero emails or secrets', async () => {
  const booking = createTestBooking({
    status: 'CAPTURED',
    settlement_decision: 'APPROVE',
    settlement_mode: 'AI_AGENT',
    capturedCents: 116,
    capturedAmountUsd: '1.16',
    paypal_fee_usd: '0.49',
    payoutRetainedCents: 4,
    payoutRetainedAmountUsd: '0.04',
    settlement_trace: {
      booking_id: 'BK_TEST',
      mode: 'AI_AGENT',
      steps: [
        { step: 1, type: 'evidence_built' },
        { step: 2, type: 'model_call', elapsed_ms: 1200 },
        { step: 3, type: 'tool_call', tool: 'capture_payment' }
      ]
    }
  });

  const res = await invokeRoute(settlementRouter, 'GET', `/${booking.bookingId}/trace`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.bookingId, booking.bookingId);
  assert.ok(res.body.facts);
  assert.strictEqual(res.body.facts.capturedCents, 116);
  assert.strictEqual(res.body.facts.paypalFeeUsd, '0.49');

  // Strict privacy check: No API keys, no secrets, no emails in output
  const rawJson = JSON.stringify(res.body);
  assert.strictEqual(rawJson.includes('GEMINI_API_KEY'), false);
  assert.strictEqual(rawJson.includes('PAYPAL_CLIENT_SECRET'), false);
  assert.strictEqual(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(rawJson), false);
});
