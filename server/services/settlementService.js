/**
 * ============================================================================
 * UniServ Server Settlement Service
 * ============================================================================
 * Strictly validates incoming booking evidence parameters and computes
 * deterministic bill, USD cents conversion, and authorization ceiling hold.
 *
 * Single Source of Truth: src/utils/settlementEngine.js
 * ============================================================================
 */

const path = require('path');
const servicesData = require('../../src/data/services.json');
const {
  computeBill,
  toUsdCents,
  authorizationCeiling,
  SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD
} = require('../../src/utils/settlementEngine');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/**
 * Validates the whitelist of client inputs and builds sanitized evidence.
 * Whitelist:
 *   - service_id   (string, must exist in services.json)
 *   - booking_type ('normal' | 'emergency' | 'scheduled')
 *   - distance_km  (number between 0 and 200)
 *   - first_time   (boolean)
 *
 * NEVER accepts base_amount, emergency_surge, discount_applied,
 * cancellation fee, or any client-provided price!
 *
 * @param {object} input
 * @returns {object} Validated server-constructed evidence
 */
function validateAndBuildEvidence(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('Invalid request body: expected an object');
  }

  const { service_id, booking_type, distance_km, first_time } = input;

  // 1. service_id check
  if (!service_id || typeof service_id !== 'string') {
    throw new ValidationError('Missing or invalid service_id');
  }
  const service = servicesData.find((s) => s.id === service_id.trim());
  if (!service) {
    throw new ValidationError(`Unknown service_id: "${service_id}"`);
  }

  // 2. booking_type check ('normal', 'emergency', 'scheduled')
  const validTypes = ['normal', 'emergency', 'scheduled'];
  const normalizedType = typeof booking_type === 'string' ? booking_type.trim().toLowerCase() : 'normal';
  if (!validTypes.includes(normalizedType)) {
    throw new ValidationError(`Invalid booking_type: "${booking_type}". Allowed: ${validTypes.join(', ')}`);
  }
  const isEmergency = normalizedType === 'emergency';

  // 3. distance_km check (numeric, 0 <= distance <= 200)
  const numDistance = Number(distance_km);
  if (distance_km === undefined || distance_km === null || isNaN(numDistance)) {
    throw new ValidationError('Missing or invalid distance_km: must be a numeric value');
  }
  if (!Number.isFinite(numDistance) || numDistance < 0 || numDistance > 200) {
    throw new ValidationError(`Invalid distance_km (${distance_km}): must be between 0 and 200 km`);
  }
  const sanitizedDistance = Math.round(numDistance * 10) / 10;

  // 4. first_time check (boolean)
  const isFirstTime = Boolean(first_time);

  // Server constructs the evidence strictly from verified server data
  const evidence = {
    service: {
      id: service.id,
      name: service.name,
      start_price: Number(service.start_price) || 299
    },
    booking_type: isEmergency ? 'emergency' : 'now',
    distance_km: sanitizedDistance,
    discount_applied: isFirstTime ? 50 : 0
  };

  return evidence;
}

/**
 * Computes deterministic line items, total paise, USD cents, and ceiling.
 * @param {object} evidence - Validated evidence
 * @returns {object}
 */
function computeEstimateAndHold(evidence) {
  const bill = computeBill(evidence);
  const estimateCents = toUsdCents(bill.totalPaise, SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD);
  const rawCeilingCents = authorizationCeiling(estimateCents);
  const minHoldCents = Math.max(0, parseInt(process.env.MIN_HOLD_CENTS || '0', 10) || 0);
  const authorizedCents = Math.max(rawCeilingCents, minHoldCents);

  return {
    bill,
    totalPaise: bill.totalPaise,
    totalRupees: bill.totalRupees,
    estimateCents,
    authorizedCents,
    estimateAmountUsd: (estimateCents / 100).toFixed(2),
    authorizedAmountUsd: (authorizedCents / 100).toFixed(2),
    exchangeRateDisplay: '1 USD = 85.00 INR (sandbox demo rate)'
  };
}

module.exports = {
  validateAndBuildEvidence,
  computeEstimateAndHold,
  ValidationError
};
