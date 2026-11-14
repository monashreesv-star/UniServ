/**
 * ============================================================================
 * UniServ AI API Routes (Stage 4.1b)
 * ============================================================================
 * Handles:
 *  - POST /api/ai/triage: Multimodal AI Smart Triage for customer repair requests.
 *  - GET  /api/ai/health: Health & status check (safe, no secret exposure).
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const geminiClient = require('../services/geminiClient');
const store = require('../store');
const { runSettlementAgent, createRealPayPalExecutors } = require('../services/settlementAgent');
const payoutService = require('../services/payoutService');

// In-memory IP rate limiter: max 20 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
    rateLimitMap.set(ip, record);
    return { allowed: true };
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000)
    };
  }

  record.count++;
  rateLimitMap.set(ip, record);
  return { allowed: true };
}

// Maximum base64 string length corresponding to roughly 4 MB binary data
// 4 * 1024 * 1024 * 4 / 3 ≈ 5,592,405 characters
const MAX_BASE64_LENGTH = 5.5 * 1024 * 1024;

/**
 * POST /api/ai/triage
 */
router.post('/triage', async (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown-client';

  // 1. Rate limiting check
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many triage requests. Please wait a moment before trying again.',
      retryAfterSeconds: rateLimit.retryAfterSeconds
    });
  }

  const {
    text,
    description,
    image,
    image_base64,
    mime_type,
    mimeType,
    customer_language,
    language
  } = req.body || {};

  const inputText = typeof text === 'string' ? text : (typeof description === 'string' ? description : '');
  const inputImage = typeof image_base64 === 'string' ? image_base64 : (typeof image === 'string' ? image : null);
  const inputMime = typeof mime_type === 'string' ? mime_type : (typeof mimeType === 'string' ? mimeType : 'image/jpeg');
  const inputLanguage = typeof language === 'string' ? language : (typeof customer_language === 'string' ? customer_language : 'en');

  // 2. Validate non-empty payload
  if (!inputText.trim() && !inputImage) {
    return res.status(400).json({
      success: false,
      error: 'EMPTY_REQUEST',
      message: 'Please provide a problem description or photo for triage.'
    });
  }

  // 3. Validate image size limit (~4 MB)
  if (inputImage && inputImage.length > MAX_BASE64_LENGTH) {
    return res.status(400).json({
      success: false,
      error: 'IMAGE_TOO_LARGE',
      message: 'Image exceeds maximum allowable size of 4MB.'
    });
  }

  try {
    const result = await geminiClient.runTriage({
      text: inputText.trim(),
      imageBase64: inputImage,
      mimeType: inputMime,
      customerLanguage: inputLanguage
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('Triage internal error:', err?.message || err);
    // Graceful fallback on unexpected error
    const fallback = geminiClient.buildSimulatedTriage({
      text: inputText,
      customerLanguage: inputLanguage,
      reason: 'SERVER_EXCEPTION'
    });
    return res.status(200).json(fallback);
  }
});

/**
 * POST /api/ai/settlement/:bookingId
 * Autonomous AI Settlement Agent endpoint for PayPal bookings.
 * 
 * Rules:
 *  1. Only route used by the UI for PayPal settlement.
 *  2. Atomically sets settlementStatus = 'IN_PROGRESS' on booking to block concurrent runs.
 *  3. Idempotent: repeated calls return stored result or in-progress status.
 *  4. Payouts run strictly via agent's run_payouts tool.
 */
router.post('/settlement/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: `No booking record found for "${bookingId}"`
    });
  }

  // Idempotency: If already settled or decision exists, return stored result
  if (booking.settlementStatus === 'COMPLETED' || booking.settlement_decision) {
    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      settlementStatus: 'COMPLETED',
      decision: booking.settlement_decision,
      mode: booking.settlement_mode,
      trace: booking.settlement_trace,
      receipt: booking.settlement_receipt,
      holdReason: booking.holdReason,
      captureResult: booking.status === 'CAPTURED'
        ? { status: booking.status, capture_id: booking.captureId, captured_cents: booking.capturedCents }
        : null,
      payout: payoutService.sanitizePayoutRecord(booking),
      alreadySettled: true
    });
  }

  // Concurrency guard: If already IN_PROGRESS, return in-progress state (202)
  if (booking.settlementStatus === 'IN_PROGRESS') {
    return res.status(202).json({
      success: true,
      bookingId: booking.bookingId,
      settlementStatus: 'IN_PROGRESS',
      inProgress: true,
      message: 'Settlement agent is auditing the job'
    });
  }

  // Pre-condition: Booking must be in AUTHORIZED status
  if (booking.status !== 'AUTHORIZED') {
    if (booking.status === 'CAPTURED' || booking.status === 'HOLD_FOR_HUMAN') {
      return res.status(200).json({
        success: true,
        bookingId: booking.bookingId,
        status: booking.status,
        decision: booking.status === 'CAPTURED' ? 'APPROVE' : 'HOLD_FOR_HUMAN',
        holdReason: booking.holdReason,
        alreadyProcessed: true
      });
    }
    return res.status(400).json({
      success: false,
      error: 'INVALID_STATUS',
      message: `Cannot run settlement for booking in "${booking.status}" status. Required: "AUTHORIZED"`
    });
  }

  // Atomically claim in-progress state to prevent race conditions
  store.updateBooking(booking.bookingId, {
    settlementStatus: 'IN_PROGRESS',
    settlementStartedAt: new Date().toISOString()
  });

  // Use injected executors (for tests) or production PayPal executors
  const executors = req.app.locals.settlementExecutors || createRealPayPalExecutors({ store });
  const customerLang = req.body.customerLanguageCode || req.body.customer_language_code || 'en';

  try {
    const agentResult = await runSettlementAgent(booking, {
      executors,
      customerLanguageCode: customerLang,
      mode: req.body.mode
    });

    const updatePayload = {
      settlementStatus: 'COMPLETED',
      settlement_decision: agentResult.decision,
      settlement_mode: agentResult.mode,
      settlement_trace: agentResult.trace,
      settlement_receipt: agentResult.receipt,
      settlementCompletedAt: new Date().toISOString()
    };

    if (agentResult.decision === 'HOLD_FOR_HUMAN') {
      updatePayload.status = 'HOLD_FOR_HUMAN';
      updatePayload.holdReason = agentResult.holdReason || booking.holdReason || 'Held for cooperative review by settlement agent';
    }

    store.updateBooking(booking.bookingId, updatePayload);
    const updatedBooking = store.getBooking(booking.bookingId);

    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      settlementStatus: 'COMPLETED',
      decision: agentResult.decision,
      mode: agentResult.mode,
      trace: agentResult.trace,
      captureResult: agentResult.captureResult,
      payoutResult: agentResult.payoutResult,
      receipt: agentResult.receipt,
      holdReason: agentResult.holdReason,
      holdExplanation: agentResult.holdExplanation,
      payout: payoutService.sanitizePayoutRecord(updatedBooking)
    });
  } catch (err) {
    console.error(`Settlement agent exception for ${booking.bookingId}:`, err);
    store.updateBooking(booking.bookingId, {
      settlementStatus: 'COMPLETED',
      settlement_decision: 'HOLD_FOR_HUMAN',
      status: 'HOLD_FOR_HUMAN',
      holdReason: 'AGENT_EXCEPTION',
      settlementCompletedAt: new Date().toISOString()
    });

    return res.status(500).json({
      success: false,
      error: 'SETTLEMENT_ERROR',
      message: err.message || 'Settlement agent encountered an error'
    });
  }
});

/**
 * GET /api/ai/settlement/:bookingId
 * Polling and inspection endpoint for settlement status.
 */
router.get('/settlement/:bookingId', (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: `No booking record found for "${bookingId}"`
    });
  }

  return res.status(200).json({
    success: true,
    bookingId: booking.bookingId,
    status: booking.status,
    settlementStatus: booking.settlementStatus || (booking.status === 'CAPTURED' ? 'COMPLETED' : 'NOT_STARTED'),
    decision: booking.settlement_decision || (booking.status === 'CAPTURED' ? 'APPROVE' : (booking.status === 'HOLD_FOR_HUMAN' ? 'HOLD_FOR_HUMAN' : null)),
    mode: booking.settlement_mode || null,
    captureStatus: booking.captureStatus || null,
    capturedCents: booking.capturedCents || null,
    capturedAmountUsd: booking.capturedAmountUsd || null,
    holdReason: booking.holdReason || null,
    receipt: booking.settlement_receipt || null,
    trace: booking.settlement_trace || null,
    payout: payoutService.sanitizePayoutRecord(booking)
  });
});

/**
 * GET /api/ai/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    modelConfigured: !!process.env.GEMINI_MODEL,
    keyConfigured: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
