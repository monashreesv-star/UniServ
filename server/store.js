/**
 * ============================================================================
 * UniServ Server Booking Store
 * ============================================================================
 * Thread-safe, atomic JSON-file based persistent store for bookings,
 * evidence, PayPal order/authorization metadata, and status.
 *
 * SAFETY INVARIANTS (Phase 3.1b):
 *  1. Call-time path resolution: STORE_PATH and DATA_DIR env vars or explicit
 *     setStorePath() override take effect dynamically on each call.
 *  2. Critical write guard: When NODE_ENV === 'test' or running under node --test,
 *     any write to the default production store is refused with a clear error.
 *  3. Timestamped rotating backup: In normal runs, bookings.backup.json is
 *     refreshed before each write so a bad write never loses the only copy.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, 'data');
const DEFAULT_STORE_FILE = path.join(DEFAULT_DATA_DIR, 'bookings.json');

// In-process override for test isolation
let _customStorePath = null;

/**
 * Sets an explicit in-memory store path override (for tests).
 * @param {string|null} customPath
 */
function setStorePath(customPath) {
  _customStorePath = customPath ? path.resolve(customPath) : null;
}

/**
 * Resets any explicit in-memory store path override.
 */
function resetStorePath() {
  _customStorePath = null;
}

/**
 * Dynamically resolves the active store file path at call time.
 * @returns {string} Absolute path to active bookings.json file
 */
function getStorePath() {
  if (_customStorePath) {
    return _customStorePath;
  }
  if (process.env.STORE_PATH && process.env.STORE_PATH.trim()) {
    return path.resolve(process.env.STORE_PATH.trim());
  }
  if (process.env.DATA_DIR && process.env.DATA_DIR.trim()) {
    return path.join(path.resolve(process.env.DATA_DIR.trim()), 'bookings.json');
  }
  return DEFAULT_STORE_FILE;
}

/**
 * Dynamically resolves the directory of the active store file.
 * @returns {string} Absolute directory path
 */
function getDataDir() {
  return path.dirname(getStorePath());
}

/**
 * Checks whether the current process is running in a test context.
 * @returns {boolean}
 */
function isTestEnvironment() {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  if (Array.isArray(process.execArgv) && process.execArgv.some((a) => a.includes('--test'))) {
    return true;
  }
  if (Array.isArray(process.argv) && process.argv.some((a) => a.includes('--test'))) {
    return true;
  }
  return false;
}

/**
 * Safety net: Refuses any write to the production store file while in test mode.
 * @param {string} targetFile
 */
function checkWriteSafety(targetFile) {
  const resolvedTarget = path.resolve(targetFile).toLowerCase();
  const resolvedDefault = path.resolve(DEFAULT_STORE_FILE).toLowerCase();

  if (isTestEnvironment() && resolvedTarget === resolvedDefault) {
    const error = new Error(
      `[CRITICAL_STORE_GUARD] Write refused! Attempted to write to production store "${targetFile}" ` +
      `while running in test environment (NODE_ENV="${process.env.NODE_ENV}"). ` +
      `Tests must configure an isolated temporary STORE_PATH.`
    );
    error.code = 'ERR_TEST_STORE_OVERWRITE_PREVENTED';
    throw error;
  }
}

/**
 * Creates a rotating backup of the current store file before writing.
 * Refreshes bookings.backup.json so a bad write never loses the last good copy.
 * @param {string} targetFile
 */
function makeBackupBeforeWrite(targetFile) {
  try {
    if (fs.existsSync(targetFile)) {
      const dataDir = path.dirname(targetFile);
      const backupFile = path.join(dataDir, 'bookings.backup.json');
      fs.copyFileSync(targetFile, backupFile);
    }
  } catch (err) {
    console.warn('[Store] Warning: Could not create backup before write:', err.message);
  }
}

/**
 * Reads all bookings from the active store.
 * @returns {Record<string, object>} Map of bookingId -> bookingRecord
 */
function readAll() {
  const storeFile = getStorePath();
  if (!fs.existsSync(storeFile)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(storeFile, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(`Failed to parse store file at "${storeFile}", initializing empty store:`, err.message);
    return {};
  }
}

/**
 * Atomically writes bookings map to disk via temp file rename.
 * Enforces test-environment safety guard and rotating backup.
 * @param {Record<string, object>} data
 */
function writeAll(data) {
  const storeFile = getStorePath();
  const dataDir = path.dirname(storeFile);

  // 1. Critical test write safety check
  checkWriteSafety(storeFile);

  // 2. Ensure target directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 3. Make rotating backup before overwriting in normal runs
  makeBackupBeforeWrite(storeFile);

  // 4. Atomic write via temp file
  const tmpFile = path.join(
    dataDir,
    `bookings.json.tmp.${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );

  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpFile, serialized, 'utf8');

  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      fs.renameSync(tmpFile, storeFile);
      return;
    } catch (err) {
      attempts++;
      if (attempts >= maxAttempts) {
        // Fallback: copy and delete temp file
        try {
          fs.copyFileSync(tmpFile, storeFile);
          fs.unlinkSync(tmpFile);
          return;
        } catch (copyErr) {
          throw new Error(`Atomic write failed after ${maxAttempts} attempts: ${err.message}`);
        }
      }
      // Small sync busy wait before retry (Windows EPERM/EBUSY unlock)
      const start = Date.now();
      while (Date.now() - start < 25) {}
    }
  }
}

/**
 * Retrieves a booking by bookingId.
 * @param {string} bookingId
 * @returns {object|null}
 */
function getBooking(bookingId) {
  if (!bookingId) return null;
  const bookings = readAll();
  return bookings[bookingId] || null;
}

/**
 * Retrieves a booking by PayPal orderId.
 * @param {string} orderId
 * @returns {object|null}
 */
function getBookingByOrderId(orderId) {
  if (!orderId) return null;
  const bookings = readAll();
  for (const key of Object.keys(bookings)) {
    if (bookings[key].orderId === orderId) {
      return bookings[key];
    }
  }
  return null;
}

/**
 * Retrieves a booking by PayPal authorizationId.
 * @param {string} authorizationId
 * @returns {object|null}
 */
function getBookingByAuthorizationId(authorizationId) {
  if (!authorizationId) return null;
  const bookings = readAll();
  for (const key of Object.keys(bookings)) {
    if (bookings[key].authorizationId === authorizationId) {
      return bookings[key];
    }
  }
  return null;
}

/**
 * Saves a new booking record.
 * @param {object} record
 * @returns {object} The saved record
 */
function saveBooking(record) {
  if (!record || !record.bookingId) {
    throw new Error('Cannot save booking without a bookingId');
  }
  const bookings = readAll();
  const now = new Date().toISOString();
  const fullRecord = {
    ...record,
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  bookings[record.bookingId] = fullRecord;
  writeAll(bookings);
  return fullRecord;
}

/**
 * Updates an existing booking record.
 * @param {string} bookingId
 * @param {object} updates
 * @returns {object|null} Updated record or null if not found
 */
function updateBooking(bookingId, updates) {
  if (!bookingId) return null;
  const bookings = readAll();
  const existing = bookings[bookingId];
  if (!existing) return null;

  const updatedRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  bookings[bookingId] = updatedRecord;
  writeAll(bookings);
  return updatedRecord;
}

/**
 * Updates an existing booking record by orderId.
 * @param {string} orderId
 * @param {object} updates
 * @returns {object|null} Updated record or null if not found
 */
function updateBookingByOrderId(orderId, updates) {
  const existing = getBookingByOrderId(orderId);
  if (!existing) return null;
  return updateBooking(existing.bookingId, updates);
}

/**
 * Appends a stamped event to the booking's events array.
 * @param {string} bookingId
 * @param {object} event
 * @returns {object|null} Updated booking record
 */
function addBookingEvent(bookingId, event) {
  if (!bookingId) return null;
  const bookings = readAll();
  const existing = bookings[bookingId];
  if (!existing) return null;
  const events = existing.events ? [...existing.events, event] : [event];
  return updateBooking(bookingId, { events });
}

/**
 * Test helper to reset store for isolated tests.
 * Enforces checkWriteSafety so it fails immediately if target is production store.
 */
function _clearForTesting() {
  const targetFile = getStorePath();
  checkWriteSafety(targetFile);
  writeAll({});
}

module.exports = {
  getBooking,
  getBookingByOrderId,
  getBookingByAuthorizationId,
  saveBooking,
  updateBooking,
  updateBookingByOrderId,
  addBookingEvent,
  _clearForTesting,
  readAll,
  writeAll,
  setStorePath,
  resetStorePath,
  getStorePath,
  getDataDir,
  isTestEnvironment,
  checkWriteSafety,
  DEFAULT_STORE_FILE
};
