/**
 * ============================================================================
 * UniServ Stage 6.2 AG Grid Community Integration Test Suite
 * ============================================================================
 * Verifies:
 *  1. Vendored Asset Integrity: All required AG Grid Community v36.3.0
 *     UMD, CSS, and LICENSE files exist locally in server/public/vendor/ag-grid/
 *     with appropriate non-zero file sizes.
 *  2. Licensing & Notices: THIRD_PARTY_NOTICES.md exists and documents
 *     AG Grid Community (MIT License, AG GRID LTD).
 *  3. HTML Shell & Fallback Structure: ledger.html includes the vendored
 *     scripts/styles, the "Powered by AG Grid Community" attribution, and
 *     the plain table fallback container.
 *  4. Strict XSS Invariant: ledger.js contains ZERO occurrences of .innerHTML,
 *     rendering strictly via textContent and DOM nodes.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT_DIR, 'server', 'public', 'vendor', 'ag-grid');
const LEDGER_HTML = path.join(ROOT_DIR, 'server', 'public', 'ledger.html');
const LEDGER_JS = path.join(ROOT_DIR, 'server', 'public', 'ledger.js');
const THIRD_PARTY_FILE = path.join(ROOT_DIR, 'THIRD_PARTY_NOTICES.md');

// ----------------------------------------------------------------------------
// Test 1: Vendored Assets Verification
// ----------------------------------------------------------------------------
test('Test 1: Vendored AG Grid Community assets exist on disk', () => {
  const jsFile = path.join(VENDOR_DIR, 'ag-grid-community.min.js');
  const cssFile = path.join(VENDOR_DIR, 'ag-grid.min.css');
  const themeFile = path.join(VENDOR_DIR, 'ag-theme-quartz.min.css');
  const licenseFile = path.join(VENDOR_DIR, 'LICENSE.txt');

  assert.ok(fs.existsSync(jsFile), 'ag-grid-community.min.js must exist');
  assert.ok(fs.existsSync(cssFile), 'ag-grid.min.css must exist');
  assert.ok(fs.existsSync(themeFile), 'ag-theme-quartz.min.css must exist');
  assert.ok(fs.existsSync(licenseFile), 'LICENSE.txt must exist');

  const jsSize = fs.statSync(jsFile).size;
  const licenseText = fs.readFileSync(licenseFile, 'utf8');

  // Verify UMD bundle size is plausible (> 1 MB)
  assert.ok(jsSize > 1000000, `ag-grid-community.min.js is ${jsSize} bytes, expected > 1MB`);

  // Verify license text contains MIT
  assert.ok(licenseText.includes('The MIT License'), 'LICENSE.txt must be MIT license');
  assert.ok(licenseText.includes('AG GRID LTD'), 'LICENSE.txt must mention AG GRID LTD');
});

// ----------------------------------------------------------------------------
// Test 2: Third Party Notices Documentation
// ----------------------------------------------------------------------------
test('Test 2: THIRD_PARTY_NOTICES.md exists and contains AG Grid notice', () => {
  assert.ok(fs.existsSync(THIRD_PARTY_FILE), 'THIRD_PARTY_NOTICES.md must exist');
  const content = fs.readFileSync(THIRD_PARTY_FILE, 'utf8');

  assert.ok(content.includes('AG Grid Community'), 'Must document AG Grid Community');
  assert.ok(content.includes('36.3.0'), 'Must document pinned version 36.3.0');
  assert.ok(content.includes('MIT License'), 'Must state MIT License');
});

// ----------------------------------------------------------------------------
// Test 3: HTML Integration & Attribution
// ----------------------------------------------------------------------------
test('Test 3: ledger.html includes vendored assets, attribution, and fallback', () => {
  assert.ok(fs.existsSync(LEDGER_HTML), 'ledger.html must exist');
  const html = fs.readFileSync(LEDGER_HTML, 'utf8');

  // Vendored scripts and styles
  assert.ok(html.includes('/vendor/ag-grid/ag-grid-community.min.js'), 'Must load vendored AG Grid script');
  assert.ok(html.includes('/vendor/ag-grid/ag-grid.min.css'), 'Must load vendored ag-grid.min.css');
  assert.ok(html.includes('/vendor/ag-grid/ag-theme-quartz.min.css'), 'Must load vendored quartz theme');

  // Attribution
  assert.ok(html.includes('Powered by AG Grid Community'), 'Must include "Powered by AG Grid Community" attribution');

  // Fallback structure
  assert.ok(html.includes('id="fallbackNotice"'), 'Must have fallback notice container');
  assert.ok(html.includes('id="agGridContainer"'), 'Must have agGridContainer');
  assert.ok(html.includes('id="plainTableContainer"'), 'Must have plainTableContainer for fallback');
  assert.ok(html.includes('id="detailPanel"'), 'Must have detailPanel for audit trace inspector');
});

// ----------------------------------------------------------------------------
// Test 4: Strict XSS Safety Invariant (NO innerHTML)
// ----------------------------------------------------------------------------
test('Test 4: ledger.js strictly adheres to NO innerHTML invariant', () => {
  assert.ok(fs.existsSync(LEDGER_JS), 'ledger.js must exist');
  const js = fs.readFileSync(LEDGER_JS, 'utf8');

  assert.ok(!js.includes('.innerHTML'), 'ledger.js must contain ZERO occurrences of .innerHTML');
  assert.ok(js.includes('.textContent ='), 'ledger.js must use textContent for rendering text');
  assert.ok(js.includes('agGrid.createGrid'), 'ledger.js must call agGrid.createGrid');
});

// ----------------------------------------------------------------------------
// Test 5: PayPal IDs Column Width (Cap:xxxx Pay:xxxx not clipped)
// ----------------------------------------------------------------------------
test('Test 5: PayPal IDs column width is at least 160px to prevent clipping', () => {
  const js = fs.readFileSync(LEDGER_JS, 'utf8');
  const match = js.match(/headerName:\s*['"]PayPal IDs['"],\s*width:\s*(\d+)/);
  assert.ok(match, 'PayPal IDs column definition should specify width');
  const width = parseInt(match[1], 10);
  assert.ok(width >= 160, `PayPal IDs column width is ${width}px, expected >= 160px`);
});

// ----------------------------------------------------------------------------
// Test 6: Active Service Duration Resolution on Agent-Settled Bookings
// ----------------------------------------------------------------------------
test('Test 6: Active seconds resolves from events for agent-settled bookings', () => {
  const ledgerRouter = require('../server/routes/ledgerApi');
  const store = require('../server/store');
  const os = require('os');

  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-test-duration-'));
  const testStoreFile = path.join(testTempDir, 'bookings.json');
  store.setStorePath(testStoreFile);

  try {
    store.writeAll({
      // Agent-settled booking with events but missing direct activeSeconds field
      'BK_AGENT_SETTLED_01': {
        bookingId: 'BK_AGENT_SETTLED_01',
        status: 'CAPTURED',
        captureStatus: 'COMPLETED',
        mode: 'REAL_SANDBOX',
        evidence: {
          service: { id: 's1', name: 'Plumber', start_price: 99 },
          booking_type: 'emergency'
        },
        events: [
          { id: 'evt_1', type: 'start', timestamp: '2026-11-11T12:00:00.000Z' },
          { id: 'evt_2', type: 'complete', timestamp: '2026-11-11T12:01:30.000Z' }
        ]
      },
      // Truly unknown booking without events or duration
      'BK_UNKNOWN_02': {
        bookingId: 'BK_UNKNOWN_02',
        status: 'CREATED'
      }
    });

    const records = Object.values(store.readAll());
    // Direct call to route logic
    let resolvedAgentSec = null;
    let resolvedUnknownSec = null;

    // Simulate route mapping
    const routerReq = { method: 'GET', url: '/records', path: '/records', headers: {}, app: { locals: {} } };
    const routerRes = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) {
        const r1 = data.records.find(r => r.booking_id === 'TTLED_01');
        const r2 = data.records.find(r => r.booking_id === 'KNOWN_02');
        resolvedAgentSec = r1?.active_seconds;
        resolvedUnknownSec = r2?.active_seconds;
      }
    };

    ledgerRouter(routerReq, routerRes, () => {});

    assert.strictEqual(resolvedAgentSec, 90, 'Agent-settled booking should calculate active seconds from events (90s)');
    assert.strictEqual(resolvedUnknownSec, 'n/a', 'Truly unknown booking without events should remain n/a');
  } finally {
    store.resetStorePath();
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch (e) {}
  }
});
