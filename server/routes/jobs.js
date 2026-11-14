/**
 * ============================================================================
 * UniServ Job Events & Bill Preview Routes
 * ============================================================================
 * Handles:
 *  - POST /api/jobs/:bookingId/events: Server-stamped job event logging
 *    with strict state-machine ordering and input validation.
 *  - GET  /api/jobs/:bookingId/bill-preview: Deterministic real-time bill calculation
 *    sharing the exact same calculation function as /api/orders/capture.
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const store = require('../store');
const { validateAndStampEvent, deriveBillFromEvents } = require('../services/jobEventService');
const { ValidationError } = require('../services/settlementService');

/**
 * POST /api/jobs/:bookingId/events
 * Records a server-stamped job event.
 */
router.post('/:bookingId/events', (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    const reason = `Booking "${bookingId}" not found`;
    console.log(`event rejected: ${reason}`);
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: reason
    });
  }

  const last4 = String(booking.bookingId || bookingId).slice(-4);

  try {
    const stampedEvent = validateAndStampEvent(booking, req.body);
    const updatedBooking = store.addBookingEvent(booking.bookingId, stampedEvent);

    console.log(`event received: ${stampedEvent.type} ${last4}`);

    return res.status(201).json({
      success: true,
      bookingId: booking.bookingId,
      event: stampedEvent,
      eventCount: (updatedBooking && updatedBooking.events) ? updatedBooking.events.length : 1
    });
  } catch (err) {
    const reason = err.message || 'Validation error';
    console.log(`event rejected: ${reason}`);

    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: err.message
      });
    }

    console.error(`Failed to record job event for booking ${bookingId}:`, err);
    return res.status(500).json({
      success: false,
      error: 'EVENT_RECORD_FAILED',
      message: 'Could not record event'
    });
  }
});

/**
 * GET /api/jobs/:bookingId/bill-preview
 * Returns real-time bill calculation derived deterministically from recorded events.
 */
router.get('/:bookingId/bill-preview', (req, res) => {
  const { bookingId } = req.params;
  const booking = store.getBooking(bookingId);

  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: `Booking "${bookingId}" not found`
    });
  }

  try {
    const calculation = deriveBillFromEvents(booking, booking.events || []);
    const exceedsCeiling = calculation.finalCents > (booking.authorizedCents || 0);

    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      status: booking.status,
      authorizedCents: booking.authorizedCents,
      authorizedAmountUsd: booking.authorizedAmountUsd,
      finalCents: calculation.finalCents,
      finalAmountUsd: calculation.finalAmountUsd,
      totalRupees: calculation.totalRupees,
      totalPaise: calculation.totalPaise,
      activeSeconds: calculation.activeSeconds,
      rawActiveSeconds: calculation.rawActiveSeconds,
      demoTimeScale: calculation.demoTimeScale,
      exceedsCeiling,
      hasStart: calculation.hasStart,
      hasComplete: calculation.hasComplete,
      bill: calculation.bill,
      events: booking.events || []
    });
  } catch (err) {
    console.error(`Failed to derive bill preview for booking ${bookingId}:`, err);
    return res.status(500).json({
      success: false,
      error: 'CALCULATION_ERROR',
      message: 'Failed to compute bill preview'
    });
  }
});

module.exports = router;
