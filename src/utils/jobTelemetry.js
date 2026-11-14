/**
 * ============================================================================
 * UniServ Job Telemetry & Server Settlement Client
 * ============================================================================
 * Handles reporting of server-stamped job events and settlement capture
 * for PayPal Sandbox bookings.
 * 
 * Non-PayPal bookings are skipped without sending network requests, ensuring
 * 100% backward compatibility with domestic Indian payment flows.
 * ============================================================================
 */

import { API_BASE_URL } from '../config/api';

/**
 * Checks if a booking is using PayPal Sandbox settlement.
 * @param {object} booking
 * @returns {boolean}
 */
export function isPayPalBooking(booking) {
  if (!booking) return false;
  return (
    booking.payment_method === 'PAYPAL_SANDBOX' ||
    Boolean(booking.paypal_authorization_id) ||
    Boolean(booking.paypal_booking_id) ||
    (typeof booking.bookingId === 'string' && booking.bookingId.startsWith('BK_')) ||
    (typeof booking.booking_id === 'string' && booking.booking_id.startsWith('BK_'))
  );
}

/**
 * Emits a server-stamped job event for PayPal bookings.
 *
 * @param {object} booking - Current booking object
 * @param {string} type - 'start' | 'pause_parts' | 'resume' | 'extra_work' | 'parts' | 'complete'
 * @param {object} [payload] - Optional event payload (e.g. { amount, cost, description })
 * @returns {Promise<object>} Result object with success flag and event details or error
 */
export async function emitJobEvent(booking, type, payload = {}) {
  if (!isPayPalBooking(booking)) {
    return { success: true, skipped: true, reason: 'NON_PAYPAL_BOOKING' };
  }

  const bookingId = booking?.paypal_booking_id || booking?.bookingId || booking?.booking_id;
  const hasBookingId = Boolean(bookingId);
  console.log(`event emit: ${type} bookingId present: ${hasBookingId ? 'yes' : 'no'}`);

  if (!bookingId) {
    console.warn(`[Telemetry] Cannot emit event "${type}": missing bookingId on booking`, booking);
    return {
      success: false,
      error: 'MISSING_BOOKING_ID',
      message: 'Missing booking ID for telemetry'
    };
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(bookingId)}/events`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, payload })
    });

    console.log(`event emit: ${type} status: ${res.status}`);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[Telemetry] Server rejected event "${type}":`, data.message || data.error);
      return {
        success: false,
        status: res.status,
        error: data.error || 'SERVER_REJECTED',
        message: data.message || `Server rejected event (${res.status})`,
        data
      };
    }

    return {
      success: true,
      status: res.status,
      ...data
    };
  } catch (err) {
    console.log(`event emit: ${type} status: network_error`);
    console.warn(`[Telemetry] Network error emitting event "${type}":`, err.message);
    return {
      success: false,
      error: 'NETWORK_ERROR',
      message: err.message || 'Network connection failed'
    };
  }
}

/**
 * Fetches real-time bill preview derived deterministically from server events.
 *
 * @param {string} bookingId
 * @returns {Promise<object|null>}
 */
export async function fetchBillPreview(bookingId) {
  if (!bookingId) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(bookingId)}/bill-preview`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[Telemetry] Failed to fetch bill preview:', err.message);
    return null;
  }
}

/**
 * Executes guarded capture on the backend.
 *
 * @param {object} params
 * @param {string} params.bookingId
 * @param {string} [params.authorizationId]
 * @returns {Promise<object>}
 */
export async function captureOrder({ bookingId, authorizationId }) {
  const res = await fetch(`${API_BASE_URL}/api/orders/capture`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bookingId, authorizationId })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'PayPal capture failed');
    err.paypalError = data.error;
    err.debugId = data.debugId;
    err.response = data;
    throw err;
  }

  return data;
}

/**
 * Fetches payout split details and live statuses from the backend.
 *
 * @param {string} bookingId
 * @returns {Promise<object|null>}
 */
export async function fetchPayoutDetails(bookingId) {
  if (!bookingId) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api/payouts/${encodeURIComponent(bookingId)}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[Telemetry] Failed to fetch payout details:', err.message);
    return null;
  }
}

/**
 * Retries a failed or timed-out payout batch.
 *
 * @param {string} bookingId
 * @returns {Promise<object>}
 */
export async function retryPayout(bookingId) {
  if (!bookingId) throw new Error('Missing bookingId for payout retry');

  const res = await fetch(`${API_BASE_URL}/api/payouts/${encodeURIComponent(bookingId)}/retry`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'Payout retry failed');
    err.paypalError = data.error;
    err.debugId = data.debugId;
    throw err;
  }
  return data;
}

/**
 * Triggers autonomous AI Settlement Agent for a PayPal booking (Stage 5.2).
 *
 * @param {object} params
 * @param {string} params.bookingId
 * @param {string} [params.customerLanguageCode='en']
 * @returns {Promise<object>}
 */
export async function settleWithAgent({ bookingId, customerLanguageCode = 'en' }) {
  if (!bookingId) throw new Error('Missing bookingId for AI settlement');

  const res = await fetch(`${API_BASE_URL}/api/ai/settlement/${encodeURIComponent(bookingId)}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ customerLanguageCode })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    const err = new Error(data.message || 'AI settlement failed');
    err.status = res.status;
    err.error = data.error;
    throw err;
  }
  return { status: res.status, ...data };
}

/**
 * Polls status of settlement agent run (Stage 5.2).
 *
 * @param {string} bookingId
 * @returns {Promise<object|null>}
 */
export async function fetchSettlementStatus(bookingId) {
  if (!bookingId) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api/ai/settlement/${encodeURIComponent(bookingId)}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[Telemetry] Failed to fetch settlement status:', err.message);
    return null;
  }
}

/**
 * Fetches stored settlement trace and facts (Stage 5.2 / Phase 6 Ledger).
 *
 * @param {string} bookingId
 * @returns {Promise<object|null>}
 */
export async function fetchSettlementTrace(bookingId) {
  if (!bookingId) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api/settlement/${encodeURIComponent(bookingId)}/trace`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[Telemetry] Failed to fetch settlement trace:', err.message);
    return null;
  }
}

export default {
  isPayPalBooking,
  emitJobEvent,
  fetchBillPreview,
  captureOrder,
  fetchPayoutDetails,
  retryPayout,
  settleWithAgent,
  fetchSettlementStatus,
  fetchSettlementTrace
};
