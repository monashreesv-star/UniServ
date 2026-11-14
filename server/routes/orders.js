/**
 * ============================================================================
 * UniServ Orders API Routes
 * ============================================================================
 * Handles:
 *  - POST /api/orders/create: Whitelist evidence check, server-side pricing,
 *    order creation (intent: AUTHORIZE), fresh bookingId generation.
 *  - POST /api/orders/authorize: Idempotent authorization, error mapping,
 *    updates store.
 *  - GET  /api/orders/:orderId: Minimal status and IDs response (no evidence/payer).
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const store = require('../store');
const { validateAndBuildEvidence, computeEstimateAndHold, ValidationError } = require('../services/settlementService');
const { deriveBillFromEvents } = require('../services/jobEventService');
const paypalClient = require('../services/paypalClient');
const payoutService = require('../services/payoutService');

/**
 * POST /api/orders/create
 */
router.post('/create', async (req, res) => {
  try {
    // 1. Whitelist validation & evidence construction (Server owns pricing)
    const clientEvidenceInput = req.body.bookingInput || req.body;
    const evidence = validateAndBuildEvidence(clientEvidenceInput);

    // 2. Compute bill, integer USD cents, and authorization ceiling hold
    const calculations = computeEstimateAndHold(evidence);

    // 3. Generate a fresh, unique bookingId for every create attempt
    // Ensures retrying after cancel never replays an old idempotency key
    const bookingId = `BK_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 4. Construct PayPal return & cancel URLs
    const clientReturnBase = (process.env.CLIENT_RETURN_URL || 'http://localhost:8081').replace(/\/+$/, '');
    const returnUrl = `${clientReturnBase}?paypal_return=true&booking_id=${bookingId}`;
    const cancelUrl = `${clientReturnBase}?paypal_cancel=true&booking_id=${bookingId}`;

    // 5. Create PayPal Sandbox order
    const orderResult = await paypalClient.createOrder({
      bookingId,
      authorizedCents: calculations.authorizedCents,
      returnUrl,
      cancelUrl,
      description: `UniServ Pre-Authorization: ${evidence.service.name}`
    });

    // 6. Save initial booking in atomic JSON store
    const payerInput = req.body.payer || {};
    const dispatchSummaryInput =
      typeof clientEvidenceInput.english_dispatch_summary === 'string'
        ? clientEvidenceInput.english_dispatch_summary.trim()
        : (typeof req.body.english_dispatch_summary === 'string' ? req.body.english_dispatch_summary.trim() : null);
    const aiTriageInput = req.body.ai_triage || clientEvidenceInput.ai_triage || null;

    const bookingRecord = {
      bookingId,
      orderId: orderResult.orderId,
      status: 'CREATED',
      mode: orderResult.mode,
      evidence,
      estimatePaise: calculations.totalPaise,
      totalRupees: calculations.totalRupees,
      estimateCents: calculations.estimateCents,
      authorizedCents: calculations.authorizedCents,
      estimateAmountUsd: calculations.estimateAmountUsd,
      authorizedAmountUsd: calculations.authorizedAmountUsd,
      authorizationId: null,
      authorizationStatus: null,
      english_dispatch_summary: dispatchSummaryInput ? dispatchSummaryInput.slice(0, 280) : null,
      ai_triage: aiTriageInput && typeof aiTriageInput === 'object' ? aiTriageInput : null,
      payer: {
        name: typeof payerInput.name === 'string' && payerInput.name.trim() ? payerInput.name.trim() : 'International Customer',
        country: typeof payerInput.country === 'string' && payerInput.country.trim() ? payerInput.country.trim() : 'United States'
      }
    };

    store.saveBooking(bookingRecord);

    return res.status(201).json({
      success: true,
      bookingId,
      orderId: orderResult.orderId,
      approvalUrl: orderResult.approvalUrl,
      mode: orderResult.mode,
      estimateAmountUsd: calculations.estimateAmountUsd,
      authorizedAmountUsd: calculations.authorizedAmountUsd,
      totalRupees: calculations.totalRupees,
      exchangeRateDisplay: calculations.exchangeRateDisplay
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: err.message
      });
    }

    const errorName = err.paypalError || err.name || 'ORDER_CREATION_FAILED';
    const debugId = err.debugId || 'none';
    console.error(`Order creation failed [${errorName}] (Debug ID: ${debugId})`);

    return res.status(500).json({
      success: false,
      error: errorName,
      debugId,
      message: 'Failed to create PayPal sandbox order'
    });
  }
});

/**
 * POST /api/orders/authorize
 */
router.post('/authorize', async (req, res) => {
  const { orderId, bookingId, payerId } = req.body;

  if (!orderId && !bookingId) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_PARAMS',
      message: 'Must provide orderId or bookingId'
    });
  }

  // 1. Locate booking in store
  const booking = (orderId ? store.getBookingByOrderId(orderId) : null) || (bookingId ? store.getBooking(bookingId) : null);
  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: 'No booking record found for the provided order/booking ID'
    });
  }

  // 2. Idempotency Check: if already authorized (e.g. page refresh), return immediately
  if (booking.status === 'AUTHORIZED' && booking.authorizationId) {
    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: booking.orderId,
      authorizationId: booking.authorizationId,
      status: 'AUTHORIZED',
      mode: booking.mode,
      alreadyAuthorized: true
    });
  }

  // 3. Perform authorization with PayPal
  try {
    const targetOrderId = booking.orderId || orderId;
    const authResult = await paypalClient.authorizeOrder(targetOrderId);

    // Update store
    store.updateBooking(booking.bookingId, {
      status: 'AUTHORIZED',
      authorizationId: authResult.authorizationId,
      authorizationStatus: authResult.status,
      mode: authResult.mode,
      payer: {
        ...booking.payer,
        payerId: payerId || null
      }
    });

    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: targetOrderId,
      authorizationId: authResult.authorizationId,
      status: 'AUTHORIZED',
      mode: authResult.mode
    });
  } catch (err) {
    const errorName = err.paypalError || err.name || 'AUTHORIZATION_FAILED';
    const debugId = err.debugId || 'none';

    // Store error on booking
    store.updateBooking(booking.bookingId, {
      status: 'FAILED',
      error: {
        errorName,
        debugId,
        occurredAt: new Date().toISOString()
      }
    });

    // Provide friendly error messages for known PayPal rejection reasons
    let userMessage = 'PayPal authorization could not be completed.';
    if (errorName === 'ORDER_NOT_APPROVED') {
      userMessage = 'The order was not approved in PayPal Sandbox.';
    } else if (errorName === 'INSTRUMENT_DECLINED') {
      userMessage = 'The payment instrument was declined in PayPal Sandbox.';
    }

    console.error(`Order authorization failed [${errorName}] (Debug ID: ${debugId})`);

    return res.status(400).json({
      success: false,
      error: errorName,
      debugId,
      message: userMessage
    });
  }
});

/**
 * POST /api/orders/capture
 * Performs guarded capture of authorized hold.
 * 
 * Rules:
 *  1. Requires booking.status === 'AUTHORIZED' (or returns existing capture/hold idempotently).
 *  2. Requires 'complete' event in booking.events.
 *  3. Calls the SAME deriveBillFromEvents() as bill-preview.
 *  4. Guard: if finalCents > authorizedCents, do NOT call PayPal capture.
 *     Sets status HOLD_FOR_HUMAN.
 *  5. Captures via PayPal with idempotency header capture_<authorizationId>.
 *  6. Honest capture status: COMPLETED -> CAPTURED, PENDING -> CAPTURE_PENDING.
 */
router.post('/capture', async (req, res) => {
  const { bookingId, authorizationId } = req.body;

  if (!bookingId && !authorizationId) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_PARAMS',
      message: 'Must provide bookingId or authorizationId'
    });
  }

  const booking = (bookingId ? store.getBooking(bookingId) : null) ||
                  (authorizationId ? store.getBookingByAuthorizationId(authorizationId) : null);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: 'No booking record found for the provided ID'
    });
  }

  // Idempotency: if already CAPTURED or CAPTURE_PENDING, return existing record
  if (booking.status === 'CAPTURED' || booking.status === 'CAPTURE_PENDING') {
    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: booking.orderId,
      authorizationId: booking.authorizationId,
      captureId: booking.captureId,
      capturedCents: booking.capturedCents,
      capturedAmountUsd: booking.capturedAmountUsd,
      status: booking.status,
      captureStatus: booking.captureStatus,
      mode: booking.mode,
      paypalFeeUsd: booking.paypal_fee_usd || null,
      payoutSkippedReason: booking.payoutSkippedReason || null,
      payout: payoutService.sanitizePayoutRecord(booking),
      alreadyCaptured: true
    });
  }

  // Idempotency: if already HOLD_FOR_HUMAN, return existing hold
  if (booking.status === 'HOLD_FOR_HUMAN') {
    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: booking.orderId,
      authorizationId: booking.authorizationId,
      status: 'HOLD_FOR_HUMAN',
      holdReason: booking.holdReason,
      mode: booking.mode,
      alreadyHeld: true,
      message: 'Held for cooperative review, nothing captured'
    });
  }

  // Amendment 1: Events and capture require booking.status === 'AUTHORIZED'
  if (booking.status !== 'AUTHORIZED') {
    return res.status(400).json({
      success: false,
      error: 'INVALID_STATUS',
      message: `Cannot capture booking with status "${booking.status}". Required: "AUTHORIZED"`
    });
  }

  // Require completion event
  const events = booking.events || [];
  const completeEvent = events.find((e) => e.type === 'complete');
  if (!completeEvent) {
    return res.status(400).json({
      success: false,
      error: 'JOB_NOT_COMPLETED',
      message: 'Cannot capture before completion OTP event is recorded'
    });
  }

  // Amendment 4: Call the SAME deriveBillFromEvents function
  const calculation = deriveBillFromEvents(booking, events);
  const { finalCents, finalAmountUsd, totalRupees, totalPaise, activeSeconds, bill } = calculation;

  // Guard check: final cents vs authorized ceiling
  if (finalCents > (booking.authorizedCents || 0)) {
    const holdReason = `Final bill ($${finalAmountUsd} USD / ₹${totalRupees}) exceeded authorized ceiling ($${booking.authorizedAmountUsd} USD)`;
    store.updateBooking(booking.bookingId, {
      status: 'HOLD_FOR_HUMAN',
      holdReason,
      finalBillPaise: totalPaise,
      finalBillRupees: totalRupees,
      finalCents,
      finalAmountUsd,
      heldAt: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: booking.orderId,
      authorizationId: booking.authorizationId,
      status: 'HOLD_FOR_HUMAN',
      holdReason,
      authorizedAmountUsd: booking.authorizedAmountUsd,
      finalAmountUsd,
      totalRupees,
      mode: booking.mode,
      message: 'Held for cooperative review, nothing captured'
    });
  }

  // Within ceiling: Proceed with PayPal capture
  try {
    const captureResult = await paypalClient.captureAuthorization({
      authorizationId: booking.authorizationId,
      amountUsd: finalAmountUsd
    });

    // Amendment 6 & 8: Honest capture status
    const isCompleted = captureResult.status === 'COMPLETED';
    const newStatus = isCompleted ? 'CAPTURED' : (captureResult.status === 'PENDING' ? 'CAPTURE_PENDING' : 'FAILED');

    store.updateBooking(booking.bookingId, {
      status: newStatus,
      captureId: captureResult.captureId,
      captureStatus: captureResult.status,
      capturedCents: finalCents,
      capturedAmountUsd: finalAmountUsd,
      paypal_fee_usd: captureResult.paypalFeeUsd || null,
      finalBillPaise: totalPaise,
      finalBillRupees: totalRupees,
      activeSeconds,
      stage: '3.1',
      payoutEligible: true,
      capturedAt: new Date().toISOString()
    });

    // Phase 3, Stage 3.1: Trigger Payouts for COMPLETED REAL_SANDBOX captures
    let payoutSummary = null;
    let payoutSkippedReason = null;

    if (req.body.isAgentSettlement || req.body.fromAgent || booking.settlementStatus === 'IN_PROGRESS') {
      // Stage 5.2: Payouts for agent-settled bookings run strictly via agent's run_payouts tool
      payoutSkippedReason = 'Agent settlement active: payouts deferred to run_payouts tool';
    } else if (!isCompleted) {
      payoutSkippedReason = `Capture status is ${captureResult.status || 'not COMPLETED'}`;
    } else if (captureResult.mode === 'SIMULATED') {
      payoutSkippedReason = 'Booking was processed in SIMULATED mode';
    } else {
      try {
        payoutSummary = await payoutService.executePayout(booking.bookingId);
        if (payoutSummary && (payoutSummary.refused || payoutSummary.error)) {
          payoutSkippedReason = payoutSummary.message || payoutSummary.error;
        }
      } catch (payoutErr) {
        console.error(`Automatic payout failed for booking ${booking.bookingId}:`, payoutErr.message || payoutErr);
        payoutSkippedReason = payoutErr.message || 'Payout service error';
      }
    }

    if (payoutSkippedReason) {
      store.updateBooking(booking.bookingId, { payoutSkippedReason });
    }

    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: booking.orderId,
      authorizationId: booking.authorizationId,
      captureId: captureResult.captureId,
      capturedCents: finalCents,
      capturedAmountUsd: finalAmountUsd,
      totalRupees,
      status: newStatus,
      captureStatus: captureResult.status,
      mode: captureResult.mode,
      paypalFeeUsd: captureResult.paypalFeeUsd || null,
      payoutSkippedReason: payoutSkippedReason || null,
      payout: payoutSummary
    });
  } catch (err) {
    const errorName = err.paypalError || err.name || 'CAPTURE_FAILED';
    const debugId = err.debugId || 'none';

    store.updateBooking(booking.bookingId, {
      status: 'FAILED',
      error: {
        errorName,
        debugId,
        occurredAt: new Date().toISOString(),
        action: 'capture'
      }
    });

    console.error(`Authorization capture failed [${errorName}] (Debug ID: ${debugId})`);

    return res.status(400).json({
      success: false,
      error: errorName,
      debugId,
      message: 'PayPal authorization capture failed'
    });
  }
});

/**
 * GET /api/orders/:orderId
 * Returns ONLY status and IDs (Amendment 9: no evidence, no payer name).
 */
router.get('/:orderId', (req, res) => {
  const { orderId } = req.params;
  const booking = store.getBookingByOrderId(orderId) || store.getBooking(orderId);

  if (!booking) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Order not found'
    });
  }

  return res.status(200).json({
    bookingId: booking.bookingId,
    orderId: booking.orderId,
    status: booking.status,
    authorizationId: booking.authorizationId || null,
    captureId: booking.captureId || null,
    mode: booking.mode
  });
});

module.exports = router;
