/**
 * ============================================================================
 * UniServ Settlement API Routes (Phase 5.2 / Phase 6 Ledger Interface)
 * ============================================================================
 * Handles:
 *  - GET /api/settlement/:bookingId/trace: Read-only endpoint returning the
 *    stored trace and facts for the Phase 6 ledger.
 *  - Enforces strict privacy: NO receiver email addresses, NO secrets, NO raw prompts.
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const store = require('../store');

/**
 * GET /api/settlement/:bookingId/trace
 */
router.get('/:bookingId/trace', (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: `No booking record found for "${bookingId}"`
    });
  }

  // Construct structured facts table for Phase 6 ledger
  const facts = {
    bookingId: booking.bookingId,
    service: booking.evidence?.service
      ? {
          id: booking.evidence.service.id,
          name: booking.evidence.service.name,
          start_price: booking.evidence.service.start_price
        }
      : null,
    booking_type: booking.evidence?.booking_type || 'normal',
    authorizedCents: booking.authorizedCents ?? null,
    authorizedAmountUsd: booking.authorizedAmountUsd ?? null,
    capturedCents: booking.capturedCents ?? null,
    capturedAmountUsd: booking.capturedAmountUsd ?? null,
    finalBillRupees: booking.finalBillRupees || booking.totalRupees || null,
    finalBillPaise: booking.finalBillPaise || booking.estimatePaise || null,
    activeSeconds: booking.activeSeconds ?? null,
    paypalFeeUsd: booking.paypal_fee_usd || null,
    retainedCents: booking.payoutRetainedCents ?? null,
    retainedAmountUsd: booking.payoutRetainedAmountUsd || null,
    payoutStatus: booking.payoutStatus || null
  };

  // Ensure trace is sanitized: strip any potential personal emails
  let trace = booking.settlement_trace || null;
  if (trace) {
    const rawStr = JSON.stringify(trace);
    const cleanStr = rawStr.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
    trace = JSON.parse(cleanStr);
  }

  return res.status(200).json({
    success: true,
    bookingId: booking.bookingId,
    decision: booking.settlement_decision || (booking.status === 'CAPTURED' ? 'APPROVE' : (booking.status === 'HOLD_FOR_HUMAN' ? 'HOLD_FOR_HUMAN' : null)),
    mode: booking.settlement_mode || 'RULES_ONLY',
    facts,
    trace
  });
});

module.exports = router;
