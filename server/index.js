/**
 * ============================================================================
 * UniServ API Server
 * ============================================================================
 * Express backend providing PayPal Sandbox order creation and authorization
 * backed by the pure deterministic settlement engine.
 * ============================================================================
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from server/.env
dotenv.config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const store = require('./store');
const ordersRouter = require('./routes/orders');
const jobsRouter = require('./routes/jobs');
const payoutsRouter = require('./routes/payouts');
const aiRouter = require('./routes/ai');
const settlementRouter = require('./routes/settlement');
const ledgerRouter = require('./routes/ledgerApi');
const { validateReceiverEmails } = require('./services/receiverValidation');

// Validate receiver emails configuration on server boot (names only)
const receiverValidation = validateReceiverEmails();
if (!receiverValidation.valid) {
  console.warn('Payouts Configuration Warning:');
  for (const err of receiverValidation.errors) {
    console.warn(`  - ${err}`);
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

// Restrict CORS strictly to the origin of CLIENT_RETURN_URL
const clientReturnUrl = process.env.CLIENT_RETURN_URL || 'http://localhost:8081';
let clientOrigin = 'http://localhost:8081';
try {
  clientOrigin = new URL(clientReturnUrl).origin;
} catch (e) {
  console.warn(`Could not parse CLIENT_RETURN_URL "${clientReturnUrl}", defaulting to http://localhost:8081`);
}

app.use(cors({
  origin: clientOrigin,
  credentials: true
}));

// Body parser with 10mb limit
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
    time: new Date().toISOString()
  });
});

// API Routes
app.use('/api/orders', ordersRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/payouts', payoutsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/settlement', settlementRouter);
app.use('/api/ledger', ledgerRouter);

// Serve static assets for Co-op Treasury Ledger
app.use(express.static(path.join(__dirname, 'public')));
app.get('/ledger', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ledger.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.message || err);
  res.status(500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal error occurred'
  });
});

const server = app.listen(PORT, () => {
  const storePath = store.getStorePath();
  const loadedBookings = Object.keys(store.readAll()).length;
  const receiverStatus = receiverValidation.valid
    ? 'YES (Distinct variables: PAYPAL_RECEIVER_ARTISAN_EMAIL, PAYPAL_RECEIVER_WELFARE_EMAIL, PAYPAL_RECEIVER_RESERVE_EMAIL)'
    : `NO (${receiverValidation.errors.join('; ')})`;

  console.log('================================================================================');
  console.log('                    UniServ Platform Backend Server                             ');
  console.log('================================================================================');
  console.log(` Code Stage:                 Phase 3.1b (Isolated Store & Split Payouts)`);
  console.log(` Store Path:                 ${storePath}`);
  console.log(` Bookings Loaded:            ${loadedBookings}`);
  console.log(` Receiver Variables Valid:   ${receiverStatus}`);
  console.log(` Server Port:                ${PORT}`);
  console.log(` CORS Restricted To:         ${clientOrigin}`);
  console.log('================================================================================');
});

module.exports = { app, server };
