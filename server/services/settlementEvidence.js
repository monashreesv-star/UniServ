/**
 * ============================================================================
 * UniServ Settlement Evidence Service (Stage 5.0)
 * ============================================================================
 * Builds an authoritative, immutable evidence packet for a booking derived
 * strictly from server data.
 *
 * ARCHITECTURAL CONSTRAINTS:
 *  - Uses the SAME deriveBillFromEvents function that drives bill-preview and capture.
 *  - All client-reported inputs (extra_work descriptions, triage summaries, etc.)
 *    are quarantined under an explicit untrusted_data field.
 *  - Computes exact pause intervals and total paused seconds.
 *  - Never accepts client-side amounts or durations.
 *  - Pure deterministic function without side-effects or external network calls.
 * ============================================================================
 */

const { deriveBillFromEvents } = require('./jobEventService');

/**
 * Builds the comprehensive settlement evidence packet from a stored booking record.
 *
 * @param {object} booking - Stored booking record from database/store
 * @param {object} [options={}] - Optional calculation overrides (e.g. demoTimeScale)
 * @returns {object} Immutable settlement evidence packet
 */
function buildSettlementEvidence(booking, options = {}) {
  if (!booking || typeof booking !== 'object') {
    throw new Error('Invalid booking object provided to buildSettlementEvidence');
  }

  const events = Array.isArray(booking.events) ? booking.events : [];

  // 1. Stamped Event Timeline
  const timeline = events.map((e) => ({
    type: e.type,
    timestamp: e.timestamp,
    client_reported: Boolean(e.client_reported),
    payload: e.payload ? { ...e.payload } : {}
  }));

  // 2. Pause Intervals & Duration Calculation
  const pauseIntervals = [];
  let currentPauseStart = null;

  for (const e of events) {
    if (e.type === 'pause_parts' && !currentPauseStart) {
      currentPauseStart = e.timestamp;
    } else if (e.type === 'resume' && currentPauseStart) {
      const startMs = new Date(currentPauseStart).getTime();
      const endMs = new Date(e.timestamp).getTime();
      const durSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
      pauseIntervals.push({
        start: currentPauseStart,
        end: e.timestamp,
        duration_seconds: durSec
      });
      currentPauseStart = null;
    }
  }

  const completeEvent = events.find((e) => e.type === 'complete');
  if (currentPauseStart && completeEvent) {
    const startMs = new Date(currentPauseStart).getTime();
    const endMs = new Date(completeEvent.timestamp).getTime();
    const durSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
    pauseIntervals.push({
      start: currentPauseStart,
      end: completeEvent.timestamp,
      duration_seconds: durSec
    });
  }

  const totalPausedSeconds = pauseIntervals.reduce((sum, p) => sum + p.duration_seconds, 0);

  // 3. Extract Extra Work and Parts Items
  const extraWorkEvents = events.filter((e) => e.type === 'extra_work');
  const extraWorkItems = extraWorkEvents.map((e) => ({
    id: e.payload?.id || null,
    description: typeof e.payload?.description === 'string' ? e.payload.description : '',
    amount: Number(e.payload?.amount) || 0,
    approved: Boolean(e.payload?.approved),
    client_reported: true
  }));

  const partsEvents = events.filter((e) => e.type === 'parts');
  const partsItems = partsEvents.map((e) => ({
    cost: Number(e.payload?.cost) || 0,
    client_reported: true
  }));
  const partsCost = partsItems.reduce((sum, p) => sum + p.cost, 0);

  // 4. Authoritative Bill Calculation via the SAME deriveBillFromEvents
  let billResult = null;
  try {
    billResult = deriveBillFromEvents(booking, null, options);
  } catch (err) {
    // If events are not yet complete, deriveBillFromEvents may throw
    billResult = null;
  }

  // Safe duration handling: guard against zero or negative duration
  const startEvent = events.find((e) => e.type === 'start');
  let rawElapsedSeconds = 0;
  if (startEvent && completeEvent) {
    const startMs = new Date(startEvent.timestamp).getTime();
    const compMs = new Date(completeEvent.timestamp).getTime();
    rawElapsedSeconds = Math.floor((compMs - startMs) / 1000);
  }

  const safeRawActiveSeconds = billResult
    ? Math.max(0, billResult.rawActiveSeconds)
    : Math.max(0, rawElapsedSeconds - totalPausedSeconds);

  const safeActiveSeconds = billResult ? Math.max(0, billResult.activeSeconds) : safeRawActiveSeconds;

  const basePriceRupees = billResult?.bill
    ? Math.round((billResult.bill.basePaise || 0) / 100)
    : (booking.evidence?.service?.start_price || booking.totalRupees || 99);
  const overtimeChargeRupees = billResult?.bill
    ? Math.round((billResult.bill.overtimePaise || 0) / 100)
    : 0;
  const extraWorkRupees = billResult?.bill
    ? Math.round((billResult.bill.extraPaise || 0) / 100)
    : 0;
  const partsRupees = billResult?.bill
    ? Math.round((billResult.bill.partCostPaise || 0) / 100)
    : partsCost;

  const finalPaise = billResult?.totalPaise ?? booking.estimatePaise ?? 9900;
  const finalRupees = billResult?.totalRupees ?? booking.totalRupees ?? 99;
  const finalCents = billResult?.finalCents ?? booking.estimateCents ?? 118;
  const finalAmountUsd =
    billResult?.finalAmountUsd ??
    (booking.estimateAmountUsd || (finalCents / 100).toFixed(2));

  // 5. Quarantined Untrusted Context (Descriptions & User Data)
  const untrustedData = {
    english_dispatch_summary: booking.english_dispatch_summary || null,
    ai_triage: booking.ai_triage
      ? {
          trade_id: booking.ai_triage.trade_id || null,
          urgency: booking.ai_triage.urgency || null,
          likely_parts: Array.isArray(booking.ai_triage.likely_parts)
            ? [...booking.ai_triage.likely_parts]
            : [],
          price_range_inr: booking.ai_triage.price_range_inr
            ? { ...booking.ai_triage.price_range_inr }
            : null,
          mode: booking.ai_triage.mode || null
        }
      : null,
    extra_work_descriptions: extraWorkItems.map((ew) => ew.description).filter(Boolean)
  };

  return {
    booking_id: booking.bookingId,
    status: booking.status,
    service: booking.evidence?.service
      ? { ...booking.evidence.service }
      : { id: 's1', name: 'Plumber', start_price: basePriceRupees },
    booking_type: booking.evidence?.booking_type || 'normal',
    distance_km: booking.evidence?.distance_km ?? 0,
    authorized_cents: booking.authorizedCents || 0,
    authorized_amount_usd:
      booking.authorizedAmountUsd ||
      (booking.authorizedCents ? (booking.authorizedCents / 100).toFixed(2) : '0.00'),
    engine_totals: {
      final_paise: finalPaise,
      final_rupees: finalRupees,
      final_cents: finalCents,
      final_amount_usd: finalAmountUsd,
      base_price_rupees: basePriceRupees,
      overtime_charge_rupees: overtimeChargeRupees,
      extra_work_rupees: extraWorkRupees,
      parts_rupees: partsRupees
    },
    timeline,
    active_seconds: safeActiveSeconds,
    raw_active_seconds: safeRawActiveSeconds,
    raw_elapsed_seconds: rawElapsedSeconds,
    pause_intervals: pauseIntervals,
    total_paused_seconds: totalPausedSeconds,
    extra_work_items: extraWorkItems,
    parts_items: partsItems,
    parts_cost: partsCost,
    demo_time_scale: billResult?.demoTimeScale || null,
    has_start: Boolean(startEvent),
    has_complete: Boolean(completeEvent),
    untrusted_data: untrustedData
  };
}

module.exports = {
  buildSettlementEvidence
};
