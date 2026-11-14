/**
 * ============================================================================
 * Gemini API Connectivity & Diagnostics Smoke Test (Stage 4.0c)
 * ============================================================================
 * Reads GEMINI_API_KEY and GEMINI_MODEL from server/.env.
 *
 * DIAGNOSTICS SUITE:
 *  Step 1: Models Discovery (GET /v1beta/models?pageSize=100)
 *          Verifies key validity, DNS, connectivity, and reports if
 *          GEMINI_MODEL is found in the account's accessible model catalog.
 *  Step 2: Generation Variants Comparison for GEMINI_MODEL:
 *          (a) no generationConfig at all
 *          (b) thinkingBudget: 0
 *          (c) thinking level setting from official docs ("minimal" or "low")
 *          (d) maxOutputTokens: 64 only
 *          (e) streamGenerateContent with alt=sse (reports TTFB)
 *
 * SAFETY & RUNTIME CONSTRAINTS:
 *  - 30-second AbortController timeout per generation variant.
 *  - Distinguishes DNS, connection timeout, reset, and read timeout.
 *  - Never prints URLs containing keys.
 *  - Never prints the API key or model response text.
 *  - Prints one summary line per variant.
 *  - Outputs "RECOMMENDED VARIANT: <letter>" for the first normal answer.
 *  - Strictly sets process.exitCode (never calls process.exit()).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Formats low-level fetch/undici network errors without leaking URLs or keys.
 * @param {Error} err
 * @param {number} elapsedMs
 * @param {number} timeoutLimitMs
 * @returns {{ type: string, detail: string, code: string }}
 */
function formatNetworkError(err, elapsedMs, timeoutLimitMs = 30000) {
  const causeCode = err?.cause?.code || err?.code || null;
  const isAbort = err?.name === 'AbortError' || err?.message?.toLowerCase().includes('aborted');

  if (isAbort && elapsedMs >= timeoutLimitMs - 1500) {
    return {
      type: 'READ_TIMEOUT',
      detail: `Connected but no response within ${Math.round(timeoutLimitMs / 1000)}s`,
      code: 'UND_ERR_HEADERS_TIMEOUT'
    };
  }

  if (causeCode === 'ENOTFOUND') {
    return {
      type: 'DNS_FAILURE',
      detail: 'DNS resolution failed (host not found)',
      code: causeCode
    };
  }

  if (causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'ETIMEDOUT') {
    return {
      type: 'CONNECT_TIMEOUT',
      detail: 'TCP connection timed out',
      code: causeCode
    };
  }

  if (causeCode === 'ECONNRESET') {
    return {
      type: 'CONNECTION_RESET',
      detail: 'Connection reset by peer',
      code: causeCode
    };
  }

  if (causeCode === 'ECONNREFUSED') {
    return {
      type: 'CONNECTION_REFUSED',
      detail: 'Connection refused by peer',
      code: causeCode
    };
  }

  return {
    type: isAbort ? 'ABORTED' : 'NETWORK_ERROR',
    detail: err?.name || 'Request failed',
    code: causeCode || 'UNKNOWN'
  };
}

/**
 * Runs a unary generateContent request with timeout.
 */
async function runUnaryVariant(variant, endpoint, apiKey, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  let status = 0;
  let elapsedMs = 0;
  let finishReason = 'NONE';
  let empty = 'YES';
  let isNormal = false;
  let errMsg = null;
  let detailsFields = null;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(variant.payload),
      signal: controller.signal
    });

    elapsedMs = Date.now() - start;
    status = res.status;

    let data = {};
    try {
      data = await res.json();
    } catch (e) {}

    if (res.ok) {
      const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
      finishReason = candidate?.finishReason || 'UNKNOWN';

      let hasText = false;
      if (candidate?.content?.parts) {
        for (const p of candidate.content.parts) {
          if (p.text && p.text.trim().length > 0) {
            hasText = true;
            break;
          }
        }
      }

      empty = hasText ? 'NO' : 'YES';
      if (hasText && (finishReason === 'STOP' || finishReason === 'MAX_TOKENS')) {
        isNormal = true;
      }
    } else {
      finishReason = data.error?.status || `HTTP_${res.status}`;
      errMsg = data.error?.message ? String(data.error.message).replaceAll(apiKey, '[REDACTED]') : 'none';
      if (Array.isArray(data.error?.details) && data.error.details.length > 0) {
        detailsFields = data.error.details
          .map((d) => {
            const type = d['@type'] ? d['@type'].split('.').pop() : 'detail';
            const keys = Object.keys(d).filter((k) => k !== '@type');
            return `${type}(${keys.join(',')})`;
          })
          .join('; ');
      }
    }
  } catch (err) {
    elapsedMs = Date.now() - start;
    const netErr = formatNetworkError(err, elapsedMs, timeoutMs);
    status = 0;
    finishReason = netErr.code;
    errMsg = netErr.detail;
  } finally {
    clearTimeout(timeoutId);
  }

  return {
    letter: variant.letter,
    name: variant.name,
    status,
    elapsedMs,
    finishReason,
    empty,
    isNormal,
    errMsg,
    detailsFields
  };
}

/**
 * Runs a streaming streamGenerateContent request with alt=sse and reports TTFB.
 */
async function runSseVariant(variant, endpoint, apiKey, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  let status = 0;
  let elapsedMs = 0;
  let ttfbMs = null;
  let finishReason = 'NONE';
  let empty = 'YES';
  let isNormal = false;
  let errMsg = null;
  let detailsFields = null;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(variant.payload),
      signal: controller.signal
    });

    status = res.status;

    if (!res.ok) {
      elapsedMs = Date.now() - start;
      let data = {};
      try {
        data = await res.json();
      } catch (e) {}
      finishReason = data.error?.status || `HTTP_${res.status}`;
      errMsg = data.error?.message ? String(data.error.message).replaceAll(apiKey, '[REDACTED]') : 'none';
      if (Array.isArray(data.error?.details) && data.error.details.length > 0) {
        detailsFields = data.error.details
          .map((d) => {
            const type = d['@type'] ? d['@type'].split('.').pop() : 'detail';
            const keys = Object.keys(d).filter((k) => k !== '@type');
            return `${type}(${keys.join(',')})`;
          })
          .join('; ');
      }
    } else {
      let buffer = '';
      let hasText = false;
      const reader = res.body?.getReader();

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttfbMs === null && value && value.length > 0) {
              ttfbMs = Date.now() - start;
            }
            buffer += Buffer.from(value).toString('utf8');
          }
        } finally {
          try {
            await reader.cancel();
          } catch (e) {}
        }
      }

      elapsedMs = Date.now() - start;
      if (ttfbMs === null) {
        ttfbMs = elapsedMs;
      }

      // Parse SSE lines
      for (const line of buffer.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr) {
            try {
              const parsed = JSON.parse(jsonStr);
              const candidates = parsed.candidates || [];
              if (candidates[0]) {
                if (candidates[0].finishReason) {
                  finishReason = candidates[0].finishReason;
                }
                if (candidates[0].content?.parts) {
                  for (const p of candidates[0].content.parts) {
                    if (p.text && p.text.trim().length > 0) {
                      hasText = true;
                    }
                  }
                }
              }
            } catch (e) {}
          }
        }
      }

      empty = hasText ? 'NO' : 'YES';
      if (hasText && (finishReason === 'STOP' || finishReason === 'MAX_TOKENS')) {
        isNormal = true;
      }
    }
  } catch (err) {
    elapsedMs = Date.now() - start;
    const netErr = formatNetworkError(err, elapsedMs, timeoutMs);
    status = 0;
    finishReason = netErr.code;
    errMsg = netErr.detail;
  } finally {
    clearTimeout(timeoutId);
  }

  return {
    letter: variant.letter,
    name: variant.name,
    status,
    elapsedMs,
    ttfbMs,
    finishReason,
    empty,
    isNormal,
    errMsg,
    detailsFields
  };
}

async function main() {
  const envPath = path.resolve(__dirname, '../.env');

  // Load server/.env file
  if (!fs.existsSync(envPath)) {
    console.error('Missing required file: server/.env');
    process.exitCode = 1;
    return;
  }

  dotenv.config({ path: envPath });

  // Fallback manual parser to ensure variables with quotes or spaces are properly loaded
  try {
    const rawContent = fs.readFileSync(envPath, 'utf8');
    for (const line of rawContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1).trim();
        }
        if (!process.env[key] || process.env[key].trim() === '') {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.error('Error reading server/.env');
    process.exitCode = 1;
    return;
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const model = (process.env.GEMINI_MODEL || '').trim();

  // Validate required variables
  const missingVars = [];
  if (!apiKey) {
    missingVars.push('GEMINI_API_KEY');
  }
  if (!model) {
    missingVars.push('GEMINI_MODEL');
  }

  if (missingVars.length > 0) {
    for (const name of missingVars) {
      console.error(`Missing required variable: ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  // --------------------------------------------------------------------------
  // STEP 1: Models Discovery (GET /v1beta/models?pageSize=100)
  // --------------------------------------------------------------------------
  console.log('[Step 1] Checking API key and model catalog via GET /v1beta/models...');
  const listEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
  const listController = new AbortController();
  const listTimeout = setTimeout(() => listController.abort(), 60000);
  const listStart = Date.now();

  try {
    const listRes = await fetch(listEndpoint, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey
      },
      signal: listController.signal
    });

    const listElapsedMs = Date.now() - listStart;
    const listRequestId =
      listRes.headers.get('x-goog-request-id') ||
      listRes.headers.get('x-request-id') ||
      'none';

    let listData = {};
    try {
      listData = await listRes.json();
    } catch (e) {}

    console.log(`  Elapsed: ${listElapsedMs}ms, HTTP Status: ${listRes.status}, Request ID: ${listRequestId}`);

    if (listRes.ok) {
      const models = Array.isArray(listData.models) ? listData.models : [];
      const targetModelNorm = model.toLowerCase().replace(/^models\//, '');
      const modelFound = models.some((m) => {
        const rawName = (m.name || '').toLowerCase();
        const stripped = rawName.replace(/^models\//, '');
        return stripped === targetModelNorm || rawName === targetModelNorm;
      });

      console.log(`  Models returned: ${models.length}, Model "${model}" found: ${modelFound ? 'YES' : 'NO'}`);
    } else {
      const errorName = listData.error?.status || listData.error?.message || `HTTP_${listRes.status}`;
      console.error(`  Error: ${errorName}`);
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    const listElapsedMs = Date.now() - listStart;
    const errInfo = formatNetworkError(err, listElapsedMs, 60000);
    console.error(`  Elapsed: ${listElapsedMs}ms, Error: ${errInfo.type} (${errInfo.detail}), Code: ${errInfo.code}`);
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(listTimeout);
  }

  // --------------------------------------------------------------------------
  // STEP 2: Generation Variants Comparison for GEMINI_MODEL
  // --------------------------------------------------------------------------
  const cleanModel = model.replace(/^models\//, '');
  const modelLower = cleanModel.toLowerCase();
  // gemini-3.5-flash-lite supports 'minimal', gemini-3.8-flash supports 'low' ('minimal' is unsupported on 3.8)
  const docThinkingLevel = modelLower.includes('lite') || modelLower.includes('3.5') ? 'minimal' : 'low';

  console.log(`\n[Step 2] Testing generation variants for model "${cleanModel}" (30s timeout per variant):`);

  const unaryEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
  const sseEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:streamGenerateContent?alt=sse`;

  const variants = [
    {
      letter: 'a',
      name: 'no generationConfig at all',
      type: 'unary',
      payload: {
        contents: [{ parts: [{ text: 'ping' }] }]
      }
    },
    {
      letter: 'b',
      name: 'thinkingBudget: 0',
      type: 'unary',
      payload: {
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: {
          thinkingConfig: {
            thinkingBudget: 0
          }
        }
      }
    },
    {
      letter: 'c',
      name: `thinkingLevel: "${docThinkingLevel}"`,
      type: 'unary',
      payload: {
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: docThinkingLevel
          }
        }
      }
    },
    {
      letter: 'd',
      name: 'maxOutputTokens 64 only',
      type: 'unary',
      payload: {
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: {
          maxOutputTokens: 64
        }
      }
    },
    {
      letter: 'e',
      name: 'streamGenerateContent (alt=sse)',
      type: 'sse',
      payload: {
        contents: [{ parts: [{ text: 'ping' }] }]
      }
    }
  ];

  const results = [];

  for (const variant of variants) {
    let res;
    if (variant.type === 'sse') {
      res = await runSseVariant(variant, sseEndpoint, apiKey, 30000);
    } else {
      res = await runUnaryVariant(variant, unaryEndpoint, apiKey, 30000);
    }
    results.push(res);

    // Format single summary line
    let summary = `(${res.letter}) ${res.name}: HTTP ${res.status}, elapsed ${res.elapsedMs}ms`;
    if (res.ttfbMs !== undefined && res.ttfbMs !== null) {
      summary += `, ttfb ${res.ttfbMs}ms`;
    }
    summary += `, finishReason ${res.finishReason}, empty ${res.empty}`;

    if (res.status === 400 || res.status >= 400) {
      if (res.errMsg) {
        summary += `, error.message: "${res.errMsg}"`;
      }
      if (res.detailsFields) {
        summary += `, error.details: [${res.detailsFields}]`;
      }
    } else if (res.status === 0 && res.errMsg) {
      summary += `, error: ${res.errMsg}`;
    }

    console.log(summary);
  }

  // Find first variant that returned a normal answer
  const recommended = results.find((r) => r.isNormal);

  if (recommended) {
    console.log(`\nRECOMMENDED VARIANT: ${recommended.letter}`);
  } else {
    console.log('\nRECOMMENDED VARIANT: none');
  }

  // Stage 4.1a: Model Capability Tests
  try {
    const { runCapabilityTest } = require('./geminiCapabilityTest');
    const capOk = await runCapabilityTest();
    process.exitCode = (recommended && capOk) ? 0 : 1;
  } catch (ce) {
    console.error('Failed to run capability tests:', ce?.message || ce);
    process.exitCode = 1;
  }
}

main();
