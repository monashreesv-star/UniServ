/**
 * ============================================================================
 * UniServ Stage 3.1b Store Isolation & Integrity Test
 * ============================================================================
 * Runs alphabetically last in the test suite to verify:
 *  1. Production store write guard: Writing to server/data/bookings.json in
 *     test environment throws [CRITICAL_STORE_GUARD].
 *  2. STORE_PATH dynamic override works as expected.
 *  3. Timestamped rotating backup (bookings.backup.json) is created in normal runs.
 *  4. Full suite integrity check: Verifies modification time and content hash of
 *     the real server/data/bookings.json did NOT change and was not created.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('../server/store');
const { captureStoreSnapshot, DEFAULT_STORE_FILE } = require('./testEnv');

test('Stage 3.1b: Safety guard refuses writes to default production store in test mode', () => {
  // Ensure we are pointing at the default store
  store.resetStorePath();
  delete process.env.STORE_PATH;
  delete process.env.DATA_DIR;

  assert.strictEqual(
    path.resolve(store.getStorePath()).toLowerCase(),
    path.resolve(store.DEFAULT_STORE_FILE).toLowerCase()
  );

  // Attempting writeAll or _clearForTesting directly to default store in test mode must throw
  assert.throws(
    () => {
      store.writeAll({ malicious: true });
    },
    (err) => {
      assert.ok(err.message.includes('[CRITICAL_STORE_GUARD]'));
      assert.strictEqual(err.code, 'ERR_TEST_STORE_OVERWRITE_PREVENTED');
      return true;
    }
  );

  assert.throws(
    () => {
      store._clearForTesting();
    },
    (err) => {
      assert.ok(err.message.includes('[CRITICAL_STORE_GUARD]'));
      return true;
    }
  );
});

test('Stage 3.1b: Dynamic STORE_PATH override redirects reads and writes to isolated directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-store-override-'));
  const tempStoreFile = path.join(tempDir, 'custom_bookings.json');

  try {
    store.setStorePath(tempStoreFile);
    assert.strictEqual(store.getStorePath(), tempStoreFile);

    // Save booking should write to tempStoreFile
    store.saveBooking({
      bookingId: 'BK_ISOLATED_TEST',
      status: 'AUTHORIZED',
      notes: 'Testing store isolation'
    });

    assert.ok(fs.existsSync(tempStoreFile), 'Custom store file must be created');
    const readBack = store.getBooking('BK_ISOLATED_TEST');
    assert.strictEqual(readBack.bookingId, 'BK_ISOLATED_TEST');
  } finally {
    store.resetStorePath();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

test('Stage 3.1b: Rotating backup is created before write in normal runs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniserv-backup-test-'));
  const tempStoreFile = path.join(tempDir, 'bookings.json');
  const tempBackupFile = path.join(tempDir, 'bookings.backup.json');

  const origNodeEnv = process.env.NODE_ENV;
  try {
    store.setStorePath(tempStoreFile);

    // Simulate normal run (NODE_ENV !== 'test')
    process.env.NODE_ENV = 'production';

    // 1. Initial write creates bookings.json (no backup yet because file didn't exist)
    store.writeAll({ first: 'version1' });
    assert.ok(fs.existsSync(tempStoreFile));
    assert.strictEqual(fs.existsSync(tempBackupFile), false);

    // 2. Second write must back up version1 to bookings.backup.json before writing version2
    store.writeAll({ second: 'version2' });
    assert.ok(fs.existsSync(tempBackupFile), 'Backup file must exist after second write');

    const backupContent = JSON.parse(fs.readFileSync(tempBackupFile, 'utf8'));
    assert.strictEqual(backupContent.first, 'version1');

    const currentContent = JSON.parse(fs.readFileSync(tempStoreFile, 'utf8'));
    assert.strictEqual(currentContent.second, 'version2');
  } finally {
    process.env.NODE_ENV = origNodeEnv;
    store.resetStorePath();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

test('Stage 3.1b: Integrity verification - server/data/bookings.json was NOT modified or created during test suite', () => {
  const initial = global.__INITIAL_REAL_STORE_SNAPSHOT__ || { exists: false, hash: null, mtimeMs: null };
  const current = captureStoreSnapshot();

  if (!initial.exists) {
    assert.strictEqual(
      current.exists,
      false,
      `Integrity violation: "${DEFAULT_STORE_FILE}" was created during the test suite run!`
    );
  } else {
    assert.strictEqual(
      current.exists,
      true,
      `Integrity violation: "${DEFAULT_STORE_FILE}" was deleted during the test suite run!`
    );
    assert.strictEqual(
      current.hash,
      initial.hash,
      `Integrity violation: Content hash of "${DEFAULT_STORE_FILE}" changed during the test suite run! ` +
      `Initial: ${initial.hash}, Current: ${current.hash}`
    );
    assert.strictEqual(
      current.mtimeMs,
      initial.mtimeMs,
      `Integrity violation: Modification timestamp of "${DEFAULT_STORE_FILE}" changed during the test suite run! ` +
      `Initial: ${initial.mtimeMs}, Current: ${current.mtimeMs}`
    );
  }
});
