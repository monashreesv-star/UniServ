/**
 * ============================================================================
 * UniServ Deterministic Settlement Engine
 * ============================================================================
 * Pure calculation engine with zero React or I/O dependencies.
 * Source of truth: Integer INR paise (1 INR = 100 paise) and USD cents.
 *
 * EVIDENCE FIELDS READ BY computeBill(evidence):
 * ----------------------------------------------------------------------------
 * 1. base_amount              : number (INR Rupees)
 *    Optional base charge. If omitted, falls back to evidence.service?.start_price
 *    or default ₹299 (29,900 paise).
 * 2. service                  : object
 *    service.start_price      : number (INR Rupees), fallback base amount.
 *    service.helper_request   : object { amount: number }, fallback helper fee.
 * 3. booking_type             : string ('now' | 'scheduled' | 'emergency')
 *    If 'emergency', incurs standard emergency surge of +₹100 (10,000 paise).
 * 4. emergency_surge          : number (INR Rupees)
 *    Explicit emergency surge amount. Overrides booking_type check if > 0.
 * 5. distance_km              : number (kilometers)
 *    or evidence.worker?.distance_km. Fair-wage distance rule:
 *    Distance <= 7.0 km is included in base (₹0).
 *    Distance > 7.0 km charges ₹7 (700 paise) per additional km: Math.round((km - 7) * 7).
 * 6. extra_work               : object { approved: boolean, amount: number (INR Rupees) }
 *    Included only if evidence.extra_work.approved === true.
 * 7. second_worker            : boolean | object
 *    and helper_request       : object { status: 'approved' | 'pending' | 'declined', amount: number (INR Rupees) }
 *    Included if second_worker is truthy and helper_request status is 'approved'
 *    (or second_worker assigned), default ₹200 (20,000 paise).
 * 8. part_order               : object { part_cost: number (INR Rupees) }
 *    Procured hardware/spares cost. Included if evidence.part_order.part_cost > 0.
 * 9. duration_seconds         : number (seconds)
 *    or seconds_elapsed. Total elapsed service stopwatch time.
 * 10. paused_seconds          : number (seconds)
 *     or paused_procurement_seconds. Time paused during parts acquisition.
 *     Active seconds = Math.max(duration_seconds - paused_seconds, 0).
 *     Strictly after 7200 active seconds, triggers ₹20 (2,000 paise) overtime.
 * 11. overtime_charge         : number (INR Rupees)
 *     Explicit overtime surcharge. Used when duration_seconds is not passed.
 * 12. is_bulk_project         : boolean
 *     If true, multi-day institutional project: stopwatch overtime is waived (0).
 * 13. discount_applied        : number (INR Rupees)
 *     Subtracted discount (e.g. ₹50 first-time user welcome discount = 5,000 paise).
 * 14. cancellation_penalty_fee: number (INR Rupees)
 *     Prior unpaid cancellation fee rolled over to active booking.
 * 15. Minimum Bill Floor      : Fixed at ₹49 (4,900 paise).
 * ============================================================================
 */

// Constant Sandbox Demo Rate (SIMULATED): 1 USD = 85.00 INR (1 INR = 0.0117647 USD)
const SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD = 1 / 85;

/**
 * Computes deterministic line-item breakdown and total in integer paise and rupees.
 * @param {object} evidence - Booking evidence and telemetry.
 * @returns {object} Calculated bill with exact integer paise and rupee values.
 */
function computeBill(evidence) {
  if (!evidence) {
    return {
      basePaise: 29900,
      surgePaise: 0,
      distanceChargePaise: 0,
      extraPaise: 0,
      helperPaise: 0,
      partCostPaise: 0,
      overtimePaise: 0,
      cancelPenaltyPaise: 0,
      discountPaise: 0,
      rawTotalPaise: 29900,
      totalPaise: 35000,
      totalRupees: 350
    };
  }

  // 1. Base amount (rupees -> integer paise)
  const baseRupees = Number(evidence.base_amount ?? evidence.service?.start_price ?? 299);
  const basePaise = Math.round(baseRupees * 100);

  // 2. Emergency surge
  const isEmergencyType = evidence.booking_type === 'emergency';
  const explicitSurge = Number(evidence.emergency_surge || 0);
  const surgeRupees = explicitSurge > 0 ? explicitSurge : (isEmergencyType ? 100 : 0);
  const surgePaise = Math.round(surgeRupees * 100);

  // 3. Distance surcharge (> 7 km at ₹7 per km)
  const distKm = Number(evidence.distance_km ?? evidence.worker?.distance_km ?? 0);
  const distanceChargeRupees = distKm > 7 ? Math.round((distKm - 7) * 7) : 0;
  const distanceChargePaise = Math.round(distanceChargeRupees * 100);

  // 4. Approved extra work
  const extraApproved = Boolean(evidence.extra_work && evidence.extra_work.approved);
  const extraRupees = extraApproved ? Number(evidence.extra_work.amount || 0) : 0;
  const extraPaise = Math.round(extraRupees * 100);

  // 5. Approved assistant / second worker
  const isHelperApproved = Boolean(
    evidence.second_worker &&
    (evidence.helper_request?.status === 'approved' || evidence.second_worker)
  );
  const helperRupees = isHelperApproved
    ? Number(evidence.helper_request?.amount || evidence.service?.helper_request?.amount || 200)
    : 0;
  const helperPaise = Math.round(helperRupees * 100);

  // 6. Procured spare parts
  const partCostRupees = (evidence.part_order && evidence.part_order.part_cost)
    ? Number(evidence.part_order.part_cost || 0)
    : 0;
  const partCostPaise = Math.round(partCostRupees * 100);

  // 7. Overtime: strictly after 7200 active seconds (waived for multi-day bulk contracts)
  let overtimeRupees = 0;
  if (!evidence.is_bulk_project) {
    if (evidence.duration_seconds !== undefined || evidence.seconds_elapsed !== undefined) {
      const duration = Number(evidence.duration_seconds ?? evidence.seconds_elapsed ?? 0);
      const paused = Number(evidence.paused_seconds ?? evidence.paused_procurement_seconds ?? 0);
      const activeSeconds = Math.max(duration - paused, 0);
      if (activeSeconds > 7200) {
        overtimeRupees = 20;
      }
    } else if (evidence.overtime_charge !== undefined) {
      overtimeRupees = Number(evidence.overtime_charge || 0);
    }
  }
  const overtimePaise = Math.round(overtimeRupees * 100);

  // 8. Prior cancellation penalty
  const cancelPenaltyRupees = Number(evidence.cancellation_penalty_fee || 0);
  const cancelPenaltyPaise = Math.round(cancelPenaltyRupees * 100);

  // 9. First-time or promotional discount
  const discountRupees = Number(evidence.discount_applied || 0);
  const discountPaise = Math.round(discountRupees * 100);

  // 10. Minimum bill floor: ₹49 (4,900 paise)
  const minBillPaise = 4900;
  const rawTotalPaise = basePaise + surgePaise + distanceChargePaise + extraPaise + helperPaise + partCostPaise + overtimePaise + cancelPenaltyPaise - discountPaise;
  const totalPaise = Math.max(rawTotalPaise, minBillPaise);
  const totalRupees = Math.round(totalPaise / 100);

  return {
    basePaise,
    surgePaise,
    distanceChargePaise,
    extraPaise,
    helperPaise,
    partCostPaise,
    overtimePaise,
    cancelPenaltyPaise,
    discountPaise,
    rawTotalPaise,
    totalPaise,
    totalRupees
  };
}

/**
 * Converts INR paise to integer USD cents converting ONCE via constant demo exchange rate.
 * @param {number} paise - Integer INR paise.
 * @param {number} [rate] - Sandbox demo exchange rate (default: 1/85).
 * @returns {number} Integer USD cents.
 */
function toUsdCents(paise, rate = SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD) {
  const integerPaise = Math.max(0, Math.floor(Number(paise) || 0));
  return Math.round(integerPaise * rate);
}

/**
 * Splits integer total into 80% Artisan, 10% Welfare, 6% Reserve, 4% Platform
 * using the Largest Remainder (Hare-Niemeyer) method.
 * Guarantees artisan + welfare + reserve + platform === total for all integers.
 * @param {number} totalUnits - Total integer units (cents, paise, or rupees).
 * @returns {object} { artisan, welfare, reserve, platform }
 */
function splitCents(totalUnits) {
  const integerTotal = Math.max(0, Math.floor(Number(totalUnits) || 0));
  if (integerTotal === 0) {
    return { artisan: 0, welfare: 0, reserve: 0, platform: 0 };
  }

  // Quotas: artisan 80%, welfare 10%, reserve 6%, platform 4%
  const shares = [
    { key: 'artisan', weight: 0.80, index: 0 },
    { key: 'welfare', weight: 0.10, index: 1 },
    { key: 'reserve', weight: 0.06, index: 2 },
    { key: 'platform', weight: 0.04, index: 3 }
  ];

  let sumFloors = 0;
  const items = shares.map(s => {
    const raw = integerTotal * s.weight;
    const floor = Math.floor(raw);
    const remainder = raw - floor;
    sumFloors += floor;
    return {
      key: s.key,
      floor,
      remainder,
      index: s.index
    };
  });

  const deficit = integerTotal - sumFloors;

  // Largest remainder sort with deterministic tie-breaking (artisan > welfare > reserve > platform)
  items.sort((a, b) => {
    if (Math.abs(b.remainder - a.remainder) > 1e-9) {
      return b.remainder - a.remainder;
    }
    return a.index - b.index;
  });

  for (let i = 0; i < deficit; i++) {
    items[i].floor += 1;
  }

  const result = {};
  for (const item of items) {
    result[item.key] = item.floor;
  }
  return result;
}

/**
 * Convenience alias for splitCents operating on integer paise.
 */
function splitPaise(totalPaise) {
  return splitCents(totalPaise);
}

/**
 * Computes authorization ceiling with a 25% buffer above the estimate.
 * @param {number} estimateUnits - Estimated total in cents/paise.
 * @returns {number} Authorization ceiling integer amount.
 */
function authorizationCeiling(estimateUnits) {
  const integerEstimate = Math.max(0, Math.floor(Number(estimateUnits) || 0));
  return integerEstimate + Math.round(integerEstimate * 0.25);
}

module.exports = {
  computeBill,
  toUsdCents,
  splitCents,
  splitPaise,
  authorizationCeiling,
  SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD
};
