/**
 * ============================================================================
 * UniServ Anomaly Rules & Policy Engine (Stage 5.0)
 * ============================================================================
 * Deterministic policy rules evaluated against authoritative settlement evidence.
 *
 * THRESHOLD CONFIGURATION & ENVIRONMENT OVERRIDES:
 *  - SETTLEMENT_MAX_EXTRAS_RATIO:
 *      Maximum allowed ratio of (extra_work + parts) to BASE service bill.
 *      Default: 1.0 (100% of base bill). Severity: HIGH (forces HOLD_FOR_HUMAN).
 *  - SETTLEMENT_MAX_EXTRA_WORK_COUNT:
 *      Maximum number of extra_work events before advisory flag.
 *      Default: 3. Severity: LOW (advisory, allows APPROVE).
 *  - SETTLEMENT_MIN_PLAUSIBLE_JOB_SECONDS:
 *      Minimum active seconds for a job containing extra work or parts.
 *      Default: 20 seconds. Severity: HIGH.
 *      NOTE: Short jobs WITHOUT extra work or parts are NOT flagged (clean demo happy path).
 *  - SETTLEMENT_MAX_PAUSED_RATIO:
 *      Maximum ratio of paused time to total elapsed job duration.
 *      Default: 0.5 (50% of elapsed time). Severity: LOW.
 *  - SETTLEMENT_FLAG_URGENCY_MISMATCH:
 *      Whether to flag discrepancies between booking_type and triage urgency.
 *      Default: true. Severity: LOW.
 *
 * POLICY DECISION INVARIANT:
 *  - Any HIGH severity flag forces outcome HOLD_FOR_HUMAN.
 *  - Only LOW severity flags or NO flags allow outcome APPROVE.
 * ============================================================================
 */

/**
 * Returns active threshold values, resolving environment variable overrides at call time.
 * @returns {object}
 */
function getThresholds() {
  return {
    MAX_EXTRAS_RATIO:
      process.env.SETTLEMENT_MAX_EXTRAS_RATIO !== undefined
        ? Number(process.env.SETTLEMENT_MAX_EXTRAS_RATIO)
        : 1.0,
    MAX_EXTRA_WORK_COUNT:
      process.env.SETTLEMENT_MAX_EXTRA_WORK_COUNT !== undefined
        ? Number(process.env.SETTLEMENT_MAX_EXTRA_WORK_COUNT)
        : 3,
    MIN_PLAUSIBLE_JOB_SECONDS:
      process.env.SETTLEMENT_MIN_PLAUSIBLE_JOB_SECONDS !== undefined
        ? Number(process.env.SETTLEMENT_MIN_PLAUSIBLE_JOB_SECONDS)
        : 20,
    MAX_PAUSED_RATIO:
      process.env.SETTLEMENT_MAX_PAUSED_RATIO !== undefined
        ? Number(process.env.SETTLEMENT_MAX_PAUSED_RATIO)
        : 0.5,
    FLAG_URGENCY_MISMATCH: process.env.SETTLEMENT_FLAG_URGENCY_MISMATCH !== 'false'
  };
}

/**
 * Evaluates deterministic anomaly rules against the settlement evidence packet.
 *
 * @param {object} evidence - Authoritative settlement evidence packet
 * @param {object} [customThresholds=null] - Optional override thresholds for testing
 * @returns {Array<{ id: string, severity: 'high'|'low', reason: string, details?: object }>}
 */
function evaluateAnomalyRules(evidence, customThresholds = null) {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('Invalid evidence packet passed to evaluateAnomalyRules');
  }

  const thresholds = customThresholds || getThresholds();
  const flags = [];

  const engineTotals = evidence.engine_totals || {};
  const basePriceRupees = engineTotals.base_price_rupees || 0;
  const extraWorkRupees = engineTotals.extra_work_rupees || 0;
  const partsRupees = engineTotals.parts_rupees || 0;
  const finalCents = engineTotals.final_cents || 0;
  const authorizedCents = evidence.authorized_cents || 0;

  // --------------------------------------------------------------------------
  // Rule 1: RULE_CEILING_EXCEEDED (HIGH)
  // Must produce exactly the same outcome and reason text as capture-route check.
  // --------------------------------------------------------------------------
  if (finalCents > authorizedCents) {
    flags.push({
      id: 'RULE_CEILING_EXCEEDED',
      severity: 'high',
      reason: `Final bill ($${engineTotals.final_amount_usd} USD / ₹${engineTotals.final_rupees}) exceeded authorized ceiling ($${evidence.authorized_amount_usd} USD)`,
      details: {
        final_cents: finalCents,
        authorized_cents: authorizedCents,
        final_amount_usd: engineTotals.final_amount_usd,
        authorized_amount_usd: evidence.authorized_amount_usd
      }
    });
  }

  // --------------------------------------------------------------------------
  // Rule 2: RULE_EXCESSIVE_EXTRAS (HIGH)
  // Compares extra_work + parts to the BASE service bill (not total bill).
  // --------------------------------------------------------------------------
  const totalExtrasRupees = extraWorkRupees + partsRupees;
  const maxAllowedExtras = basePriceRupees * thresholds.MAX_EXTRAS_RATIO;

  if (basePriceRupees > 0 && totalExtrasRupees > maxAllowedExtras) {
    flags.push({
      id: 'RULE_EXCESSIVE_EXTRAS',
      severity: 'high',
      reason: `Extra work and parts total (₹${totalExtrasRupees}) exceeds ${Math.round(thresholds.MAX_EXTRAS_RATIO * 100)}% of base service bill (₹${basePriceRupees})`,
      details: {
        extra_work_rupees: extraWorkRupees,
        parts_rupees: partsRupees,
        total_extras: totalExtrasRupees,
        base_bill: basePriceRupees,
        ratio: totalExtrasRupees / basePriceRupees
      }
    });
  }

  // --------------------------------------------------------------------------
  // Rule 3: RULE_SUSPICIOUS_FAST_EXTRAS (HIGH)
  // Active seconds below plausible threshold WITH extra work or parts present.
  // CRITICAL: Does NOT flag short jobs that have NO extra work and NO parts.
  // --------------------------------------------------------------------------
  const hasExtrasOrParts = totalExtrasRupees > 0;
  const rawActive = evidence.raw_active_seconds !== undefined ? evidence.raw_active_seconds : 0;

  if (rawActive < thresholds.MIN_PLAUSIBLE_JOB_SECONDS && hasExtrasOrParts) {
    flags.push({
      id: 'RULE_SUSPICIOUS_FAST_EXTRAS',
      severity: 'high',
      reason: `Job duration (${rawActive}s) is below plausible threshold (${thresholds.MIN_PLAUSIBLE_JOB_SECONDS}s) while billing extra work or parts (₹${totalExtrasRupees})`,
      details: {
        raw_active_seconds: rawActive,
        threshold_seconds: thresholds.MIN_PLAUSIBLE_JOB_SECONDS,
        total_extras_rupees: totalExtrasRupees
      }
    });
  }

  // --------------------------------------------------------------------------
  // Rule 4: RULE_NON_POSITIVE_DURATION (LOW)
  // Safe duration handling: flags zero or negative durations.
  // --------------------------------------------------------------------------
  if (evidence.raw_elapsed_seconds !== undefined && evidence.raw_elapsed_seconds <= 0 && evidence.has_start && evidence.has_complete) {
    flags.push({
      id: 'RULE_NON_POSITIVE_DURATION',
      severity: 'low',
      reason: `Job recorded zero or negative duration (${evidence.raw_elapsed_seconds}s), treated safely as 0 active seconds`,
      details: {
        raw_elapsed_seconds: evidence.raw_elapsed_seconds
      }
    });
  }

  // --------------------------------------------------------------------------
  // Rule 5: RULE_MANY_EXTRA_WORK_EVENTS (LOW)
  // Advisory: Flags when extra_work events count exceeds threshold.
  // --------------------------------------------------------------------------
  const extraWorkCount = Array.isArray(evidence.extra_work_items) ? evidence.extra_work_items.length : 0;
  if (extraWorkCount > thresholds.MAX_EXTRA_WORK_COUNT) {
    flags.push({
      id: 'RULE_MANY_EXTRA_WORK_EVENTS',
      severity: 'low',
      reason: `Job recorded ${extraWorkCount} extra work events (threshold: ${thresholds.MAX_EXTRA_WORK_COUNT})`,
      details: {
        extra_work_count: extraWorkCount,
        threshold: thresholds.MAX_EXTRA_WORK_COUNT
      }
    });
  }

  // --------------------------------------------------------------------------
  // Rule 6: RULE_EXCESSIVE_PAUSED_TIME (LOW)
  // Advisory: Flags when paused time exceeds 50% of total elapsed job time.
  // --------------------------------------------------------------------------
  const totalPaused = evidence.total_paused_seconds || 0;
  const totalJobElapsed = rawActive + totalPaused;

  if (totalJobElapsed > 0 && (totalPaused / totalJobElapsed) > thresholds.MAX_PAUSED_RATIO) {
    flags.push({
      id: 'RULE_EXCESSIVE_PAUSED_TIME',
      severity: 'low',
      reason: `Paused parts time (${totalPaused}s) represents ${Math.round((totalPaused / totalJobElapsed) * 100)}% of total job duration (threshold: ${Math.round(thresholds.MAX_PAUSED_RATIO * 100)}%)`,
      details: {
        total_paused_seconds: totalPaused,
        total_job_elapsed: totalJobElapsed,
        ratio: totalPaused / totalJobElapsed
      }
    });
  }

  // --------------------------------------------------------------------------
  // Rule 7: RULE_URGENCY_MISMATCH (LOW)
  // Advisory: Flags discrepancy between customer booking type and triage urgency.
  // --------------------------------------------------------------------------
  if (thresholds.FLAG_URGENCY_MISMATCH) {
    const isEmergency = evidence.booking_type === 'emergency';
    const triageUrgency = evidence.untrusted_data?.ai_triage?.urgency;

    if (triageUrgency) {
      const normTriage = String(triageUrgency).toLowerCase();
      if (isEmergency && normTriage === 'low') {
        flags.push({
          id: 'RULE_URGENCY_MISMATCH',
          severity: 'low',
          reason: 'Emergency booking flagged as low urgency by AI triage',
          details: { booking_type: 'emergency', triage_urgency: normTriage }
        });
      } else if (!isEmergency && normTriage === 'emergency') {
        flags.push({
          id: 'RULE_URGENCY_MISMATCH',
          severity: 'low',
          reason: 'Standard booking flagged as emergency urgency by AI triage',
          details: { booking_type: evidence.booking_type, triage_urgency: normTriage }
        });
      }
    }
  }

  return flags;
}

/**
 * Authoritative policy decision function.
 *
 * Invariant:
 *  - ANY high severity flag forces HOLD_FOR_HUMAN.
 *  - ONLY low severity flags or no flags allow APPROVE.
 *
 * @param {Array<{ id: string, severity: 'high'|'low', reason: string }>} flags
 * @returns {{ decision: 'APPROVE'|'HOLD_FOR_HUMAN', reason: string, flagIds: string[], flags: Array, highFlags: Array, lowFlags: Array }}
 */
function decide(flags = []) {
  const highFlags = flags.filter((f) => f.severity === 'high');
  const lowFlags = flags.filter((f) => f.severity === 'low');

  if (highFlags.length > 0) {
    // If multiple high flags, primary reason is the first high flag
    return {
      decision: 'HOLD_FOR_HUMAN',
      reason: highFlags[0].reason,
      reasons: highFlags.map((f) => f.reason),
      flagIds: highFlags.map((f) => f.id),
      flags,
      highFlags,
      lowFlags
    };
  }

  return {
    decision: 'APPROVE',
    reason:
      lowFlags.length > 0
        ? `Approved with ${lowFlags.length} advisory flag(s): ${lowFlags.map((f) => f.id).join(', ')}`
        : 'Approved: all anomaly checks clear',
    reasons: lowFlags.map((f) => f.reason),
    flagIds: lowFlags.map((f) => f.id),
    flags,
    highFlags,
    lowFlags
  };
}

module.exports = {
  getThresholds,
  evaluateAnomalyRules,
  decide
};
