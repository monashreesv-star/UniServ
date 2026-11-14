/**
 * ============================================================================
 * Gemini Model Capability Test (Stage 4.1a)
 * ============================================================================
 * Tests the active GEMINI_MODEL for three core capabilities required for
 * UniServ AI agents (Phase 4 Triage and Phase 5 Settlement):
 *
 *  (i)   Structured Output: generateContent with responseMimeType "application/json"
 *        and responseSchema (the triage schema) on a text-only prompt.
 *  (ii)  Multimodal: Small inline JPEG image (generated in code) + text prompt
 *        together with the triage schema.
 *  (iii) Function Calling: One tool declaration (capture_payment with amount and
 *        bookingId fields) and a prompt to trigger it.
 *
 * SAFETY & RUNTIME CONSTRAINTS:
 *  - 30-second AbortController timeout per check.
 *  - Distinguishes network errors and HTTP error statuses.
 *  - Prints ONE summary line per check.
 *  - NEVER prints the API key (sanitizes error messages).
 *  - NEVER prints model response text.
 *  - Strictly sets process.exitCode (never calls process.exit()).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Valid minimal 1x1 JPEG image (171 bytes) with correct SOI (ffd8) and EOI (ffd9).
 */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDD/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AHtA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/Z';

/**
 * Formats low-level fetch/undici network errors without leaking URLs or keys.
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
 * Validates parsed JSON against the UniServ Triage Schema.
 */
function validateTriageSchema(parsed, allowedTradeIds) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'output is not an object' };
  }
  if (!parsed.trade_id || !allowedTradeIds.includes(parsed.trade_id)) {
    return { ok: false, reason: `invalid or unknown trade_id: "${parsed.trade_id}"` };
  }
  const urgency = String(parsed.urgency || '').toLowerCase();
  if (!['low', 'medium', 'high', 'emergency'].includes(urgency)) {
    return { ok: false, reason: `invalid urgency: "${parsed.urgency}"` };
  }
  if (!Array.isArray(parsed.likely_parts)) {
    return { ok: false, reason: 'likely_parts is not an array' };
  }
  if (
    !parsed.price_range_inr ||
    typeof parsed.price_range_inr.min !== 'number' ||
    typeof parsed.price_range_inr.max !== 'number'
  ) {
    return { ok: false, reason: 'price_range_inr missing numeric min/max' };
  }
  if (typeof parsed.english_dispatch_summary !== 'string' || !parsed.english_dispatch_summary.trim()) {
    return { ok: false, reason: 'missing english_dispatch_summary' };
  }
  if (typeof parsed.customer_language_summary !== 'string' || !parsed.customer_language_summary.trim()) {
    return { ok: false, reason: 'missing customer_language_summary' };
  }
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
    return { ok: false, reason: 'confidence must be a number between 0.0 and 1.0' };
  }
  if (
    !parsed.safety_flag ||
    typeof parsed.safety_flag.flag !== 'boolean' ||
    typeof parsed.safety_flag.reason !== 'string'
  ) {
    return { ok: false, reason: 'safety_flag missing boolean flag or string reason' };
  }
  return { ok: true, reason: null };
}

/**
 * Loads allowed trade IDs dynamically from src/data/services.json.
 */
function loadAllowedTradeIds() {
  const servicesPath = path.resolve(__dirname, '../../src/data/services.json');
  try {
    if (fs.existsSync(servicesPath)) {
      const svcs = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
      if (Array.isArray(svcs) && svcs.length > 0) {
        return svcs.map((s) => s.id);
      }
    }
  } catch (e) {}
  return ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];
}

/**
 * Builds the strict responseSchema for the triage agent.
 */
function buildTriageResponseSchema(allowedTradeIds) {
  return {
    type: 'OBJECT',
    properties: {
      trade_id: {
        type: 'STRING',
        description: 'Recommended cooperative trade service ID',
        enum: allowedTradeIds
      },
      urgency: {
        type: 'STRING',
        description: 'Urgency assessment of the issue',
        enum: ['low', 'medium', 'high', 'emergency']
      },
      likely_parts: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Estimated replacement parts or materials needed'
      },
      price_range_inr: {
        type: 'OBJECT',
        properties: {
          min: { type: 'NUMBER', description: 'Minimum indicative price in INR' },
          max: { type: 'NUMBER', description: 'Maximum indicative price in INR' }
        },
        required: ['min', 'max']
      },
      english_dispatch_summary: {
        type: 'STRING',
        description: 'Worker dispatch summary in English (max 280 characters)'
      },
      customer_language_summary: {
        type: 'STRING',
        description: 'Summary in customer language'
      },
      confidence: {
        type: 'NUMBER',
        description: 'Confidence score from 0.0 to 1.0'
      },
      safety_flag: {
        type: 'OBJECT',
        properties: {
          flag: { type: 'BOOLEAN', description: 'Whether safety caution is advised' },
          reason: { type: 'STRING', description: 'Safety guidance or precaution' }
        },
        required: ['flag', 'reason']
      }
    },
    required: [
      'trade_id',
      'urgency',
      'likely_parts',
      'price_range_inr',
      'english_dispatch_summary',
      'customer_language_summary',
      'confidence',
      'safety_flag'
    ]
  };
}

async function runCapabilityTest() {
  const envPath = path.resolve(__dirname, '../.env');

  if (!fs.existsSync(envPath)) {
    console.error('Missing required file: server/.env');
    process.exitCode = 1;
    return false;
  }

  dotenv.config({ path: envPath });

  // Fallback manual parser to load variables with quotes/newlines
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
    return false;
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const model = (process.env.GEMINI_MODEL || '').trim();

  const missingVars = [];
  if (!apiKey) missingVars.push('GEMINI_API_KEY');
  if (!model) missingVars.push('GEMINI_MODEL');

  if (missingVars.length > 0) {
    for (const name of missingVars) {
      console.error(`Missing required variable: ${name}`);
    }
    process.exitCode = 1;
    return false;
  }

  const cleanModel = model.replace(/^models\//, '');
  const allowedTradeIds = loadAllowedTradeIds();
  const triageSchema = buildTriageResponseSchema(allowedTradeIds);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;

  console.log(`\n============================================================================`);
  console.log(` Gemini Capability Test Suite (Stage 4.1a)`);
  console.log(` Model: ${cleanModel} (no thinkingConfig)`);
  console.log(` Allowed Trade IDs: ${allowedTradeIds.join(', ')}`);
  console.log(`============================================================================\n`);

  let allPassed = true;

  // --------------------------------------------------------------------------
  // Check (i): Structured Output (Text-Only + Triage Schema)
  // --------------------------------------------------------------------------
  {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const start = Date.now();
    let status = 0;
    let elapsedMs = 0;
    let jsonParseOk = false;
    let schemaValidOk = false;
    let schemaReason = null;
    let errMsg = null;
    let detailsFields = null;

    const payload = {
      contents: [
        {
          parts: [
            {
              text: 'Customer request: The kitchen sink pipe has burst underneath and water is spraying across the tiles. I need an artisan to inspect the pipe, replace the valve washer, and stop the leak. Customer language: English.'
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: triageSchema
      }
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      elapsedMs = Date.now() - start;
      status = res.status;

      let data = {};
      try {
        data = await res.json();
      } catch (e) {}

      if (res.ok) {
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          try {
            const parsed = JSON.parse(text);
            jsonParseOk = true;
            const val = validateTriageSchema(parsed, allowedTradeIds);
            schemaValidOk = val.ok;
            schemaReason = val.reason;
          } catch (pe) {
            jsonParseOk = false;
            schemaReason = 'JSON.parse error';
          }
        } else {
          schemaReason = 'no text in candidate part';
        }
      } else {
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
      const netErr = formatNetworkError(err, elapsedMs, 30000);
      status = 0;
      errMsg = `${netErr.type}: ${netErr.detail}`;
    } finally {
      clearTimeout(timeoutId);
    }

    let summary = `(i) structured output: HTTP ${status}, elapsed ${elapsedMs}ms, JSON parse: ${jsonParseOk ? 'YES' : 'NO'}, schema valid: ${schemaValidOk ? 'YES' : 'NO'}`;
    if (schemaReason && !schemaValidOk) {
      summary += ` (${schemaReason})`;
    }
    if (status >= 400 && errMsg) {
      summary += `, error.message: "${errMsg}"`;
      if (detailsFields) summary += `, details: [${detailsFields}]`;
    } else if (status === 0 && errMsg) {
      summary += `, error: ${errMsg}`;
    }

    console.log(summary);
    if (!jsonParseOk || !schemaValidOk) allPassed = false;
  }

  // --------------------------------------------------------------------------
  // Check (ii): Multimodal (Inline JPEG + Text Prompt + Triage Schema)
  // --------------------------------------------------------------------------
  {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const start = Date.now();
    let status = 0;
    let elapsedMs = 0;
    let jsonParseOk = false;
    let schemaValidOk = false;
    let schemaReason = null;
    let errMsg = null;
    let detailsFields = null;

    const payload = {
      contents: [
        {
          parts: [
            {
              text: 'Customer request: Here is a photo of the plumbing leakage under the kitchen counter. Identify the required service trade and summarize the dispatch issue. Customer language: English.'
            },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: TINY_JPEG_BASE64
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: triageSchema
      }
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      elapsedMs = Date.now() - start;
      status = res.status;

      let data = {};
      try {
        data = await res.json();
      } catch (e) {}

      if (res.ok) {
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          try {
            const parsed = JSON.parse(text);
            jsonParseOk = true;
            const val = validateTriageSchema(parsed, allowedTradeIds);
            schemaValidOk = val.ok;
            schemaReason = val.reason;
          } catch (pe) {
            jsonParseOk = false;
            schemaReason = 'JSON.parse error';
          }
        } else {
          schemaReason = 'no text in candidate part';
        }
      } else {
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
      const netErr = formatNetworkError(err, elapsedMs, 30000);
      status = 0;
      errMsg = `${netErr.type}: ${netErr.detail}`;
    } finally {
      clearTimeout(timeoutId);
    }

    let summary = `(ii) multimodal: HTTP ${status}, elapsed ${elapsedMs}ms, JSON parse: ${jsonParseOk ? 'YES' : 'NO'}, schema valid: ${schemaValidOk ? 'YES' : 'NO'}`;
    if (schemaReason && !schemaValidOk) {
      summary += ` (${schemaReason})`;
    }
    if (status >= 400 && errMsg) {
      summary += `, error.message: "${errMsg}"`;
      if (detailsFields) summary += `, details: [${detailsFields}]`;
    } else if (status === 0 && errMsg) {
      summary += `, error: ${errMsg}`;
    }

    console.log(summary);
    if (!jsonParseOk || !schemaValidOk) allPassed = false;
  }

  // --------------------------------------------------------------------------
  // Check (iii): Function Calling (Tools Declaration + Capture Trigger)
  // --------------------------------------------------------------------------
  {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const start = Date.now();
    let status = 0;
    let elapsedMs = 0;
    let fcParsedOk = false;
    let fcDetail = 'NO';
    let errMsg = null;
    let detailsFields = null;

    const payload = {
      contents: [
        {
          parts: [
            {
              text: 'The artisan has verified the completion OTP and the job is finished. Call the capture_payment function immediately for booking "BK_9901" with amount 1450.'
            }
          ]
        }
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'capture_payment',
              description: 'Captures authorized funds for a completed booking',
              parameters: {
                type: 'OBJECT',
                properties: {
                  bookingId: {
                    type: 'STRING',
                    description: 'The UniServ booking ID'
                  },
                  amount: {
                    type: 'NUMBER',
                    description: 'Final bill amount in INR'
                  }
                },
                required: ['bookingId', 'amount']
              }
            }
          ]
        }
      ]
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      elapsedMs = Date.now() - start;
      status = res.status;

      let data = {};
      try {
        data = await res.json();
      } catch (e) {}

      if (res.ok) {
        const parts = data.candidates?.[0]?.content?.parts || [];
        const fcPart = parts.find((p) => p.functionCall);
        if (fcPart && fcPart.functionCall) {
          const fnName = fcPart.functionCall.name;
          const fnArgs = fcPart.functionCall.args || {};
          if (fnName === 'capture_payment') {
            fcParsedOk = true;
            fcDetail = `YES (name: ${fnName}, args: ${JSON.stringify(fnArgs)})`;
          } else {
            fcDetail = `YES (unexpected name: ${fnName})`;
          }
        } else {
          fcDetail = 'NO (model returned plain text)';
        }
      } else {
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
      const netErr = formatNetworkError(err, elapsedMs, 30000);
      status = 0;
      errMsg = `${netErr.type}: ${netErr.detail}`;
    } finally {
      clearTimeout(timeoutId);
    }

    let summary = `(iii) function calling: HTTP ${status}, elapsed ${elapsedMs}ms, functionCall: ${fcDetail}`;
    if (status >= 400 && errMsg) {
      summary += `, error.message: "${errMsg}"`;
      if (detailsFields) summary += `, details: [${detailsFields}]`;
    } else if (status === 0 && errMsg) {
      summary += `, error: ${errMsg}`;
    }

    console.log(summary);
    if (!fcParsedOk) allPassed = false;
  }

  // --------------------------------------------------------------------------
  // Summary & Process Exit Code
  // --------------------------------------------------------------------------
  console.log('');
  if (allPassed) {
    console.log('ALL CAPABILITY CHECKS PASSED');
    process.exitCode = 0;
    return true;
  } else {
    console.log('CAPABILITY CHECKS FAILED');
    process.exitCode = 1;
    return false;
  }
}

if (require.main === module) {
  runCapabilityTest();
}

module.exports = { runCapabilityTest };
