/**
 * ============================================================================
 * UniServ Job Event & Telemetry Service
 * ============================================================================
 * ARCHITECTURAL NOTICE / OTP VERIFICATION MODEL:
 * Start and complete events are reported by the client app after OTP verification
 * (which is simulated client-side in this prototype).
 * The server timestamps each event upon receipt and enforces strict state-machine
 * transition ordering, but the server does not verify the OTP credentials directly.
 * ============================================================================
 */

const {
  computeBill,
  toUsdCents,
  SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD
} = require('../../src/utils/settlementEngine');
const { ValidationError } = require('./settlementService');

const VALID_EVENT_TYPES = ['start', 'pause_parts', 'resume', 'extra_work', 'parts', 'complete'];

/**
 * Validates state-machine event ordering and client-reported payload values.
 * Enforces:
 *   1. booking.status must be 'AUTHORIZED'.
 *   2. complete is accepted only after start.
 *   3. start is accepted only once.
 *   4. pause_parts only between start and complete, and only when not already paused.
 *   5. resume only after pause_parts (when currently paused).
 *   6. no events accepted after complete or after capture / terminal status.
 *   7. extra_work.amount and parts.cost must be positive integers in rupees:
 *      amount <= 2000, cost <= 3000, max 5 extra_work events per booking.
 *   8. Flag every extra_work and parts event as client_reported = true.
 *
 * @param {object} booking - Current booking record
 * @param {object} eventInput - Incoming event data { type, payload }
 * @returns {object} Stamped event record with server-generated ISO timestamp
 */
function validateAndStampEvent(booking, eventInput) {
  if (!booking) {
    throw new ValidationError('Booking not found');
  }

  // Amendment 1: Events require booking.status === 'AUTHORIZED'
  if (booking.status !== 'AUTHORIZED') {
    throw new ValidationError(
      `Cannot record events for booking with status "${booking.status}". Required: "AUTHORIZED"`
    );
  }

  if (!eventInput || typeof eventInput !== 'object') {
    throw new ValidationError('Invalid event payload: expected an object');
  }

  const { type, payload = {} } = eventInput;
  if (!type || typeof type !== 'string' || !VALID_EVENT_TYPES.includes(type)) {
    throw new ValidationError(
      `Invalid event type "${type}". Allowed: ${VALID_EVENT_TYPES.join(', ')}`
    );
  }

  const events = booking.events || [];

  // Check if complete event has already occurred
  const hasCompleted = events.some((e) => e.type === 'complete');
  if (hasCompleted) {
    throw new ValidationError('Job is already completed. No further events are accepted.');
  }

  // Check if start event has occurred
  const hasStarted = events.some((e) => e.type === 'start');

  // Compute current pause state
  let isCurrentlyPaused = false;
  for (const e of events) {
    if (e.type === 'pause_parts') isCurrentlyPaused = true;
    if (e.type === 'resume') isCurrentlyPaused = false;
  }

  let sanitizedPayload = {};
  let isClientReported = false;

  switch (type) {
    case 'start':
      if (hasStarted) {
        throw new ValidationError('Start event has already been recorded for this booking.');
      }
      break;

    case 'complete':
      if (!hasStarted) {
        throw new ValidationError('Complete event is accepted only after the start event has occurred.');
      }
      break;

    case 'pause_parts':
      if (!hasStarted) {
        throw new ValidationError('Cannot pause parts before the start event.');
      }
      if (isCurrentlyPaused) {
        throw new ValidationError('Job is already paused for parts procurement.');
      }
      break;

    case 'resume':
      if (!isCurrentlyPaused) {
        throw new ValidationError('Resume event is accepted only after a pause_parts event.');
      }
      break;

    case 'extra_work': {
      if (!hasStarted) {
        throw new ValidationError('Cannot record extra work before the start event.');
      }

      // Amendment 2: Validate extra_work amount
      const rawAmount = payload.amount !== undefined ? payload.amount : eventInput.amount;
      const numAmount = Number(rawAmount);

      if (!Number.isInteger(numAmount) || numAmount <= 0) {
        throw new ValidationError('extra_work.amount must be a positive integer in rupees.');
      }
      if (numAmount > 2000) {
        throw new ValidationError('extra_work.amount exceeds the maximum limit of ₹2,000.');
      }

      // At most 5 extra_work events per booking
      const existingExtraWorkCount = events.filter((e) => e.type === 'extra_work').length;
      if (existingExtraWorkCount >= 5) {
        throw new ValidationError('Maximum of 5 extra_work events reached for this booking.');
      }

      sanitizedPayload = {
        id: payload.id || `ew_${existingExtraWorkCount + 1}`,
        description: typeof payload.description === 'string' ? payload.description.slice(0, 100) : 'Approved extra work',
        amount: numAmount,
        approved: payload.approved !== false
      };
      isClientReported = true;
      break;
    }

    case 'parts': {
      if (!hasStarted) {
        throw new ValidationError('Cannot record procured parts before the start event.');
      }

      // Amendment 2: Validate parts cost
      const rawCost = payload.cost !== undefined ? payload.cost : eventInput.cost;
      const numCost = Number(rawCost);

      if (!Number.isInteger(numCost) || numCost <= 0) {
        throw new ValidationError('parts.cost must be a positive integer in rupees.');
      }
      if (numCost > 3000) {
        throw new ValidationError('parts.cost exceeds the maximum limit of ₹3,000.');
      }

      sanitizedPayload = {
        cost: numCost,
        part_name: typeof payload.part_name === 'string' ? payload.part_name.slice(0, 100) : 'Procured component'
      };
      isClientReported = true;
      break;
    }
  }

  // Server stamps the timestamp strictly; never trust client timestamps
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    payload: sanitizedPayload,
    timestamp: new Date().toISOString(),
    ...(isClientReported ? { client_reported: true } : {})
  };
}

/**
 * Shared deterministic bill derivation function called identically by:
 *   1. GET  /api/jobs/:bookingId/bill-preview
 *   2. POST /api/orders/capture
 *
 * Guarantees that previewed USD cents equal captured cents for the same event log.
 *
 * @param {object} booking - Booking record with creation evidence
 * @param {Array<object>} [events] - Array of stamped events (defaults to booking.events)
 * @param {object} [options] - Optional demo scaling overrides
 * @returns {object} Computed bill, evidence, paise, USD cents, and active seconds
 */
function deriveBillFromEvents(booking, events = null, options = {}) {
  const eventLog = events || booking.events || [];

  const startEvent = eventLog.find((e) => e.type === 'start');
  const completeEvent = eventLog.find((e) => e.type === 'complete');

  let rawActiveSeconds = 0;
  if (startEvent) {
    const startTime = new Date(startEvent.timestamp).getTime();
    const endTime = completeEvent
      ? new Date(completeEvent.timestamp).getTime()
      : (options.asOfTime ? new Date(options.asOfTime).getTime() : Date.now());

    const totalElapsedSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

    // Sum all pause intervals
    let totalPausedSeconds = 0;
    let pauseStartTime = null;

    for (const e of eventLog) {
      if (e.type === 'pause_parts' && !pauseStartTime) {
        pauseStartTime = new Date(e.timestamp).getTime();
      } else if (e.type === 'resume' && pauseStartTime) {
        const resumeTime = new Date(e.timestamp).getTime();
        totalPausedSeconds += Math.max(0, Math.floor((resumeTime - pauseStartTime) / 1000));
        pauseStartTime = null;
      }
    }
    // If completed while paused, close the open pause interval at completion
    if (pauseStartTime && completeEvent) {
      totalPausedSeconds += Math.max(0, Math.floor((new Date(completeEvent.timestamp).getTime() - pauseStartTime) / 1000));
    }

    rawActiveSeconds = Math.max(0, totalElapsedSeconds - totalPausedSeconds);
  }

  // Addition 2: Server-only DEMO_TIME_SCALE
  const isDemoMode = process.env.DEMO_MODE === 'true';
  const envScale = isDemoMode ? (Number(process.env.DEMO_TIME_SCALE) || 1) : 1;
  const demoTimeScale = options.demoTimeScale !== undefined ? options.demoTimeScale : envScale;
  const effectiveScale = demoTimeScale > 0 ? demoTimeScale : 1;
  const activeSeconds = Math.round(rawActiveSeconds * effectiveScale);

  // Derive extra work (sum of approved extra_work events)
  const approvedExtraEvents = eventLog.filter((e) => e.type === 'extra_work' && e.payload?.approved === true);
  const totalExtraWork = approvedExtraEvents.reduce((sum, e) => sum + (Number(e.payload?.amount) || 0), 0);

  // Derive parts (sum of parts events)
  const partsEvents = eventLog.filter((e) => e.type === 'parts');
  const totalPartsCost = partsEvents.reduce((sum, e) => sum + (Number(e.payload?.cost) || 0), 0);

  // Combine with whitelisted creation evidence
  const baseEvidence = booking.evidence || {};
  const finalEvidence = {
    service: baseEvidence.service || { id: 's1', start_price: 299 },
    booking_type: baseEvidence.booking_type || 'now',
    distance_km: baseEvidence.distance_km || 0,
    discount_applied: baseEvidence.discount_applied || 0,
    cancellation_penalty_fee: baseEvidence.cancellation_penalty_fee || 0,
    is_bulk_project: Boolean(baseEvidence.is_bulk_project),
    duration_seconds: activeSeconds,
    paused_seconds: 0, // already subtracted
    extra_work: totalExtraWork > 0 ? { approved: true, amount: totalExtraWork } : null,
    part_order: totalPartsCost > 0 ? { part_cost: totalPartsCost } : null,
    second_worker: baseEvidence.second_worker || null,
    helper_request: baseEvidence.helper_request || null
  };

  const bill = computeBill(finalEvidence);
  const finalCents = toUsdCents(bill.totalPaise, SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD);
  const finalAmountUsd = (finalCents / 100).toFixed(2);

  return {
    bill,
    evidence: finalEvidence,
    totalPaise: bill.totalPaise,
    totalRupees: bill.totalRupees,
    finalCents,
    finalAmountUsd,
    activeSeconds,
    rawActiveSeconds,
    demoTimeScale: effectiveScale > 1 ? effectiveScale : null,
    hasStart: Boolean(startEvent),
    hasComplete: Boolean(completeEvent)
  };
}

module.exports = {
  VALID_EVENT_TYPES,
  validateAndStampEvent,
  deriveBillFromEvents
};
