/**
 * ============================================================================
 * UniServ PayPal API Client (Sandbox Plain Fetch)
 * ============================================================================
 * Communicates with PayPal v2 Checkout API via plain native fetch.
 * 
 * SECURITY RULES:
 * - Never prints, logs, or transmits client credentials or access tokens.
 * - Enforces idempotency via PayPal-Request-Id.
 * - Handles token caching with a 60-second safety expiry margin.
 * - If sandbox credentials are not configured, gracefully falls back to SIMULATED mode.
 * ============================================================================
 */

const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

let cachedToken = null;
let tokenExpiresAt = 0;
let clientOverride = null;

/**
 * Sets a client override for testing without network requests.
 * @param {object|null} override
 */
function setClientOverride(override) {
  clientOverride = override;
}

/**
 * Clears the client override.
 */
function resetClientOverride() {
  clientOverride = null;
}

/**
 * Checks whether valid sandbox credentials exist in the environment.
 * @returns {boolean}
 */
function hasValidCredentials() {
  const env = (process.env.PAYPAL_ENVIRONMENT || '').trim();
  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const secret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
  return env === 'sandbox' && clientId.length > 0 && secret.length > 0;
}

/**
 * Obtains an OAuth 2.0 access token with in-memory caching.
 * @returns {Promise<string>} Bearer access token
 */
async function getAccessToken() {
  if (!hasValidCredentials()) {
    throw new Error('PayPal Sandbox credentials missing or invalid in server/.env');
  }

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID.trim();
  const secret = process.env.PAYPAL_CLIENT_SECRET.trim();
  const authHeader = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en_US',
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal
    });

    const debugId = res.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok || !data.access_token) {
      const errorName = data.error || data.name || `HTTP_${res.status}`;
      const finalDebugId = data.debug_id || debugId;
      const err = new Error(`PayPal OAuth Failed: ${errorName}`);
      err.paypalError = errorName;
      err.debugId = finalDebugId;
      throw err;
    }

    cachedToken = data.access_token;
    tokenExpiresAt = now + ((data.expires_in || 3600) * 1000);
    return cachedToken;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Creates an order in PayPal Sandbox with intent = AUTHORIZE.
 * 
 * @param {object} params
 * @param {string} params.bookingId
 * @param {number} params.authorizedCents - Integer ceiling cents
 * @param {string} params.returnUrl
 * @param {string} params.cancelUrl
 * @param {string} [params.description]
 * @returns {Promise<{ orderId: string, approvalUrl: string, mode: string }>}
 */
async function createOrder({ bookingId, authorizedCents, returnUrl, cancelUrl, description }) {
  if (clientOverride && typeof clientOverride.createOrder === 'function') {
    return clientOverride.createOrder({ bookingId, authorizedCents, returnUrl, cancelUrl, description });
  }

  if (!hasValidCredentials()) {
    // Graceful fallback: SIMULATED mode
    const simulatedOrderId = `SIM_ORD_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const simulatedApprovalUrl = `${returnUrl}&token=${simulatedOrderId}&PayerID=SIM_PAYER_12345`;
    return {
      orderId: simulatedOrderId,
      approvalUrl: simulatedApprovalUrl,
      mode: 'SIMULATED'
    };
  }

  const token = await getAccessToken();
  const amountUsd = (authorizedCents / 100).toFixed(2);

  const payload = {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: bookingId,
        description: description || 'UniServ Cooperative Service Pre-Authorization',
        amount: {
          currency_code: 'USD',
          value: amountUsd
        }
      }
    ],
    application_context: {
      brand_name: 'UniServ Cooperative',
      locale: 'en-US',
      landing_page: 'NO_PREFERENCE',
      user_action: 'CONTINUE',
      return_url: returnUrl,
      cancel_url: cancelUrl
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SANDBOX_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `create_${bookingId}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const debugId = res.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok || !data.id) {
      const errorName = data.name || data.error || `HTTP_${res.status}`;
      const finalDebugId = data.debug_id || debugId;
      const err = new Error(`PayPal Order Creation Failed: ${errorName}`);
      err.paypalError = errorName;
      err.debugId = finalDebugId;
      throw err;
    }

    // Handle both 'approve' and 'payer-action' links
    const links = data.links || [];
    const approvalLinkObj = links.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    const approvalUrl = approvalLinkObj ? approvalLinkObj.href : null;

    if (!approvalUrl) {
      const err = new Error('PayPal Order response missing approval link');
      err.paypalError = 'MISSING_APPROVAL_URL';
      err.debugId = data.debug_id || debugId;
      throw err;
    }

    return {
      orderId: data.id,
      approvalUrl,
      mode: 'REAL_SANDBOX'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Authorizes a previously created and buyer-approved PayPal order.
 * 
 * @param {string} orderId
 * @returns {Promise<{ authorizationId: string, status: string, mode: string }>}
 */
async function authorizeOrder(orderId) {
  if (clientOverride && typeof clientOverride.authorizeOrder === 'function') {
    return clientOverride.authorizeOrder(orderId);
  }

  if (orderId && orderId.startsWith('SIM_ORD_')) {
    // Graceful fallback for SIMULATED mode
    return {
      authorizationId: `SIM_AUTH_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'CREATED',
      mode: 'SIMULATED'
    };
  }

  if (!hasValidCredentials()) {
    throw new Error('PayPal credentials missing for order authorization');
  }

  const token = await getAccessToken();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SANDBOX_BASE_URL}/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `auth_${orderId}`
      },
      body: '{}',
      signal: controller.signal
    });

    const debugId = res.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok) {
      const errorName = data.name || data.error || `HTTP_${res.status}`;
      const finalDebugId = data.debug_id || debugId;
      const err = new Error(`PayPal Authorization Failed: ${errorName}`);
      err.paypalError = errorName;
      err.debugId = finalDebugId;
      throw err;
    }

    // Extract authorization details
    const purchaseUnit = (data.purchase_units && data.purchase_units[0]) || {};
    const payments = purchaseUnit.payments || {};
    const authorizations = payments.authorizations || [];
    const primaryAuth = authorizations[0];

    if (!primaryAuth || !primaryAuth.id) {
      const err = new Error('No authorization object returned by PayPal');
      err.paypalError = 'MISSING_AUTHORIZATION';
      err.debugId = data.debug_id || debugId;
      throw err;
    }

    return {
      authorizationId: primaryAuth.id,
      status: primaryAuth.status || 'CREATED',
      mode: 'REAL_SANDBOX'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Captures an authorized PayPal payment.
 *
 * @param {object} params
 * @param {string} params.authorizationId
 * @param {string|number} params.amountUsd - String formatted to 2 decimals e.g. "1.16"
 * @returns {Promise<{ captureId: string, status: string, amount: string, mode: string }>}
 */
async function captureAuthorization({ authorizationId, amountUsd }) {
  if (clientOverride && typeof clientOverride.captureAuthorization === 'function') {
    return clientOverride.captureAuthorization({ authorizationId, amountUsd });
  }

  const formattedAmount = typeof amountUsd === 'number' ? amountUsd.toFixed(2) : String(amountUsd);

  if (authorizationId && authorizationId.startsWith('SIM_AUTH_')) {
    // Graceful fallback for SIMULATED mode
    return {
      captureId: `SIM_CAP_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'COMPLETED',
      amount: formattedAmount,
      currency: 'USD',
      mode: 'SIMULATED'
    };
  }

  if (!hasValidCredentials()) {
    throw new Error('PayPal credentials missing for authorization capture');
  }

  const token = await getAccessToken();

  const payload = {
    amount: {
      value: formattedAmount,
      currency_code: 'USD'
    },
    final_capture: true
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SANDBOX_BASE_URL}/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture_${authorizationId}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const debugId = res.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok) {
      const errorName = data.name || data.error || `HTTP_${res.status}`;
      const finalDebugId = data.debug_id || debugId;
      const err = new Error(`PayPal Capture Failed: ${errorName}`);
      err.paypalError = errorName;
      err.debugId = finalDebugId;
      throw err;
    }

    // Extract PayPal fee from seller_receivable_breakdown if present
    let rawFee = null;
    if (data.seller_receivable_breakdown?.paypal_fee?.value) {
      rawFee = data.seller_receivable_breakdown.paypal_fee.value;
    } else if (typeof data.seller_receivable_breakdown?.paypal_fee === 'string') {
      rawFee = data.seller_receivable_breakdown.paypal_fee;
    } else if (data.purchase_units?.[0]?.payments?.captures?.[0]?.seller_receivable_breakdown?.paypal_fee?.value) {
      rawFee = data.purchase_units[0].payments.captures[0].seller_receivable_breakdown.paypal_fee.value;
    }

    const parsedFeeNum = rawFee !== null && rawFee !== undefined && rawFee !== '' ? Number(rawFee) : NaN;
    const paypalFeeUsd = (!isNaN(parsedFeeNum) && parsedFeeNum > 0)
      ? parsedFeeNum.toFixed(2)
      : null;

    return {
      captureId: data.id,
      status: data.status || 'COMPLETED',
      amount: data.amount ? data.amount.value : formattedAmount,
      currency: data.amount ? data.amount.currency_code : 'USD',
      paypalFeeUsd,
      mode: 'REAL_SANDBOX'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Creates a payout batch in PayPal Sandbox.
 *
 * @param {object} params
 * @param {string} params.senderBatchId - Unique deterministic ID (e.g. payout_<captureId>)
 * @param {Array<object>} params.items - List of payout items
 * @param {string} [params.emailSubject]
 * @param {string} [params.emailMessage]
 * @returns {Promise<{ payoutBatchId: string, batchStatus: string, timeCreated: string, mode: string }>}
 */
async function createPayoutBatch({ senderBatchId, items, emailSubject, emailMessage }) {
  if (clientOverride && typeof clientOverride.createPayoutBatch === 'function') {
    return clientOverride.createPayoutBatch({ senderBatchId, items, emailSubject, emailMessage });
  }

  if (!hasValidCredentials()) {
    throw new Error('PayPal Sandbox credentials missing for payouts');
  }

  const token = await getAccessToken();

  const formattedItems = (items || []).map((it) => ({
    recipient_type: 'EMAIL',
    amount: {
      value: typeof it.amountUsd === 'number' ? it.amountUsd.toFixed(2) : String(it.amountUsd),
      currency: 'USD'
    },
    receiver: it.receiver,
    note: it.note || 'UniServ Cooperative Earnings Settlement',
    sender_item_id: it.senderItemId
  }));

  const payload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: emailSubject || 'UniServ Cooperative Settlement Distribution',
      email_message: emailMessage || 'You have received your cooperative settlement earnings from UniServ.'
    },
    items: formattedItems
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SANDBOX_BASE_URL}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': senderBatchId
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const debugId = res.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok) {
      const errorName = data.name || data.error || `HTTP_${res.status}`;
      const finalDebugId = data.debug_id || debugId;
      const err = new Error(`PayPal Payout Batch Failed: ${errorName}`);
      err.paypalError = errorName;
      err.debugId = finalDebugId;
      throw err;
    }

    const batchHeader = data.batch_header || {};
    return {
      payoutBatchId: batchHeader.payout_batch_id,
      batchStatus: batchHeader.batch_status || 'PENDING',
      timeCreated: batchHeader.time_created,
      mode: 'REAL_SANDBOX'
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      err.isTimeout = true;
      err.paypalError = 'TIMEOUT';
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retrieves details and item statuses for a payout batch.
 *
 * @param {string} payoutBatchId
 * @returns {Promise<object>} Batch header and items
 */
async function getPayoutBatch(payoutBatchId) {
  if (clientOverride && typeof clientOverride.getPayoutBatch === 'function') {
    return clientOverride.getPayoutBatch(payoutBatchId);
  }

  if (!hasValidCredentials()) {
    throw new Error('PayPal Sandbox credentials missing for payout status lookup');
  }

  const token = await getAccessToken();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${SANDBOX_BASE_URL}/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      signal: controller.signal
    });

    const debugId = res.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok) {
      const errorName = data.name || data.error || `HTTP_${res.status}`;
      const finalDebugId = data.debug_id || debugId;
      const err = new Error(`PayPal Payout Status Failed: ${errorName}`);
      err.paypalError = errorName;
      err.debugId = finalDebugId;
      throw err;
    }

    return {
      batchHeader: data.batch_header || {},
      items: data.items || [],
      links: data.links || [],
      mode: 'REAL_SANDBOX'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  hasValidCredentials,
  getAccessToken,
  createOrder,
  authorizeOrder,
  captureAuthorization,
  createPayoutBatch,
  getPayoutBatch,
  setClientOverride,
  resetClientOverride
};
