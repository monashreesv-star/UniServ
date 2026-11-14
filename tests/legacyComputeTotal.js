/**
 * Legacy computeTotal copied verbatim from src/context/BookingContext.js (commit f154d2d)
 * Used strictly as the baseline regression test oracle for Phase 1.
 */
function legacyComputeTotal(booking) {
  if (!booking) return 350;
  const base = Number(booking.base_amount || booking.service?.start_price || 299);
  const surge = Number(booking.emergency_surge || 0);
  const distKm = Number(booking.distance_km ?? booking.worker?.distance_km ?? 0);
  // Cooperative Fair-Wage Distance Rule: <= 7 km is free/base included; > 7 km charges ₹7 per additional km
  const distanceCharge = distKm > 7 ? Math.round((distKm - 7) * 7) : 0;
  const extra = (booking.extra_work && booking.extra_work.approved) ? Number(booking.extra_work.amount || 0) : 0;
  const helper = (booking.second_worker && (booking.helper_request?.status === 'approved' || booking.second_worker))
    ? Number(booking.helper_request?.amount || booking.service?.helper_request?.amount || 200)
    : 0;
  const partCost = (booking.part_order && booking.part_order.part_cost) ? Number(booking.part_order.part_cost || 0) : 0;
  const overtime = Number(booking.overtime_charge || 0);
  const cancelPenalty = Number(booking.cancellation_penalty_fee || 0);
  const discount = Number(booking.discount_applied || 0);
  return Math.max(base + surge + distanceCharge + extra + helper + partCost + overtime + cancelPenalty - discount, 49);
}

module.exports = { legacyComputeTotal };
