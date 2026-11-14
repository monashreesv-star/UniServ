/**
 * ============================================================================
 * PayPal Sandbox OAuth Smoke Test
 * ============================================================================
 * Verifies sandbox credentials by requesting an OAuth 2.0 client token.
 * 
 * SECURITY RULES:
 * - Refuses to run unless PAYPAL_ENVIRONMENT is strictly "sandbox".
 * - Never prints, logs, or transmits secrets, tokens, or credentials.
 * - Prints only "OK" on success, or the PayPal error name and debug_id on failure.
 * - Sets process.exitCode instead of calling process.exit() to allow clean
 *   handle shutdown on Windows.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

async function main() {
  // 1. Load server/.env file
  const envPath = path.resolve(__dirname, '../.env');

  if (!fs.existsSync(envPath)) {
    console.error('Error: server/.env file not found.');
    console.error('Please create server/.env by copying server/.env.example and filling in your credentials.');
    process.exitCode = 1;
    return;
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const rawEnv = {};

  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1); // raw value before trimming
      rawEnv[key] = val;
      process.env[key] = val.trim();
    }
  }

  // 2. Safety Gate: Refuse to run unless PAYPAL_ENVIRONMENT strictly equals "sandbox"
  const environment = (process.env.PAYPAL_ENVIRONMENT || '').trim();
  if (environment !== 'sandbox') {
    console.error('Error: PAYPAL_ENVIRONMENT must be strictly set to "sandbox".');
    console.error(`Current setting: "${environment || '<empty>'}"`);
    console.error('Smoke test aborted to prevent non-sandbox API calls.');
    process.exitCode = 1;
    return;
  }

  // 3. Validate required credentials and emails are present
  const requiredVars = [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_RECEIVER_ARTISAN_EMAIL',
    'PAYPAL_RECEIVER_WELFARE_EMAIL',
    'PAYPAL_RECEIVER_RESERVE_EMAIL'
  ];

  const missingVars = [];
  for (const varName of requiredVars) {
    const val = process.env[varName];
    if (!val || val.length === 0) {
      missingVars.push(varName);
    }
  }

  if (missingVars.length > 0) {
    console.error('Error: Missing required environment variable(s):');
    for (const name of missingVars) {
      console.error(`  - ${name}`);
    }
    console.error('Please define these in server/.env.');
    process.exitCode = 1;
    return;
  }

  // 4. Warn if any variable starts or ends with a quote or a space
  for (const varName of requiredVars) {
    const rawVal = rawEnv[varName] || '';
    if (rawVal.startsWith(' ') || rawVal.endsWith(' ') ||
        rawVal.startsWith('\t') || rawVal.endsWith('\t') ||
        rawVal.startsWith('"') || rawVal.endsWith('"') ||
        rawVal.startsWith("'") || rawVal.endsWith("'")) {
      console.warn(`Warning: Environment variable "${varName}" starts or ends with a quote or space.`);
      console.warn('  Ensure quotes or spaces are not included unintentionally in server/.env.');
    }
  }

  // 5. Execute PayPal Sandbox OAuth Token Request with AbortController timeout
  const clientId = process.env.PAYPAL_CLIENT_ID.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET.trim();
  const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  const sandboxOAuthUrl = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(sandboxOAuthUrl, {
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

    const debugId = response.headers.get('paypal-debug-id') || 'none';
    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      // response may not be JSON
    }

    if (response.ok && data.access_token) {
      console.log('OK');
      process.exitCode = 0;
    } else {
      const errorName = data.error || data.name || data.message || `HTTP_${response.status}`;
      const finalDebugId = data.debug_id || debugId;
      console.error(`PayPal Error: ${errorName}`);
      console.error(`Debug ID: ${finalDebugId}`);
      process.exitCode = 1;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Network / Connection Error: Request timed out after 15 seconds');
    } else {
      console.error(`Network / Connection Error: ${err.message || 'Failed to reach PayPal Sandbox endpoint'}`);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutId);
  }
}

main();
