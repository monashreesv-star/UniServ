/**
 * ============================================================================
 * UniServ PayPal Payouts Service
 * ============================================================================
 * Handles automatic split payouts for captured PayPal Sandbox bookings.
 * 
 * SPLIT QUOTAS (from shared settlementEngine.splitCents):
 *  - 80% Artisan (to PAYPAL_RECEIVER_ARTISAN_EMAIL)
 *  - 10% Cooperative Welfare Fund (to PAYPAL_RECEIVER_WELFARE_EMAIL)
 *  -  6% Emergency Reserve Fund (to PAYPAL_RECEIVER_RESERVE_EMAIL)
 *  -  4% Platform Retained (retained in business balance, not an item)
 *
 * SAFETY INVARIANTS:
 *  - Payout runs strictly AFTER capture is stored with status COMPLETED.
 *  - Payout failures NEVER undo, alter or revert the capture record.
 *  - Never payouts for CAPTURE_PENDING, HOLD_FOR_HUMAN, or SIMULATED bookings.
 *  - Never payouts for bookings captured prior to Stage 3.1.
 *  - Atomically marks IN_PROGRESS before calling PayPal to block race conditions.
 *  - Reusable deterministic sender_batch_id: payout_<captureId>.
 *  - Invariant assertion: items sum + platform retained === capturedCents.
 * ============================================================================
 */

const assert = require('assert');
const store = require('../store');
const { splitCents } = require('../../src/utils/settlementEngine');
const paypalClient = require('./paypalClient');
const { validateReceiverEmails } = require('./receiverValidation');

/**
 * Sanitizes booking payout data for external/API return.
 * CRITICAL: Strips receiver email addresses from all items.
 *
 * @param {object} booking
 * @returns {object} Sanitized payout summary
 */
function sanitizePayoutRecord(booking) {
  if (!booking) return null;

  const items = (booking.payoutItems || []).map((it) => ({
    role: it.role,
    cents: it.cents,
    amountUsd: it.amountUsd,
    status: it.status,
    note: it.note
  }));

  return {
    success: booking.payoutStatus !== 'FAILED' && booking.payoutStatus !== 'FAILED_UNKNOWN',
    bookingId: booking.bookingId,
    captureId: booking.captureId,
    payoutBatchId: booking.payoutBatchId || null,
    payoutStatus: booking.payoutStatus || null,
    payoutSkippedReason: booking.payoutSkippedReason || null,
    retainedCents: booking.payoutRetainedCents ?? 0,
    retainedAmountUsd: booking.payoutRetainedAmountUsd || '0.00',
    paypalFeeUsd: booking.paypal_fee_usd || null,
    items,
    error: booking.payoutError || null
  };
}

/**
 * Executes or resumes a payout for an authorized and captured booking.
 *
 * @param {string} bookingId
 * @returns {Promise<object>}
 */
async function executePayout(bookingId) {
  const booking = store.getBooking(bookingId);
  if (!booking) {
    throw new Error(`Booking "${bookingId}" not found`);
  }

  // 1. Idempotency: If already has a payoutBatchId, return it directly
  if (booking.payoutBatchId) {
    return sanitizePayoutRecord(booking);
  }

  // 2. Concurrency guard: If already IN_PROGRESS, return in-progress state
  if (booking.payoutStatus === 'IN_PROGRESS') {
    return {
      success: true,
      inProgress: true,
      payoutStatus: 'IN_PROGRESS',
      message: 'Payout batch creation is already in progress'
    };
  }

  // 3. Status checks: Must be CAPTURED with COMPLETED status
  if (booking.status !== 'CAPTURED' || booking.captureStatus !== 'COMPLETED') {
    const message = `Cannot execute payout for booking with status "${booking.status}" (captureStatus: "${booking.captureStatus}")`;
    store.updateBooking(bookingId, { payoutSkippedReason: message });
    return {
      success: false,
      refused: true,
      error: 'INVALID_STATUS',
      message
    };
  }

  // 4. Never run payouts for SIMULATED bookings
  if (booking.mode === 'SIMULATED') {
    const message = 'Payouts are not run for SIMULATED bookings';
    store.updateBooking(bookingId, { payoutSkippedReason: message });
    return {
      success: false,
      refused: true,
      error: 'SIMULATED_MODE',
      message
    };
  }

  // 5. Stage 3.1 eligibility check: Do not run payouts for bookings captured prior to Stage 3.1
  if (!booking.payoutEligible && booking.stage !== '3.1') {
    const message = 'Cannot execute payout for bookings captured prior to Stage 3.1';
    store.updateBooking(bookingId, { payoutSkippedReason: message });
    return {
      success: false,
      refused: true,
      error: 'PRE_STAGE_3_BOOKING',
      message
    };
  }

  // 6. Validate receiver emails environment variables (names only)
  const validation = validateReceiverEmails();
  if (!validation.valid) {
    const errorMsg = validation.errors.join('; ');
    store.updateBooking(bookingId, {
      payoutStatus: 'FAILED',
      payoutError: {
        errorName: 'INVALID_RECEIVER_CONFIG',
        debugId: 'none',
        message: errorMsg
      }
    });
    return {
      success: false,
      error: 'INVALID_RECEIVER_CONFIG',
      message: errorMsg
    };
  }

  const capturedCents = Number(booking.capturedCents || 0);
  if (capturedCents <= 0) {
    return {
      success: false,
      refused: true,
      error: 'ZERO_CAPTURED_CENTS',
      message: 'Cannot payout 0 cents'
    };
  }

  // 7. Calculate shares from captured cents using pure settlement engine
  const { artisan, welfare, reserve, platform } = splitCents(capturedCents);

  const captureId = booking.captureId || booking.bookingId;
  const senderBatchId = `payout_${captureId}`;

  // Build items, skipping any item whose amount is 0 cents
  const payoutItems = [];
  if (artisan > 0) {
    payoutItems.push({
      role: 'artisan',
      receiver: process.env.PAYPAL_RECEIVER_ARTISAN_EMAIL.trim(),
      cents: artisan,
      amountUsd: (artisan / 100).toFixed(2),
      note: 'UniServ Artisan Fair-Wage (80%)',
      senderItemId: `item_artisan_${captureId}`
    });
  }
  if (welfare > 0) {
    payoutItems.push({
      role: 'welfare',
      receiver: process.env.PAYPAL_RECEIVER_WELFARE_EMAIL.trim(),
      cents: welfare,
      amountUsd: (welfare / 100).toFixed(2),
      note: 'Cooperative Welfare Fund (10%)',
      senderItemId: `item_welfare_${captureId}`
    });
  }
  if (reserve > 0) {
    payoutItems.push({
      role: 'reserve',
      receiver: process.env.PAYPAL_RECEIVER_RESERVE_EMAIL.trim(),
      cents: reserve,
      amountUsd: (reserve / 100).toFixed(2),
      note: 'Emergency Reserve Fund (6%)',
      senderItemId: `item_reserve_${captureId}`
    });
  }

  // Strict Invariant Assertion: Item amounts + Platform Retained === capturedCents
  const sumItems = payoutItems.reduce((acc, it) => acc + it.cents, 0);
  assert.strictEqual(
    sumItems + platform,
    capturedCents,
    `Integrity invariant failed: sum of payout items (${sumItems}) + platform (${platform}) !== capturedCents (${capturedCents})`
  );

  // 8. Atomically set payoutStatus = IN_PROGRESS before calling PayPal
  store.updateBooking(bookingId, {
    payoutStatus: 'IN_PROGRESS',
    payoutSenderBatchId: senderBatchId,
    payoutRetainedCents: platform,
    payoutRetainedAmountUsd: (platform / 100).toFixed(2),
    payoutStartedAt: new Date().toISOString()
  });

  // 9. Call PayPal Payouts API
  try {
    const result = await paypalClient.createPayoutBatch({
      senderBatchId,
      items: payoutItems,
      emailSubject: 'UniServ Cooperative Settlement Distribution',
      emailMessage: 'You have received your cooperative settlement earnings from UniServ.'
    });

    const updated = store.updateBooking(bookingId, {
      payoutBatchId: result.payoutBatchId,
      payoutStatus: result.batchStatus || 'PENDING',
      payoutRetainedCents: platform,
      payoutRetainedAmountUsd: (platform / 100).toFixed(2),
      payoutItems: payoutItems.map((it) => ({
        role: it.role,
        receiver: it.receiver, // internal store keeps receiver; routes strip it
        cents: it.cents,
        amountUsd: it.amountUsd,
        status: result.batchStatus === 'SUCCESS' ? 'SUCCESS' : 'PENDING',
        senderItemId: it.senderItemId,
        note: it.note
      })),
      payoutError: null,
      payoutCompletedAt: new Date().toISOString()
    });

    return sanitizePayoutRecord(updated);
  } catch (err) {
    const isTimeoutOrUnknown = Boolean(err.isTimeout || err.name === 'AbortError' || err.isUnknown);
    const finalStatus = isTimeoutOrUnknown ? 'FAILED_UNKNOWN' : 'FAILED';
    const errorName = err.paypalError || err.name || 'PAYOUT_FAILED';
    const debugId = err.debugId || 'none';

    console.error(`PayPal payout batch creation failed [${finalStatus}]: ${errorName} (Debug ID: ${debugId})`);

    const updated = store.updateBooking(bookingId, {
      payoutBatchId: null,
      payoutStatus: finalStatus,
      payoutRetainedCents: platform,
      payoutRetainedAmountUsd: (platform / 100).toFixed(2),
      payoutItems: payoutItems.map((it) => ({
        role: it.role,
        receiver: it.receiver,
        cents: it.cents,
        amountUsd: it.amountUsd,
        status: finalStatus,
        senderItemId: it.senderItemId,
        note: it.note
      })),
      payoutError: {
        errorName,
        debugId,
        message: err.message || 'PayPal payout creation failed'
      },
      payoutFailedAt: new Date().toISOString()
    });

    return sanitizePayoutRecord(updated);
  }
}

/**
 * Refreshes payout batch status from PayPal.
 *
 * @param {string} bookingId
 * @returns {Promise<object>} Updated sanitized payout record
 */
async function refreshPayoutStatus(bookingId) {
  const booking = store.getBooking(bookingId);
  if (!booking) {
    throw new Error(`Booking "${bookingId}" not found`);
  }

  if (!booking.payoutBatchId) {
    return sanitizePayoutRecord(booking);
  }

  try {
    const details = await paypalClient.getPayoutBatch(booking.payoutBatchId);
    const batchHeader = details.batchHeader || {};
    const batchItems = details.items || [];

    // Map item statuses by sender_item_id
    const statusBySenderId = {};
    for (const bIt of batchItems) {
      const senderId = bIt.payout_item?.sender_item_id;
      if (senderId) {
        statusBySenderId[senderId] = bIt.transaction_status || 'PENDING';
      }
    }

    const updatedItems = (booking.payoutItems || []).map((it) => {
      const liveStatus = statusBySenderId[it.senderItemId];
      return {
        ...it,
        status: liveStatus || it.status || batchHeader.batch_status || 'PENDING'
      };
    });

    const updatedBooking = store.updateBooking(bookingId, {
      payoutStatus: batchHeader.batch_status || booking.payoutStatus,
      payoutItems: updatedItems,
      payoutRefreshedAt: new Date().toISOString()
    });

    return sanitizePayoutRecord(updatedBooking);
  } catch (err) {
    console.warn(`Failed to refresh payout status for booking ${bookingId}:`, err.message);
    return sanitizePayoutRecord(booking);
  }
}

module.exports = {
  executePayout,
  refreshPayoutStatus,
  sanitizePayoutRecord
};
