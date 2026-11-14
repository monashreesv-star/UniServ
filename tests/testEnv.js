/**
 * ============================================================================
 * UniServ Test Environment Preload
 * ============================================================================
 * Sets NODE_ENV='test' before any test runs and captures the initial integrity
 * snapshot of server/data/bookings.json.
 * ============================================================================
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

process.env.NODE_ENV = 'test';

const DEFAULT_STORE_FILE = path.resolve(__dirname, '../server/data/bookings.json');

function captureStoreSnapshot() {
  if (!fs.existsSync(DEFAULT_STORE_FILE)) {
    return {
      exists: false,
      hash: null,
      mtimeMs: null,
      size: null
    };
  }
  const content = fs.readFileSync(DEFAULT_STORE_FILE);
  const stat = fs.statSync(DEFAULT_STORE_FILE);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return {
    exists: true,
    hash,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

global.__INITIAL_REAL_STORE_SNAPSHOT__ = captureStoreSnapshot();

module.exports = {
  captureStoreSnapshot,
  DEFAULT_STORE_FILE
};
