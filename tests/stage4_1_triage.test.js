/**
 * ============================================================================
 * UniServ Stage 4.1 Tests: Multimodal AI Triage
 * ============================================================================
 * Verifies:
 *  1. Structured Output: geminiClient.runTriage parses schema-conformant JSON.
 *  2. Multimodal Support: inlineData image parts correctly formatted and handled.
 *  3. Simulated Fallback: Missing key/model or error produces clearly labelled
 *     SIMULATED response with "[SIMULATED]" dispatch summaries.
 *  4. Trade Whitelist Enforcement: Unknown trade IDs from model are normalized
 *     to valid trades from src/data/services.json.
 *  5. API Validation: Rejection of empty requests (400) and oversized images (400).
 *  6. Rate Limiting: Excess requests return 429 RATE_LIMIT_EXCEEDED.
 *  7. Pricing Isolation: AI price ranges never affect computeEstimateAndHold,
 *     authorization ceilings, or event-based capture billing.
 *  8. Booking Audit Storage: english_dispatch_summary and ai_triage are stored
 *     on the booking record for worker viewing without pricing impact.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolate test store in a fresh temporary directory
const stage4TempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-stage4-triage-'));
const stage4StoreFile = path.join(stage4TempDir, 'bookings.json');

const store = require('../server/store');
store.setStorePath(stage4StoreFile);

test.after(() => {
  store.resetStorePath();
  try {
    fs.rmSync(stage4TempDir, { recursive: true, force: true });
  } catch (e) {}
});

const geminiClient = require('../server/services/geminiClient');
const aiRouter = require('../server/routes/ai');
const ordersRouter = require('../server/routes/orders');
const { computeEstimateAndHold, validateAndBuildEvidence } = require('../server/services/settlementService');
const { deriveBillFromEvents } = require('../server/services/jobEventService');
const paypalClient = require('../server/services/paypalClient');

// Helper to simulate Express route invocation directly
function invokeRoute(router, method, url, body = {}, ip = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      path: url,
      body,
      ip,
      connection: { remoteAddress: ip },
      headers: {}
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
        resolve({ status: this.statusCode, body: data, headers: this._headers });
      },
      send(data) {
        resolve({ status: this.statusCode, body: data, headers: this._headers });
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

test('1. Structured Output: runTriage parses valid schema response from model', async () => {
  const allowedIds = geminiClient.loadAllowedTradeIds();
  assert.ok(allowedIds.includes('s1'), 'Allowed trades must include s1 (Plumber)');

  geminiClient.setMockGenerator(async ({ contents }) => {
    return {
      mode: 'REAL_AI',
      text: JSON.stringify({
        trade_id: 's1',
        urgency: 'high',
        likely_parts: ['PVC Elbow Joint', 'Rubber Washer'],
        price_range_inr: { min: 200, max: 450 },
        english_dispatch_summary: 'Burst kitchen pipe under sink requires urgent valve repair.',
        customer_language_summary: 'Burst kitchen pipe under sink requires urgent valve repair.',
        confidence: 0.95,
        safety_flag: { flag: true, reason: 'Isolate main water valve immediately.' }
      })
    };
  });

  const result = await geminiClient.runTriage({
    text: 'Kitchen tap is leaking and pipe is burst under the sink.'
  });

  geminiClient.clearMockGenerator();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.mode, 'REAL_AI');
  assert.strictEqual(result.trade_id, 's1');
  assert.strictEqual(result.urgency, 'high');
  assert.strictEqual(result.price_range_inr.min, 200);
  assert.strictEqual(result.price_range_inr.max, 450);
  assert.strictEqual(result.safety_flag.flag, true);
  assert.strictEqual(result.disclaimer, 'AI estimate, final bill from verified job events');
});

test('2. Multimodal Support: inlineData image correctly attached in model payload', async () => {
  let receivedParts = [];

  geminiClient.setMockGenerator(async ({ contents }) => {
    receivedParts = contents[0].parts;
    return {
      mode: 'REAL_AI',
      text: JSON.stringify({
        trade_id: 's2',
        urgency: 'emergency',
        likely_parts: ['32A MCB switch', 'Copper wiring'],
        price_range_inr: { min: 250, max: 600 },
        english_dispatch_summary: 'Sparking switchboard with burning smell requires electrician.',
        customer_language_summary: 'Sparking switchboard with burning smell requires electrician.',
        confidence: 0.98,
        safety_flag: { flag: true, reason: 'Turn off the main MCB breaker immediately.' }
      })
    };
  });

  const dummyImageB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const result = await geminiClient.runTriage({
    text: 'Switchboard is sparking',
    imageBase64: dummyImageB64,
    mimeType: 'image/png'
  });

  geminiClient.clearMockGenerator();

  assert.strictEqual(result.trade_id, 's2');
  assert.strictEqual(receivedParts.length, 2, 'Should receive text and image parts');
  assert.ok(receivedParts[1].inlineData, 'Second part must be inlineData');
  assert.strictEqual(receivedParts[1].inlineData.mimeType, 'image/png');
  assert.strictEqual(receivedParts[1].inlineData.data, dummyImageB64);
});

test('3. Simulated Fallback: Missing key or model produces clearly labelled SIMULATED response', async () => {
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;

  try {
    const result = await geminiClient.runTriage({
      text: 'Water pipe is leaking heavily in bathroom'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.mode, 'SIMULATED_AI');
    assert.strictEqual(result.simulated, true);
    assert.strictEqual(result.trade_id, 's1');
    assert.ok(
      result.english_dispatch_summary.startsWith('[SIMULATED]'),
      'Dispatch summary must be prefixed with [SIMULATED]'
    );
    assert.ok(
      result.customer_language_summary.startsWith('[SIMULATED]'),
      'Customer summary must be prefixed with [SIMULATED]'
    );
    assert.strictEqual(result.disclaimer, 'AI estimate, final bill from verified job events');
  } finally {
    if (oldKey) process.env.GEMINI_API_KEY = oldKey;
    if (oldModel) process.env.GEMINI_MODEL = oldModel;
  }
});

test('4. Trade Whitelist: Unknown trade IDs from model are normalized to allowed trades', async () => {
  geminiClient.setMockGenerator(async () => {
    return {
      mode: 'REAL_AI',
      text: JSON.stringify({
        trade_id: 'space_rocket_mechanic_99',
        urgency: 'low',
        likely_parts: ['Fuel injector'],
        price_range_inr: { min: 1000, max: 2000 },
        english_dispatch_summary: 'Rocket engine repair.',
        customer_language_summary: 'Rocket engine repair.',
        confidence: 0.5,
        safety_flag: { flag: false, reason: 'None' }
      })
    };
  });

  const result = await geminiClient.runTriage({ text: 'Spaceship maintenance' });
  geminiClient.clearMockGenerator();

  const allowedIds = geminiClient.loadAllowedTradeIds();
  assert.ok(
    allowedIds.includes(result.trade_id),
    `Normalized trade_id "${result.trade_id}" must belong to allowed trade IDs`
  );
});

test('5. API Validation: POST /api/ai/triage rejects empty requests and oversized images', async () => {
  // Empty request
  const emptyRes = await invokeRoute(aiRouter, 'POST', '/triage', { text: '', image_base64: '' });
  assert.strictEqual(emptyRes.status, 400);
  assert.strictEqual(emptyRes.body.error, 'EMPTY_REQUEST');

  // Oversized image (> 5.5MB base64)
  const hugeImage = 'A'.repeat(6 * 1024 * 1024);
  const largeRes = await invokeRoute(aiRouter, 'POST', '/triage', {
    text: 'Check this large photo',
    image_base64: hugeImage
  });
  assert.strictEqual(largeRes.status, 400);
  assert.strictEqual(largeRes.body.error, 'IMAGE_TOO_LARGE');
});

test('6. Rate Limiting: Excessive requests per IP return 429 RATE_LIMIT_EXCEEDED', async () => {
  geminiClient.setMockGenerator(async () => ({
    mode: 'REAL_AI',
    text: JSON.stringify({
      trade_id: 's1',
      urgency: 'low',
      likely_parts: [],
      price_range_inr: { min: 100, max: 200 },
      english_dispatch_summary: 'Test',
      customer_language_summary: 'Test',
      confidence: 1.0,
      safety_flag: { flag: false, reason: '' }
    })
  }));

  const testIp = '198.51.100.42';
  let got429 = false;

  for (let i = 0; i < 25; i++) {
    const res = await invokeRoute(aiRouter, 'POST', '/triage', { text: `Request ${i}` }, testIp);
    if (res.status === 429) {
      got429 = true;
      assert.strictEqual(res.body.error, 'RATE_LIMIT_EXCEEDED');
      break;
    }
  }

  geminiClient.clearMockGenerator();
  assert.strictEqual(got429, true, 'Must return 429 after exceeding max rate limit per window');
});

test('7. Pricing Isolation: AI estimate prices NEVER feed computeEstimateAndHold or computeBill', async () => {
  // 1. Service evidence from Plumber (s1 start price: ₹99 = 9900 paise)
  const evidence = validateAndBuildEvidence({
    service_id: 's1',
    booking_type: 'normal',
    distance_km: 0,
    first_time: false
  });

  // Attach hypothetical giant AI triage numbers
  const aiTriageData = {
    trade_id: 's1',
    urgency: 'emergency',
    price_range_inr: { min: 25000, max: 75000 },
    english_dispatch_summary: 'Huge emergency leak',
    mode: 'REAL_AI'
  };

  const calculations = computeEstimateAndHold(evidence);

  // Plumber base price is 99 INR ($1.18 USD, ceil hold $1.50 = 150 cents)
  assert.strictEqual(calculations.totalRupees, 99, 'Server estimate must be ₹99 regardless of AI estimate');
  assert.ok(calculations.authorizedCents < 500, 'Authorized hold must be ~$1.50, not $500+');

  // 2. Final settlement deriveBillFromEvents must strictly use server-stamped events
  const mockBooking = {
    bookingId: 'BK_TEST_ISOLATION_99',
    evidence,
    events: [
      { type: 'start', timestamp: '2026-11-11T10:00:00.000Z' },
      { type: 'complete', timestamp: '2026-11-11T10:30:00.000Z' } // 30 mins (no overtime)
    ],
    ai_triage: aiTriageData
  };

  const finalBill = deriveBillFromEvents(mockBooking);
  assert.strictEqual(finalBill.totalRupees, 99, 'Final bill must equal base ₹99, unaffected by AI triage');
  assert.strictEqual(finalBill.finalCents, calculations.estimateCents, 'Captured cents match server estimate');
});

test('8. Audit Storage: POST /api/orders/create stores dispatch summary and triage metadata without pricing impact', async () => {
  // Stub paypalClient.createOrder
  const origCreateOrder = paypalClient.createOrder;
  paypalClient.createOrder = async ({ bookingId, authorizedCents }) => ({
    orderId: `ORDER_TRIAGE_${Date.now()}`,
    approvalUrl: 'https://sandbox.paypal.com/checkout?token=TEST_TRIAGE',
    mode: 'REAL_SANDBOX'
  });

  try {
    const res = await invokeRoute(ordersRouter, 'POST', '/create', {
      bookingInput: {
        service_id: 's1',
        booking_type: 'normal',
        distance_km: 0,
        first_time: false,
        english_dispatch_summary: 'Water pipe leaking under kitchen sink; artisan needs pipe cutter.',
        ai_triage: {
          trade_id: 's1',
          urgency: 'medium',
          price_range_inr: { min: 150, max: 350 },
          mode: 'REAL_AI'
        }
      },
      payer: {
        name: 'Alex Morgan',
        country: 'United States'
      }
    });

    assert.strictEqual(res.status, 201);
    const bookingId = res.body.bookingId;
    assert.ok(bookingId);

    const saved = store.getBooking(bookingId);
    assert.ok(saved);
    assert.strictEqual(
      saved.english_dispatch_summary,
      'Water pipe leaking under kitchen sink; artisan needs pipe cutter.'
    );
    assert.strictEqual(saved.ai_triage.trade_id, 's1');
    assert.strictEqual(saved.ai_triage.mode, 'REAL_AI');

    // Pricing integrity check: Plumber base ₹99
    assert.strictEqual(saved.totalRupees, 99);
  } finally {
    paypalClient.createOrder = origCreateOrder;
  }
});
