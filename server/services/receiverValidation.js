/**
 * ============================================================================
 * UniServ PayPal Payouts Receiver Validation
 * ============================================================================
 * Validates that all three required payout receiver email variables:
 *   - PAYPAL_RECEIVER_ARTISAN_EMAIL
 *   - PAYPAL_RECEIVER_WELFARE_EMAIL
 *   - PAYPAL_RECEIVER_RESERVE_EMAIL
 * are present, non-empty, and pairwise distinct.
 *
 * SECURITY:
 * Never prints, logs, or returns email addresses or secrets.
 * Refusals and errors report ONLY variable names.
 * ============================================================================
 */

const RECEIVER_VARS = [
  'PAYPAL_RECEIVER_ARTISAN_EMAIL',
  'PAYPAL_RECEIVER_WELFARE_EMAIL',
  'PAYPAL_RECEIVER_RESERVE_EMAIL'
];

/**
 * Validates that all receiver email environment variables exist and are distinct.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateReceiverEmails() {
  const missing = [];
  const trimmed = {};

  for (const name of RECEIVER_VARS) {
    const val = process.env[name];
    if (!val || typeof val !== 'string' || val.trim().length === 0) {
      missing.push(name);
    } else {
      trimmed[name] = val.trim().toLowerCase();
    }
  }

  const errors = [];

  if (missing.length > 0) {
    errors.push(`Missing receiver email variable(s): ${missing.join(', ')}`);
  }

  // Check pairwise distinctness among present variables
  if (
    !missing.includes('PAYPAL_RECEIVER_ARTISAN_EMAIL') &&
    !missing.includes('PAYPAL_RECEIVER_WELFARE_EMAIL') &&
    trimmed['PAYPAL_RECEIVER_ARTISAN_EMAIL'] === trimmed['PAYPAL_RECEIVER_WELFARE_EMAIL']
  ) {
    errors.push('PAYPAL_RECEIVER_ARTISAN_EMAIL and PAYPAL_RECEIVER_WELFARE_EMAIL must be distinct');
  }

  if (
    !missing.includes('PAYPAL_RECEIVER_ARTISAN_EMAIL') &&
    !missing.includes('PAYPAL_RECEIVER_RESERVE_EMAIL') &&
    trimmed['PAYPAL_RECEIVER_ARTISAN_EMAIL'] === trimmed['PAYPAL_RECEIVER_RESERVE_EMAIL']
  ) {
    errors.push('PAYPAL_RECEIVER_ARTISAN_EMAIL and PAYPAL_RECEIVER_RESERVE_EMAIL must be distinct');
  }

  if (
    !missing.includes('PAYPAL_RECEIVER_WELFARE_EMAIL') &&
    !missing.includes('PAYPAL_RECEIVER_RESERVE_EMAIL') &&
    trimmed['PAYPAL_RECEIVER_WELFARE_EMAIL'] === trimmed['PAYPAL_RECEIVER_RESERVE_EMAIL']
  ) {
    errors.push('PAYPAL_RECEIVER_WELFARE_EMAIL and PAYPAL_RECEIVER_RESERVE_EMAIL must be distinct');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  RECEIVER_VARS,
  validateReceiverEmails
};
