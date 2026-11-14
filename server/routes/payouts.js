/**
 * ============================================================================
 * UniServ PayPal Payouts API Routes
 * ============================================================================
 * Handles:
 *  - GET  /api/payouts/:bookingId       : Refreshes batch and item statuses from PayPal
 *  - POST /api/payouts/:bookingId/retry : Retries payout on FAILED or FAILED_UNKNOWN status
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const store = require('../store');
const payoutService = require('../services/payoutService');

/**
 * GET /api/payouts/:bookingId
 * Refreshes status from PayPal and returns roles, amounts in cents & USD,
 * statuses, batch ID, and retained cents. Never returns receiver emails.
 */
router.get('/:bookingId', async (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: `Booking "${bookingId}" not found`
    });
  }

  try {
    let payoutSummary;
    if (booking.payoutBatchId) {
      payoutSummary = await payoutService.refreshPayoutStatus(bookingId);
    } else {
      payoutSummary = payoutService.sanitizePayoutRecord(booking);
    }

    return res.status(200).json({
      success: true,
      ...payoutSummary
    });
  } catch (err) {
    console.error(`Error fetching payout status for ${bookingId}:`, err.message);
    return res.status(500).json({
      success: false,
      error: 'PAYOUT_STATUS_FAILED',
      message: 'Could not fetch payout status'
    });
  }
});

/**
 * POST /api/payouts/:bookingId/retry
 * Re-triggers payout creation. Allowed ONLY when payoutStatus is FAILED
 * or FAILED_UNKNOWN and no batch exists.
 */
router.post('/:bookingId/retry', async (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: `Booking "${bookingId}" not found`
    });
  }

  // Pre-Stage 3.1 check
  if (!booking.payoutEligible && booking.stage !== '3.1') {
    return res.status(400).json({
      success: false,
      error: 'PRE_STAGE_3_BOOKING',
      message: 'Cannot execute payout for bookings captured prior to Stage 3.1'
    });
  }

  // Retry guard: only permitted if FAILED or FAILED_UNKNOWN and no stored batch ID
  const isRetryable =
    (booking.payoutStatus === 'FAILED' || booking.payoutStatus === 'FAILED_UNKNOWN') &&
    !booking.payoutBatchId;

  if (!isRetryable) {
    return res.status(400).json({
      success: false,
      error: 'CANNOT_RETRY_PAYOUT',
      message: `Payout retry only allowed when payoutStatus is FAILED or FAILED_UNKNOWN and no batch exists (current: ${booking.payoutStatus})`
    });
  }

  try {
    const result = await payoutService.executePayout(bookingId);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error(`Retry payout failed for ${bookingId}:`, err.message);
    return res.status(500).json({
      success: false,
      error: 'RETRY_FAILED',
      message: err.message || 'Payout retry failed'
    });
  }
});

module.exports = router;
