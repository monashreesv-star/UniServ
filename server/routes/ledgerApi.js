/**
 * ============================================================================
 * UniServ Co-op Treasury Ledger API (Phase 6.1)
 * ============================================================================
 * Read-only interface for transparent cooperative financial auditing,
 * artisan wage tracking, and welfare allocations.
 *
 * STRICT INVARIANTS:
 *  1. Read-only: Never writes to store, never calls PayPal or Gemini APIs.
 *  2. Real store data only: Sanitizes and exposes actual bookings from store.
 *  3. Privacy:
 *     - Booking ID: last 8 characters only.
 *     - PayPal IDs (Order, Authorization, Capture, Payout Batch): last 4 characters only.
 *     - Payer: "Buyer abroad (<country>)" only. No personal names, emails, phones, or payer IDs.
 *     - Receivers: Zero receiver emails exported anywhere.
 *     - Secrets: Zero API keys, secrets, or raw prompts.
 *  4. Honest Accounting:
 *     - Decision values: SETTLED (only when PayPal capture status is COMPLETED),
 *       HELD (HOLD_FOR_HUMAN), PENDING (CAPTURE_PENDING or IN_PROGRESS),
 *       FAILED, or "n/a" for older bookings. No APPROVE or SIMULATED_APPROVE labels.
 *     - Modes: data_mode (REAL_SANDBOX, SIMULATED, n/a) and agent_mode (AI_AGENT, REDUCED_AGENT, RULES_ONLY, n/a).
 *     - Payout amounts: derived strictly from stored payoutItems with status === 'SUCCESS'.
 *     - Integer math: all totals calculated in integer cents to ensure exact sum consistency.
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const store = require('../store');
const { deriveBillFromEvents } = require('../services/jobEventService');

/**
 * Derives the honest settlement decision label.
 * Strictly: SETTLED, HELD, PENDING, FAILED, or 'n/a'.
 * @param {object} booking
 * @returns {string}
 */
function deriveDecision(booking) {
  if (booking.captureStatus === 'COMPLETED') {
    return 'SETTLED';
  }
  if (booking.status === 'HOLD_FOR_HUMAN' || booking.settlement_decision === 'HOLD_FOR_HUMAN') {
    return 'HELD';
  }
  if (
    booking.settlementStatus === 'IN_PROGRESS' ||
    booking.status === 'CAPTURE_PENDING' ||
    booking.captureStatus === 'PENDING'
  ) {
    return 'PENDING';
  }
  if (booking.status === 'FAILED' || booking.captureStatus === 'FAILED') {
    return 'FAILED';
  }
  return 'n/a';
}

/**
 * Derives the data mode: REAL_SANDBOX, SIMULATED, or 'n/a'.
 * @param {object} booking
 * @returns {string}
 */
function deriveDataMode(booking) {
  if (booking.mode === 'REAL_SANDBOX') return 'REAL_SANDBOX';
  if (booking.mode === 'SIMULATED') return 'SIMULATED';
  return 'n/a';
}

/**
 * Derives the agent mode: AI_AGENT, REDUCED_AGENT, RULES_ONLY, or 'n/a'.
 * @param {object} booking
 * @returns {string}
 */
function deriveAgentMode(booking) {
  const mode = booking.settlement_mode || booking.settlementMode || booking.agent_mode;
  if (mode === 'AI_AGENT') return 'AI_AGENT';
  if (mode === 'REDUCED_AGENT') return 'REDUCED_AGENT';
  if (mode === 'RULES_ONLY') return 'RULES_ONLY';
  return 'n/a';
}

/**
 * Extracts and calculates payout amounts from stored payoutItems.
 * Payout amounts come strictly from stored payoutItems (actual amounts and PayPal statuses per role),
 * never recomputed from percentages. Held bookings and failed or unknown payouts show 0.00 paid.
 * @param {object} booking
 * @returns {object}
 */
function extractRowPayouts(booking) {
  const isHeld = (booking.status === 'HOLD_FOR_HUMAN' || booking.settlement_decision === 'HOLD_FOR_HUMAN');
  const items = Array.isArray(booking.payoutItems) ? booking.payoutItems : [];

  let artisanPaidCents = 0;
  let welfarePaidCents = 0;
  let reservePaidCents = 0;

  let artisanStatus = 'n/a';
  let welfareStatus = 'n/a';
  let reserveStatus = 'n/a';

  if (!isHeld) {
    for (const item of items) {
      if (item.role === 'artisan') {
        artisanStatus = item.status || 'n/a';
        if (item.status === 'SUCCESS') {
          artisanPaidCents = Number.isInteger(item.cents)
            ? item.cents
            : Math.round(parseFloat(item.amountUsd || '0') * 100);
        }
      } else if (item.role === 'welfare') {
        welfareStatus = item.status || 'n/a';
        if (item.status === 'SUCCESS') {
          welfarePaidCents = Number.isInteger(item.cents)
            ? item.cents
            : Math.round(parseFloat(item.amountUsd || '0') * 100);
        }
      } else if (item.role === 'reserve') {
        reserveStatus = item.status || 'n/a';
        if (item.status === 'SUCCESS') {
          reservePaidCents = Number.isInteger(item.cents)
            ? item.cents
            : Math.round(parseFloat(item.amountUsd || '0') * 100);
        }
      }
    }
  }

  // Platform retained before PayPal fees
  let platformRetainedCents = 0;
  if (!isHeld && booking.captureStatus === 'COMPLETED') {
    if (Number.isInteger(booking.payoutRetainedCents)) {
      platformRetainedCents = booking.payoutRetainedCents;
    } else if (booking.payoutRetainedAmountUsd) {
      platformRetainedCents = Math.round(parseFloat(booking.payoutRetainedAmountUsd) * 100);
    } else if (Number.isInteger(booking.capturedCents)) {
      const totalPayoutCents = artisanPaidCents + welfarePaidCents + reservePaidCents;
      platformRetainedCents = Math.max(0, booking.capturedCents - totalPayoutCents);
    }
  }

  return {
    artisanPaidCents,
    welfarePaidCents,
    reservePaidCents,
    platformRetainedCents,
    artisanStatus,
    welfareStatus,
    reserveStatus,
    artisanPaidUsd: (artisanPaidCents / 100).toFixed(2),
    welfarePaidUsd: (welfarePaidCents / 100).toFixed(2),
    reservePaidUsd: (reservePaidCents / 100).toFixed(2),
    platformRetainedUsd: (platformRetainedCents / 100).toFixed(2)
  };
}

/**
 * Extracts policy flag IDs that fired on this booking.
 * @param {object} booking
 * @returns {string[]|string} Array of flag IDs or 'n/a'
 */
function extractPolicyFlags(booking) {
  // Check if flags are stored directly
  if (Array.isArray(booking.policy_flags)) {
    return booking.policy_flags.map((f) => (typeof f === 'string' ? f : f.id));
  }
  if (booking.settlement?.flags && Array.isArray(booking.settlement.flags)) {
    return booking.settlement.flags.map((f) => (typeof f === 'string' ? f : f.id));
  }
  // Check stored settlement trace
  if (Array.isArray(booking.settlement_trace)) {
    const policyStep = booking.settlement_trace.find((s) => s.type === 'policy_evaluated');
    if (policyStep) {
      const high = Array.isArray(policyStep.high_flags) ? policyStep.high_flags : [];
      const low = Array.isArray(policyStep.low_flags) ? policyStep.low_flags : [];
      return [...high, ...low];
    }
  }
  // If post-Phase 5 settlement booking but no flags fired, return []
  if (booking.settlementStatus || booking.settlement_decision || booking.status === 'HOLD_FOR_HUMAN') {
    return [];
  }
  // Older booking from before anomaly rules
  return 'n/a';
}

/**
 * Sanitizes the settlement trace for privacy:
 * - Truncates bookingId to last 8 characters
 * - Truncates PayPal IDs to last 4 characters
 * - Strips any email addresses or sensitive keys
 * @param {Array} trace
 * @returns {Array}
 */
function sanitizeTrace(trace) {
  if (!Array.isArray(trace)) return [];

  return trace.map((step) => {
    const clean = JSON.parse(JSON.stringify(step));

    if (clean.booking_id && typeof clean.booking_id === 'string') {
      clean.booking_id = clean.booking_id.slice(-8);
    }
    if (clean.order_id && typeof clean.order_id === 'string') {
      clean.order_id = clean.order_id.slice(-4);
    }
    if (clean.capture_id && typeof clean.capture_id === 'string') {
      clean.capture_id = clean.capture_id.slice(-4);
    }
    if (clean.batch_id && typeof clean.batch_id === 'string') {
      clean.batch_id = clean.batch_id.slice(-4);
    }
    if (clean.payout_batch_id && typeof clean.payout_batch_id === 'string') {
      clean.payout_batch_id = clean.payout_batch_id.slice(-4);
    }

    // Global scrub on any residual strings
    const jsonStr = JSON.stringify(clean)
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .replace(/\b[A-Z0-9]{17}\b/g, (m) => m.slice(-4))
      .replace(/\bBK_[A-Za-z0-9_]{6,}\b/gi, (m) => m.slice(-8));

    return JSON.parse(jsonStr);
  });
}

/**
 * Sanitizes a single booking record for the ledger records endpoint.
 * @param {object} booking
 * @returns {object}
 */
function sanitizeRecord(booking) {
  const rowPayouts = extractRowPayouts(booking);
  const decision = deriveDecision(booking);
  const dataMode = deriveDataMode(booking);
  const agentMode = deriveAgentMode(booking);
  const policyFlags = extractPolicyFlags(booking);

  // Truncate booking ID to last 8 characters
  const rawId = booking.bookingId || '';
  const bookingIdTruncated = rawId.length > 8 ? rawId.slice(-8) : rawId;

  // Truncate PayPal IDs to last 4 characters
  const captureIdTruncated = booking.captureId ? booking.captureId.slice(-4) : '';
  const payoutBatchIdTruncated = booking.payoutBatchId ? booking.payoutBatchId.slice(-4) : '';

  // Payer format: "Buyer abroad (<country>)" only
  const payerCountry = booking.payer?.country || booking.payerCountry || 'United States';
  const payer = `Buyer abroad (${payerCountry})`;

  // Authorized cents
  let authorizedCents = 0;
  if (Number.isInteger(booking.authorizedCents)) {
    authorizedCents = booking.authorizedCents;
  } else if (booking.authorizedAmountUsd) {
    authorizedCents = Math.round(parseFloat(booking.authorizedAmountUsd) * 100);
  }

  // Captured cents: only when captureStatus === 'COMPLETED'
  let capturedCents = 0;
  if (booking.captureStatus === 'COMPLETED') {
    if (Number.isInteger(booking.capturedCents)) {
      capturedCents = booking.capturedCents;
    } else if (booking.capturedAmountUsd) {
      capturedCents = Math.round(parseFloat(booking.capturedAmountUsd) * 100);
    }
  }

  // Final bill cents
  let finalBillCents = 0;
  if (booking.evidence?.engine_totals?.final_usd_cents != null) {
    finalBillCents = booking.evidence.engine_totals.final_usd_cents;
  } else if (capturedCents > 0) {
    finalBillCents = capturedCents;
  } else if (authorizedCents > 0) {
    finalBillCents = authorizedCents;
  }

  // Active seconds: reads stored field, evidence packet, or calculates from events
  let activeSeconds = 'n/a';
  if (booking.activeSeconds != null) {
    activeSeconds = Number(booking.activeSeconds);
  } else if (booking.evidence?.active_seconds != null) {
    activeSeconds = Number(booking.evidence.active_seconds);
  } else if (Array.isArray(booking.events) && booking.events.length > 0) {
    try {
      const calc = deriveBillFromEvents(booking.evidence, booking.events);
      if (calc && Number.isInteger(calc.activeSeconds)) {
        activeSeconds = calc.activeSeconds;
      }
    } catch (e) {}
  }

  // PayPal fee when known
  const paypalFeeUsd = booking.paypal_fee_usd != null && booking.paypal_fee_usd !== ''
    ? String(booking.paypal_fee_usd)
    : 'n/a';

  // Extra work description safely extracted
  let extraWorkDescription = 'n/a';
  if (booking.evidence?.extra_work?.description) {
    extraWorkDescription = String(booking.evidence.extra_work.description);
  } else if (Array.isArray(booking.events)) {
    const extraEvt = booking.events.find((e) => e.type === 'extra_work');
    if (extraEvt?.payload?.description) {
      extraWorkDescription = String(extraEvt.payload.description);
    }
  }

  return {
    booking_id: bookingIdTruncated,
    created_at: booking.createdAt || 'n/a',
    service_name: booking.evidence?.service?.name || booking.serviceName || 'n/a',
    booking_type: booking.evidence?.booking_type || booking.bookingType || 'normal',
    payer,
    data_mode: dataMode,
    agent_mode: agentMode,
    decision,
    paypal_status: booking.captureStatus || booking.status || 'n/a',
    authorized_usd: (authorizedCents / 100).toFixed(2),
    final_bill_usd: (finalBillCents / 100).toFixed(2),
    captured_usd: (capturedCents / 100).toFixed(2),
    breakdown: {
      artisan_wages_usd: rowPayouts.artisanPaidUsd,
      artisan_status: rowPayouts.artisanStatus,
      welfare_usd: rowPayouts.welfarePaidUsd,
      welfare_status: rowPayouts.welfareStatus,
      reserve_usd: rowPayouts.reservePaidUsd,
      reserve_status: rowPayouts.reserveStatus,
      platform_retained_usd: rowPayouts.platformRetainedUsd,
      paypal_fee_usd: paypalFeeUsd
    },
    policy_flags: policyFlags,
    active_seconds: activeSeconds,
    capture_id: captureIdTruncated,
    payout_batch_id: payoutBatchIdTruncated,
    extra_work_description: extraWorkDescription,
    trace: sanitizeTrace(booking.settlement_trace || [])
  };
}

/**
 * GET /api/ledger/records
 * Returns sanitized rows for all bookings in store.
 */
router.get('/records', (req, res) => {
  const allBookings = store.readAll();
  const records = Object.values(allBookings).map(sanitizeRecord);

  // Default sort by created_at descending
  records.sort((a, b) => {
    const timeA = new Date(a.created_at).getTime() || 0;
    const timeB = new Date(b.created_at).getTime() || 0;
    return timeB - timeA;
  });

  return res.status(200).json({
    success: true,
    total_records: records.length,
    records
  });
});

/**
 * GET /api/ledger/summary
 * Aggregates financial totals across all bookings strictly via integer cents.
 */
router.get('/summary', (req, res) => {
  const allBookings = store.readAll();
  const bookingsList = Object.values(allBookings);

  let totalAuthorizedCents = 0;
  let totalCapturedCents = 0;
  let totalWelfarePaidCents = 0;
  let totalReservePaidCents = 0;
  let totalArtisanPaidCents = 0;
  let totalPlatformRetainedCents = 0;

  let totalPendingPayoutCents = 0;
  let totalUnclaimedPayoutCents = 0;

  const countsByDecision = {
    SETTLED: 0,
    HELD: 0,
    PENDING: 0,
    FAILED: 0,
    'n/a': 0
  };

  for (const b of bookingsList) {
    const decision = deriveDecision(b);
    countsByDecision[decision] = (countsByDecision[decision] || 0) + 1;

    // Authorized
    let authCents = 0;
    if (Number.isInteger(b.authorizedCents)) {
      authCents = b.authorizedCents;
    } else if (b.authorizedAmountUsd) {
      authCents = Math.round(parseFloat(b.authorizedAmountUsd) * 100);
    }
    totalAuthorizedCents += authCents;

    // Captured: strictly when captureStatus === 'COMPLETED'
    if (b.captureStatus === 'COMPLETED') {
      let capCents = 0;
      if (Number.isInteger(b.capturedCents)) {
        capCents = b.capturedCents;
      } else if (b.capturedAmountUsd) {
        capCents = Math.round(parseFloat(b.capturedAmountUsd) * 100);
      }
      totalCapturedCents += capCents;
    }

    // Role payouts
    const payouts = extractRowPayouts(b);
    totalWelfarePaidCents += payouts.welfarePaidCents;
    totalReservePaidCents += payouts.reservePaidCents;
    totalArtisanPaidCents += payouts.artisanPaidCents;
    totalPlatformRetainedCents += payouts.platformRetainedCents;

    // Separate counts for PENDING and UNCLAIMED payout items
    if (Array.isArray(b.payoutItems)) {
      for (const item of b.payoutItems) {
        const itemCents = Number.isInteger(item.cents)
          ? item.cents
          : Math.round(parseFloat(item.amountUsd || '0') * 100);

        if (item.status === 'PENDING') {
          totalPendingPayoutCents += itemCents;
        } else if (item.status === 'UNCLAIMED') {
          totalUnclaimedPayoutCents += itemCents;
        }
      }
    }
  }

  return res.status(200).json({
    success: true,
    total_bookings: bookingsList.length,
    total_authorized_usd: (totalAuthorizedCents / 100).toFixed(2),
    total_captured_usd: (totalCapturedCents / 100).toFixed(2),
    total_welfare_paid_usd: (totalWelfarePaidCents / 100).toFixed(2),
    total_reserve_paid_usd: (totalReservePaidCents / 100).toFixed(2),
    total_artisan_wages_paid_usd: (totalArtisanPaidCents / 100).toFixed(2),
    total_platform_retained_usd: (totalPlatformRetainedCents / 100).toFixed(2),
    total_payouts_pending_usd: (totalPendingPayoutCents / 100).toFixed(2),
    total_payouts_unclaimed_usd: (totalUnclaimedPayoutCents / 100).toFixed(2),
    counts_by_decision: countsByDecision,
    as_of: new Date().toISOString()
  });
});

module.exports = router;
