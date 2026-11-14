import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Modal,
  Alert,
  Platform,
  ActivityIndicator
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useBooking } from '../context/BookingContext';
import { useUser } from '../context/UserContext';
import PaymentBreakdown from '../components/PaymentBreakdown';
import { getFallbackWorkerForTrade } from '../utils/locationService';
import { fetchPayoutDetails, retryPayout } from '../utils/jobTelemetry';

export const Screen13_PaymentSuccess = ({ route, navigation }) => {
  const { activeBooking, totalAmount, computeTotal } = useBooking();
  const { t, user } = useUser();
  const [invoiceModalVisible, setInvoiceModalVisible] = useState(false);

  const captureResult = route.params?.captureResult;
  const settlementResult = route.params?.settlementResult;
  const currentBooking = activeBooking || route.params?.booking;
  const isPayPal = currentBooking?.payment_method === 'PAYPAL_SANDBOX' || Boolean(currentBooking?.paypal_authorization_id);

  const settlementDecision = settlementResult?.decision || currentBooking?.settlement_decision || null;
  const settlementMode = settlementResult?.mode || currentBooking?.settlement_mode || (isPayPal ? 'AI_AGENT' : null);
  const settlementTrace = settlementResult?.trace || currentBooking?.settlement_trace || null;
  const settlementReceipt = settlementResult?.receipt || currentBooking?.settlement_receipt || null;

  const paypalStatus = captureResult?.status || currentBooking?.paypal_status || (currentBooking?.paypal_capture_id ? 'CAPTURED' : 'AUTHORIZED');
  const captureStatus = captureResult?.captureStatus || currentBooking?.paypal_capture_status;
  const isHoldForHuman = settlementDecision === 'HOLD_FOR_HUMAN' || paypalStatus === 'HOLD_FOR_HUMAN';
  const isCaptured = !isHoldForHuman && (paypalStatus === 'CAPTURED' || captureStatus === 'COMPLETED' || Boolean(currentBooking?.paypal_capture_id));
  const isCapturePending = !isHoldForHuman && (paypalStatus === 'CAPTURE_PENDING' || captureStatus === 'PENDING');

  const capturedUsd = isHoldForHuman ? '0.00' : (captureResult?.capturedAmountUsd || currentBooking?.paypal_captured_usd || currentBooking?.paypal_authorized_usd || '1.45');
  const holdCeilingUsd = currentBooking?.paypal_authorized_usd || '1.45';
  const captureId = captureResult?.captureId || currentBooking?.paypal_capture_id;
  const isSimulated = currentBooking?.paypal_mode === 'SIMULATED' || captureResult?.mode === 'SIMULATED';

  const [showTrace, setShowTrace] = useState(false);

  const fallbackWorker = getFallbackWorkerForTrade(currentBooking?.service);
  const amountPaid = computeTotal ? computeTotal(currentBooking) : (totalAmount || currentBooking?.total_amount || 500);
  const bookingId = captureResult?.bookingId || currentBooking?.paypal_booking_id || currentBooking?.bookingId || currentBooking?.booking_id || 'BK84920';

  // Payout State & Handlers (Stage 3.1)
  const [payout, setPayout] = useState(captureResult?.payout || currentBooking?.payout || null);
  const [isRefreshingPayout, setIsRefreshingPayout] = useState(false);
  const [isRetryingPayout, setIsRetryingPayout] = useState(false);

  useEffect(() => {
    if (isPayPal && isCaptured && bookingId && bookingId !== 'BK84920') {
      fetchPayoutDetails(bookingId).then((res) => {
        if (res && (res.success || res.payoutStatus)) {
          setPayout(res);
        }
      }).catch(() => {});
    }
  }, [isPayPal, isCaptured, bookingId]);

  const handleRefreshPayout = async () => {
    if (isRefreshingPayout || !bookingId) return;
    setIsRefreshingPayout(true);
    try {
      const res = await fetchPayoutDetails(bookingId);
      if (res && (res.success || res.payoutStatus)) {
        setPayout(res);
      }
    } catch (err) {
      console.warn('Failed to refresh payout status:', err);
    } finally {
      setIsRefreshingPayout(false);
    }
  };

  const handleRetryPayout = async () => {
    if (isRetryingPayout || !bookingId) return;
    setIsRetryingPayout(true);
    try {
      const res = await retryPayout(bookingId);
      if (res && (res.success || res.payoutStatus)) {
        setPayout(res);
      }
    } catch (err) {
      Alert.alert('Payout Retry Failed', err.message || 'Could not retry PayPal payout batch.');
    } finally {
      setIsRetryingPayout(false);
    }
  };

  const rawFee = captureResult?.paypalFeeUsd || currentBooking?.paypal_fee_usd || payout?.paypalFeeUsd || null;
  const paypalFee = (rawFee !== null && rawFee !== undefined && rawFee !== '' && !isNaN(Number(rawFee)) && Number(rawFee) > 0)
    ? Number(rawFee).toFixed(2)
    : null;
  const payoutSkippedReason = captureResult?.payoutSkippedReason || currentBooking?.payoutSkippedReason || payout?.payoutSkippedReason || null;
  const artisanPayout = payout?.items?.find((it) => it.role === 'artisan');
  const welfarePayout = payout?.items?.find((it) => it.role === 'welfare');
  const reservePayout = payout?.items?.find((it) => it.role === 'reserve');
  const retainedAmountUsd = payout?.retainedAmountUsd || '0.00';
  const serviceName = currentBooking?.service?.name || 'General Service';
  const workerName = currentBooking?.worker?.name || fallbackWorker?.name || 'Cooperative Artisan';
  const hasWarranty = currentBooking?.service?.has_seva_suraksha !== false;

  const baseRate = currentBooking?.worker_count > 1
    ? (currentBooking?.single_worker_base || (currentBooking?.base_amount - (currentBooking?.extra_worker_cost || 0)))
    : (currentBooking?.base_amount || currentBooking?.service?.start_price || 299);
  const workerCount = currentBooking?.worker_count || 1;
  const extraWorkerCost = currentBooking?.extra_worker_cost || ((workerCount - 1) * 199);
  const emergencySurge = Number(currentBooking?.emergency_surge || 0);
  const isExtraApproved = currentBooking?.extra_work && (currentBooking.extra_work.status === 'approved' || currentBooking.extra_work.approved);
  const extraWorkCost = isExtraApproved ? Number(currentBooking.extra_work.amount || 0) : 0;
  const partOrderCost = (currentBooking?.part_order && currentBooking.part_order.part_cost) ? Number(currentBooking.part_order.part_cost || 0) : 0;
  const isHelperApproved = currentBooking?.second_worker || currentBooking?.helper_request?.status === 'approved';
  const helperCost = isHelperApproved ? Number(currentBooking?.helper_request?.amount || currentBooking?.service?.helper_request?.amount || 200) : 0;
  const overtimeCharge = Number(currentBooking?.overtime_charge || 0);
  const distanceCharge = Number(currentBooking?.distance_charge || 0);
  const distanceKm = Number(currentBooking?.distance_km ?? currentBooking?.worker?.distance_km ?? 0);
  const cancellationPenalty = Number(currentBooking?.cancellation_penalty_fee || 0);
  const discountApplied = Number(currentBooking?.discount_applied || 0);

  const handleRateExperience = () => {
    navigation.navigate('RatingScreen');
  };

  const handleDownloadInvoicePdf = () => {
    if (Platform.OS === 'web') {
      try {
        const invoiceContent = `
          <!DOCTYPE html>
          <html>
          <head>
            <title>UniServ Tax Invoice - ${bookingId}</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; color: #1E293B; max-width: 720px; margin: 0 auto; }
              .header { border-bottom: 2px solid #1E3A8A; padding-bottom: 20px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
              .title { font-size: 24px; font-weight: 800; color: #1E3A8A; margin: 0; }
              .badge { background: #ECFDF5; color: #047857; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-size: 13px; border: 1px solid #A7F3D0; }
              .grid { margin: 20px 0; line-height: 1.8; font-size: 14px; }
              table { width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 20px; font-size: 13px; }
              th { padding: 10px 8px; border-bottom: 2px solid #CBD5E1; color: #475569; text-align: left; }
              td { padding: 9px 8px; border-bottom: 1px solid #F1F5F9; color: #1E293B; }
              .total { font-size: 20px; font-weight: 900; color: #1E3A8A; border-top: 2px solid #1E3A8A; padding-top: 14px; margin-top: 14px; display: flex; justify-content: space-between; }
              .wage-banner { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 12px; margin-top: 20px; font-size: 12px; line-height: 1.6; }
              .footer { margin-top: 30px; font-size: 12px; color: #64748B; border-top: 1px dashed #CBD5E1; padding-top: 10px; }
            </style>
          </head>
          <body>
            <div class="header">
              <div>
                <h1 class="title">UniServ Cooperative Platform</h1>
                <p style="margin: 4px 0 0; color: #64748B;">Official Service & GST Tax Receipt</p>
              </div>
              <div>
                <span class="badge">PAID IN FULL</span>
              </div>
            </div>
            <div class="grid">
              <p><strong>Invoice Number:</strong> INV-${bookingId}-2026</p>
              <p><strong>Transaction Date:</strong> ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
              <p><strong>Customer Name:</strong> Priya Sharma</p>
              <p><strong>Service Rendered:</strong> ${serviceName}</p>
              <p><strong>Lead Artisan:</strong> ${workerName}</p>
              <p><strong>Cooperative Society:</strong> Delhi Labour Cooperative Union</p>
              <p><strong>Payment Mode:</strong> ${isPayPal ? `PayPal Sandbox (${isCaptured ? `Captured $${capturedUsd} USD` : paypalStatus}${captureId ? `, Capture ID: ${captureId}` : ''}) (Auth ID: ${currentBooking?.paypal_authorization_id})` : (activeBooking?.payment_method || 'Instant UPI')}</p>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Itemized Service / Work Description</th>
                  <th style="text-align: right;">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Base Service (${activeBooking?.trade_subtype || 'Standard Diagnostic & Repair'})</td>
                  <td style="text-align: right; font-weight: 600;">₹${baseRate}.00</td>
                </tr>
                ${workerCount > 1 ? `
                <tr>
                  <td>Additional Cooperative Artisans (+${workerCount - 1} workers, ${workerCount}x speed)</td>
                  <td style="text-align: right; font-weight: 600; color: #1E3A8A;">+₹${extraWorkerCost}.00</td>
                </tr>` : ''}
                ${emergencySurge > 0 ? `
                <tr>
                  <td>Emergency Priority Dispatch Surge (&lt;15 min)</td>
                  <td style="text-align: right; font-weight: 600; color: #DC2626;">+₹${emergencySurge}.00</td>
                </tr>` : ''}
                ${extraWorkCost > 0 ? `
                <tr>
                  <td>${activeBooking?.extra_work?.title || 'Approved Extra Work / Materials'}</td>
                  <td style="text-align: right; font-weight: 600; color: #1E3A8A;">+₹${extraWorkCost}.00</td>
                </tr>` : ''}
                ${partOrderCost > 0 ? `
                <tr>
                  <td>Procured Spare Part: ${activeBooking?.part_order?.part_name || 'Genuine Replacement Component'}</td>
                  <td style="text-align: right; font-weight: 600; color: #047857;">+₹${partOrderCost}.00</td>
                </tr>` : ''}
                ${helperCost > 0 ? `
                <tr>
                  <td>2nd Assistant Artisan (${activeBooking?.second_worker?.name || 'Helper'})</td>
                  <td style="text-align: right; font-weight: 600; color: #6D28D9;">+₹${helperCost}.00</td>
                </tr>` : ''}
                ${distanceCharge > 0 ? `
                <tr>
                  <td>Distance Travel Surcharge (&gt;7 km: ${distanceKm} km, ₹7/extra km)</td>
                  <td style="text-align: right; font-weight: 600; color: #0369A1;">+₹${distanceCharge}.00</td>
                </tr>` : ''}
                ${overtimeCharge > 0 ? `
                <tr>
                  <td>Extended Overtime Surcharge (&gt;2 Hours)</td>
                  <td style="text-align: right; font-weight: 600; color: #B45309;">+₹${overtimeCharge}.00</td>
                </tr>` : ''}
                ${cancellationPenalty > 0 ? `
                <tr>
                  <td>Previous Booking Cancellation Fee</td>
                  <td style="text-align: right; font-weight: 600; color: #DC2626;">+₹${cancellationPenalty}.00</td>
                </tr>` : ''}
                ${discountApplied > 0 ? `
                <tr>
                  <td>First-Time User Welcome Discount</td>
                  <td style="text-align: right; font-weight: 600; color: #047857;">-₹${discountApplied}.00</td>
                </tr>` : ''}
              </tbody>
            </table>

            <div class="total">
              <span>Total Amount Settled:</span>
              <span>₹${amountPaid}.00</span>
            </div>

            <div class="wage-banner">
              <strong>Transparent Cooperative 80/10/6/4 Split:</strong><br/>
              • 80% Direct Worker Wage: ₹${(amountPaid * 0.8).toFixed(0)}<br/>
              • 10% Artisan Welfare & Health Fund: ₹${(amountPaid * 0.1).toFixed(0)}<br/>
              • 6% Cooperative Society Operations: ₹${(amountPaid * 0.06).toFixed(0)}<br/>
              • 4% Platform & Seva Suraksha Pool: ₹${(amountPaid * 0.04).toFixed(0)}
            </div>

            <div class="footer">
              <p>Registered Cooperative Platform • 80% Direct Artisan Wage Guaranteed</p>
              ${hasWarranty ? '<p>🛡️ Active 7-Day Seva Suraksha Warranty Protection Included</p>' : ''}
            </div>
            <script>window.print();</script>
          </body>
          </html>
        `;
        const blob = new Blob([invoiceContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        if (win) {
          win.focus();
        } else {
          const a = document.createElement('a');
          a.href = url;
          a.download = `UniServ_Invoice_${bookingId}.html`;
          a.click();
        }
      } catch (err) {
        console.warn('PDF export fallback:', err);
      }
    }
    Alert.alert('Invoice Ready', `Official tax invoice PDF for ${bookingId} has been generated.`);
    setInvoiceModalVisible(false);
  };

  const isScheduledOrAdvance = currentBooking?.booking_type === 'scheduled' || !!currentBooking?.is_bulk_project || currentBooking?.scale_mode === 'bulk';

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Success Checkmark Hero */}
        <View style={styles.successHero}>
          <View style={[
            styles.successIconCircle,
            isHoldForHuman && { backgroundColor: '#F59E0B' },
            isCapturePending && { backgroundColor: '#3B82F6' }
          ]}>
            <Ionicons
              name={isHoldForHuman ? "time" : (isCapturePending ? "hourglass" : "checkmark-done")}
              size={44}
              color="#FFFFFF"
            />
          </View>
          <Text style={styles.successTitle}>
            {isHoldForHuman
              ? 'Held for Cooperative Review'
              : isCapturePending
              ? 'Pending Capture Confirmation'
              : isScheduledOrAdvance
              ? (t('advancePaymentConfirmed') || 'Advance Payment Confirmed')
              : t('paymentSuccessful')}
          </Text>
          <Text style={styles.paidAmountText}>
            {isPayPal ? `$${capturedUsd} USD` : `₹${amountPaid}`}
          </Text>
          {isPayPal && (
            <Text style={{ fontSize: 13, color: '#64748B', fontWeight: '600', marginTop: 2, textAlign: 'center' }}>
              {isHoldForHuman
                ? 'Held for cooperative review, nothing captured'
                : isCapturePending
                ? `Pending capture confirmation (₹${amountPaid} • 1 USD = 85.00 INR)`
                : `(₹${amountPaid} settled via PayPal Sandbox • 1 USD = 85.00 INR sandbox demo rate)`}
            </Text>
          )}
          <View style={styles.txnPill}>
            <Text style={styles.txnPillText}>
              {isPayPal
                ? (captureId ? `PayPal Capture ID: ${captureId}` : `PayPal Auth ID: ${currentBooking?.paypal_authorization_id}`)
                : (isScheduledOrAdvance ? `${t('escrowRef') || 'Escrow Ref'}: UNISERV-ESCROW-${bookingId}` : `${t('txnRef') || 'Txn Ref'}: TXN-COOP-${bookingId}`)}
            </Text>
          </View>
        </View>

        {/* PayPal Sandbox Authorization Settled Card */}
        {isPayPal && (
          <View style={[styles.paypalSettledCard, isHoldForHuman && { borderColor: '#F59E0B' }]}>
            <View style={styles.paypalSettledHeader}>
              <Ionicons name="logo-paypal" size={22} color="#0070BA" />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text style={styles.paypalSettledBadgeTitle}>
                    {isSimulated
                      ? 'PAYPAL SIMULATED SETTLEMENT (DEMO)'
                      : 'PAYPAL SANDBOX SETTLEMENT'}
                  </Text>
                  {settlementMode && (
                    <View style={styles.modeBadge}>
                      <Text style={styles.modeBadgeText}>
                        {settlementMode === 'RULES_ONLY'
                          ? 'Rules-Only'
                          : settlementMode === 'REDUCED_AGENT'
                          ? 'Reduced Agent'
                          : 'AI Agent'}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.paypalSettledIdText}>
                  Auth ID: {currentBooking.paypal_authorization_id}
                </Text>
                {captureId && (
                  <Text style={[styles.paypalSettledIdText, { color: '#0070BA', fontWeight: '700' }]}>
                    Capture ID: {captureId}
                  </Text>
                )}
              </View>
              <View style={[
                styles.paypalSettledPill,
                isHoldForHuman && { backgroundColor: '#FEF3C7', borderColor: '#F59E0B' },
                isCapturePending && { backgroundColor: '#EFF6FF', borderColor: '#3B82F6' },
                isCaptured && { backgroundColor: '#DCFCE7', borderColor: '#16A34A' }
              ]}>
                <Ionicons
                  name={isHoldForHuman ? "time" : (isCapturePending ? "hourglass" : "checkmark-done")}
                  size={13}
                  color={isHoldForHuman ? "#B45309" : (isCapturePending ? "#1D4ED8" : "#16A34A")}
                />
                <Text style={[
                  styles.paypalSettledPillText,
                  isHoldForHuman && { color: "#B45309" },
                  isCapturePending && { color: "#1D4ED8" },
                  isCaptured && { color: "#16A34A" }
                ]}>
                  {isHoldForHuman ? 'HOLD FOR HUMAN' : (isCapturePending ? 'CAPTURE PENDING' : 'SETTLED')}
                </Text>
              </View>
            </View>
            <View style={styles.paypalSettledDivider} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ fontSize: 11, color: '#64748B' }}>
                Maximum hold: <Text style={{ fontWeight: '700', color: '#0F172A' }}>${holdCeilingUsd} USD</Text>
              </Text>
              <Text style={{ fontSize: 11, color: '#64748B' }}>
                Settled bill: <Text style={{ fontWeight: '700', color: '#0F172A' }}>${isHoldForHuman ? '0.00' : capturedUsd} USD</Text>
              </Text>
            </View>
            <Text style={styles.paypalSettledDesc}>
              {isHoldForHuman
                ? `Held for cooperative review, nothing captured. Reason: ${settlementResult?.holdReason || currentBooking?.holdReason || 'Policy rule or guard triggered human review.'}`
                : isCapturePending
                ? 'Capture request submitted to PayPal Sandbox and is awaiting clearance.'
                : `Settlement completed against authorized hold of $${holdCeilingUsd} USD. Payer: ${currentBooking.paypal_payer?.name || user?.name || 'Customer'}.`}
            </Text>
          </View>
        )}

        {/* PayPal Sandbox Payouts (80/10/6/4 Split) Card */}
        {isPayPal && (isCaptured || payout) && !isHoldForHuman && (
          <View style={styles.payoutCard}>
            <View style={styles.payoutHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Ionicons name="git-branch-outline" size={20} color="#0070BA" />
                <View style={{ marginLeft: 8, flex: 1 }}>
                  <Text style={styles.payoutHeaderTitle}>PAYPAL SANDBOX PAYOUTS</Text>
                  <Text style={styles.payoutHeaderSub}>Automated 80/10/6/4 Cooperative Split</Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {payout?.payoutBatchId ? (
                  <View style={styles.payoutBatchPill}>
                    <Text style={styles.payoutBatchPillText}>
                      Batch: ...{payout.payoutBatchId.slice(-4)}
                    </Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  style={styles.payoutRefreshBtn}
                  onPress={handleRefreshPayout}
                  disabled={isRefreshingPayout}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  {isRefreshingPayout ? (
                    <ActivityIndicator size="small" color="#0070BA" />
                  ) : (
                    <Ionicons name="refresh" size={16} color="#0070BA" />
                  )}
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.payoutDivider} />

            {/* Payout Skipped Notice */}
            {payoutSkippedReason ? (
              <View style={styles.payoutSkippedBox}>
                <Ionicons name="information-circle-outline" size={16} color="#475569" />
                <Text style={styles.payoutSkippedText}>
                  Payout not run: {payoutSkippedReason}
                </Text>
              </View>
            ) : null}

            {/* Item 1: Artisan Fair-Wage (80%) */}
            <View style={styles.payoutItemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.payoutItemTitle}>Artisan Fair-Wage (80%)</Text>
                <Text style={styles.payoutItemDesc}>Direct to cooperative artisan balance</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.payoutItemAmount}>
                  ${artisanPayout?.amountUsd || (Number(capturedUsd) * 0.8).toFixed(2)} USD
                </Text>
                <View style={[
                  styles.payoutItemStatusPill,
                  artisanPayout?.status === 'SUCCESS' && styles.payoutStatusPaid,
                  (artisanPayout?.status === 'FAILED' || artisanPayout?.status === 'FAILED_UNKNOWN') && styles.payoutStatusFailed
                ]}>
                  <Text style={[
                    styles.payoutItemStatusText,
                    artisanPayout?.status === 'SUCCESS' && styles.payoutStatusPaidText,
                    (artisanPayout?.status === 'FAILED' || artisanPayout?.status === 'FAILED_UNKNOWN') && styles.payoutStatusFailedText
                  ]}>
                    {artisanPayout?.status === 'SUCCESS' ? 'PAID' : (artisanPayout?.status || (payout?.payoutStatus === 'SUCCESS' ? 'PAID' : (payout?.payoutStatus || 'PENDING')))}
                  </Text>
                </View>
              </View>
            </View>

            {/* Item 2: Cooperative Welfare Fund (10%) */}
            <View style={styles.payoutItemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.payoutItemTitle}>Cooperative Welfare Fund (10%)</Text>
                <Text style={styles.payoutItemDesc}>Artisan social security & health pool</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.payoutItemAmount}>
                  ${welfarePayout?.amountUsd || (Number(capturedUsd) * 0.1).toFixed(2)} USD
                </Text>
                <View style={[
                  styles.payoutItemStatusPill,
                  welfarePayout?.status === 'SUCCESS' && styles.payoutStatusPaid,
                  (welfarePayout?.status === 'FAILED' || welfarePayout?.status === 'FAILED_UNKNOWN') && styles.payoutStatusFailed
                ]}>
                  <Text style={[
                    styles.payoutItemStatusText,
                    welfarePayout?.status === 'SUCCESS' && styles.payoutStatusPaidText,
                    (welfarePayout?.status === 'FAILED' || welfarePayout?.status === 'FAILED_UNKNOWN') && styles.payoutStatusFailedText
                  ]}>
                    {welfarePayout?.status === 'SUCCESS' ? 'PAID' : (welfarePayout?.status || (payout?.payoutStatus === 'SUCCESS' ? 'PAID' : (payout?.payoutStatus || 'PENDING')))}
                  </Text>
                </View>
              </View>
            </View>

            {/* Item 3: Emergency Reserve Fund (6%) */}
            <View style={styles.payoutItemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.payoutItemTitle}>Emergency Reserve Fund (6%)</Text>
                <Text style={styles.payoutItemDesc}>Equipment emergency & disaster protection</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.payoutItemAmount}>
                  ${reservePayout?.amountUsd || (Number(capturedUsd) * 0.06).toFixed(2)} USD
                </Text>
                <View style={[
                  styles.payoutItemStatusPill,
                  reservePayout?.status === 'SUCCESS' && styles.payoutStatusPaid,
                  (reservePayout?.status === 'FAILED' || reservePayout?.status === 'FAILED_UNKNOWN') && styles.payoutStatusFailed
                ]}>
                  <Text style={[
                    styles.payoutItemStatusText,
                    reservePayout?.status === 'SUCCESS' && styles.payoutStatusPaidText,
                    (reservePayout?.status === 'FAILED' || reservePayout?.status === 'FAILED_UNKNOWN') && styles.payoutStatusFailedText
                  ]}>
                    {reservePayout?.status === 'SUCCESS' ? 'PAID' : (reservePayout?.status || (payout?.payoutStatus === 'SUCCESS' ? 'PAID' : (payout?.payoutStatus || 'PENDING')))}
                  </Text>
                </View>
              </View>
            </View>

            {/* Item 4: Platform Retained (4%) */}
            <View style={styles.payoutItemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.payoutItemTitle}>RETAINED (not a PayPal payout)</Text>
                <Text style={styles.payoutItemDesc}>Retained (before PayPal fees)</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.payoutItemAmount}>
                  ${retainedAmountUsd} USD
                </Text>
                <View style={[styles.payoutItemStatusPill, { backgroundColor: '#F1F5F9', borderColor: '#CBD5E1' }]}>
                  <Text style={[styles.payoutItemStatusText, { color: '#475569' }]}>
                    RETAINED
                  </Text>
                </View>
              </View>
            </View>

            {/* Optional Item 5: PayPal Sandbox Fee */}
            {paypalFee ? (
              <View style={[styles.payoutItemRow, { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.payoutItemTitle}>PayPal sandbox fee</Text>
                  <Text style={styles.payoutItemDesc}>Deducted by PayPal from business balance</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.payoutItemAmount, { color: '#64748B' }]}>
                    -${paypalFee} USD
                  </Text>
                  <View style={[styles.payoutItemStatusPill, { backgroundColor: '#F1F5F9', borderColor: '#CBD5E1' }]}>
                    <Text style={[styles.payoutItemStatusText, { color: '#64748B' }]}>
                      FEE
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}

            {/* Failure Warning Box with Retry Button */}
            {(payout?.payoutStatus === 'FAILED' || payout?.payoutStatus === 'FAILED_UNKNOWN') && (
              <View style={styles.payoutFailureBox}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                  <Ionicons name="alert-circle" size={16} color="#DC2626" />
                  <Text style={styles.payoutFailureTitle}>Payout not completed</Text>
                </View>
                <Text style={styles.payoutFailureDesc}>
                  Error: {payout.error?.errorName || 'PAYOUT_FAILED'}
                  {payout.error?.debugId && payout.error.debugId !== 'none' ? ` (Debug ID: ${payout.error.debugId})` : ''}
                </Text>
                <TouchableOpacity
                  style={styles.payoutRetryBtn}
                  onPress={handleRetryPayout}
                  disabled={isRetryingPayout}
                  activeOpacity={0.8}
                >
                  {isRetryingPayout ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name="reload" size={14} color="#FFFFFF" />
                      <Text style={styles.payoutRetryBtnText}>Retry Payout</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Verified Server Facts Table Card (Stage 5.2) */}
        {isPayPal && (
          <View style={styles.factsCard}>
            <View style={styles.factsHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Ionicons name="shield-checkmark" size={18} color="#0070BA" />
                <View style={{ marginLeft: 8 }}>
                  <Text style={styles.factsHeaderTitle}>VERIFIED SERVER FACTS TABLE</Text>
                  <Text style={styles.factsHeaderSub}>Deterministic settlementEngine breakdown</Text>
                </View>
              </View>
              <View style={styles.factsDeterministicTag}>
                <Text style={styles.factsDeterministicText}>AUDITED</Text>
              </View>
            </View>
            <View style={styles.factsDivider} />
            <View style={styles.factsRow}>
              <Text style={styles.factsLabel}>Base Service Rate</Text>
              <Text style={styles.factsVal}>₹{currentBooking?.base_amount || currentBooking?.service?.start_price || 99}</Text>
            </View>
            {extraWorkCost > 0 && (
              <View style={styles.factsRow}>
                <Text style={styles.factsLabel}>Approved Extra Work</Text>
                <Text style={styles.factsVal}>+₹{extraWorkCost}</Text>
              </View>
            )}
            {partOrderCost > 0 && (
              <View style={styles.factsRow}>
                <Text style={styles.factsLabel}>Procured Spare Parts</Text>
                <Text style={styles.factsVal}>+₹{partOrderCost}</Text>
              </View>
            )}
            <View style={styles.factsRow}>
              <Text style={styles.factsLabel}>Total Final Bill</Text>
              <Text style={[styles.factsVal, { fontWeight: '800', color: colors.primary }]}>
                ${isHoldForHuman ? '0.00' : capturedUsd} USD (₹{amountPaid})
              </Text>
            </View>
            <View style={styles.factsRow}>
              <Text style={styles.factsLabel}>Pre-Authorized Ceiling</Text>
              <Text style={styles.factsVal}>${holdCeilingUsd} USD</Text>
            </View>
            {isCaptured && (
              <View style={styles.factsRow}>
                <Text style={styles.factsLabel}>Cooperative Reserve Retained</Text>
                <Text style={styles.factsVal}>${retainedAmountUsd} USD</Text>
              </View>
            )}
            {paypalFee && isCaptured && (
              <View style={[styles.factsRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.factsLabel}>PayPal Sandbox Fee</Text>
                <Text style={styles.factsVal}>${paypalFee} USD</Text>
              </View>
            )}
          </View>
        )}

        {/* Completion Receipt Card (Stage 5.2) */}
        {isPayPal && settlementReceipt && (
          <View style={styles.receiptCard}>
            <View style={styles.receiptHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Ionicons name="chatbubble-ellipses" size={18} color={colors.primary} />
                <View style={{ marginLeft: 8 }}>
                  <Text style={styles.receiptHeaderTitle}>COMPLETION RECEIPT</Text>
                  <Text style={styles.receiptHeaderSub}>Qualitative natural language note</Text>
                </View>
              </View>
              <View style={styles.digitFreeBadge}>
                <Ionicons name="checkmark-circle" size={12} color="#16A34A" />
                <Text style={styles.digitFreeBadgeText}>DIGIT-FREE</Text>
              </View>
            </View>
            <View style={styles.receiptDivider} />
            <View style={styles.receiptSection}>
              <Text style={styles.receiptLangTag}>English Note</Text>
              <Text style={styles.receiptBodyText}>{settlementReceipt.receipt_english}</Text>
            </View>
            {settlementReceipt.receipt_customer_language && (
              <View style={[styles.receiptSection, { marginTop: 10 }]}>
                <Text style={styles.receiptLangTag}>Customer Language Note</Text>
                <Text style={styles.receiptBodyText}>{settlementReceipt.receipt_customer_language}</Text>
              </View>
            )}
          </View>
        )}

        {/* Persisted Settlement Agent Audit Trace (Stage 5.2) */}
        {isPayPal && settlementTrace && (
          <View style={styles.traceCard}>
            <TouchableOpacity
              style={styles.traceHeader}
              onPress={() => setShowTrace(!showTrace)}
              activeOpacity={0.7}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <Ionicons name="git-network-outline" size={20} color="#0070BA" />
                <View style={{ marginLeft: 8, flex: 1 }}>
                  <Text style={styles.traceHeaderTitle}>SETTLEMENT AGENT AUDIT TRACE</Text>
                  <Text style={styles.traceHeaderSub}>
                    {settlementTrace.steps?.length || 0} steps • Mode: {settlementMode || 'AI_AGENT'}
                  </Text>
                </View>
              </View>
              <Ionicons
                name={showTrace ? "chevron-up" : "chevron-down"}
                size={20}
                color="#64748B"
              />
            </TouchableOpacity>

            {showTrace && (
              <View style={styles.traceBody}>
                <View style={styles.traceDivider} />
                {(settlementTrace.steps || []).map((step, idx) => (
                  <View key={idx} style={styles.traceStepItem}>
                    <View style={styles.traceStepDot} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={styles.traceStepType}>
                          Step {step.step}: {step.type.replace(/_/g, ' ').toUpperCase()}
                        </Text>
                        <Text style={styles.traceStepTime}>
                          {step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : ''}
                        </Text>
                      </View>
                      {step.tool && (
                        <Text style={styles.traceStepDetail}>
                          Tool: <Text style={{ fontWeight: '700' }}>{step.tool}</Text>
                          {step.args?.amount_usd_cents ? ` • Amount: ${step.args.amount_usd_cents}¢` : ''}
                        </Text>
                      )}
                      {step.elapsed_ms !== undefined && (
                        <Text style={styles.traceStepDetail}>
                          Call Duration: {step.elapsed_ms}ms {step.retried ? '(retried)' : ''}
                        </Text>
                      )}
                      {step.decision && (
                        <Text style={[styles.traceStepDetail, { fontWeight: '800', color: step.decision === 'APPROVE' ? '#16A34A' : '#B45309' }]}>
                          Outcome: {step.decision} {step.hold_reason ? `(${step.hold_reason})` : ''}
                        </Text>
                      )}
                      {step.guard && (
                        <Text style={[styles.traceStepDetail, { color: '#DC2626', fontWeight: '700' }]}>
                          Guard Rejection: {step.guard} (attempt {step.attempt})
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Advance Payment Confirmation & Team Contact Assurance Banner */}
        {isScheduledOrAdvance && (
          <View style={styles.advanceContactCard}>
            <View style={styles.advanceContactHeader}>
              <View style={styles.advanceContactIconCircle}>
                <Ionicons name="call" size={18} color="#FFFFFF" />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.advanceContactTag}>{t('advanceMilestoneSecured') || 'ADVANCE MILESTONE ESCROW SECURED'}</Text>
                <Text style={styles.advanceContactTitle}>{t('teamContactTitle') || 'Our Team Will Contact You Before Arrival'}</Text>
              </View>
            </View>

            <Text style={styles.advanceContactDesc}>
              {t('advanceEscrowDesc') || `Your advance payment of ₹${amountPaid} is securely held in UniServ Pay Escrow (sandbox). Our cooperative dispatch team and Lead Supervisor will call you 2 hours before the scheduled time on your registered mobile number.`}
            </Text>

            <View style={styles.contactDetailsBox}>
              <Text style={styles.contactDetailsLabel}>{t('schedulingDetailsAssistance') || 'FOR SCHEDULING DETAILS OR ASSISTANCE:'}</Text>
              <View style={styles.contactRow}>
                <Ionicons name="person-circle-outline" size={16} color={colors.primary} />
                <Text style={styles.contactRowText}>
                  {t('contactPerson') || 'Contact Person'}: {workerName ? `${workerName} (${t('leadSupervisor') || 'Lead Supervisor'})` : (t('wardCoordinator') || 'District Ward Coordinator')}
                </Text>
              </View>
              <View style={styles.contactRow}>
                <Ionicons name="call-outline" size={16} color={colors.primary} />
                <Text style={styles.contactRowText}>
                  {t('helpline') || 'Helpline'}: +91 98765 43210 ({t('coopDispatchDesk') || 'Direct Co-op Federation Dispatch Desk'})
                </Text>
              </View>
              <View style={styles.contactRow}>
                <Ionicons name="calendar-outline" size={16} color={colors.primary} />
                <Text style={styles.contactRowText}>
                  {t('scheduledSlot') || 'Scheduled Slot'}: {activeBooking?.scheduled_date || (t('tomorrow') || 'Tomorrow')} • {activeBooking?.scheduled_time || '10:00 AM'}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* 7-Day Warranty ONLY if category is eligible for Seva Suraksha */}
        {hasWarranty ? (
          <View style={styles.warrantySummaryCard}>
            <View style={styles.warrantyHeaderRow}>
              <Ionicons name="shield-checkmark" size={20} color={colors.success} />
              <Text style={styles.warrantyTitle}>{t('warrantyActivated')}</Text>
            </View>
            <Text style={styles.warrantyDesc}>
              {t('sevaSurakshaDesc') || 'Your repair is fully protected under Seva Suraksha for 7 days. Free doorstep rework if any technical defect reoccurs.'}
            </Text>
          </View>
        ) : (
          <View style={[styles.warrantySummaryCard, { backgroundColor: colors.primarySubtle }]}>
            <View style={styles.warrantyHeaderRow}>
              <Ionicons name="sparkles" size={18} color={colors.primary} />
              <Text style={[styles.warrantyTitle, { color: colors.primary }]}>{t('coopServiceVerified') || 'Cooperative Service Delivery Verified'}</Text>
            </View>
            <Text style={[styles.warrantyDesc, { color: colors.primaryText }]}>
              {t('empoweringCoopDesc') || 'Service completed with standardized cooperative rates. Thank you for empowering local artisan cooperatives!'}
            </Text>
          </View>
        )}

        {/* The 80% Fair Wage Breakdown Card */}
        <View style={styles.breakdownWrap}>
          <PaymentBreakdown totalAmount={amountPaid} />
        </View>

        {/* Invoice Download Action */}
        <TouchableOpacity
          style={styles.invoiceBtn}
          onPress={() => setInvoiceModalVisible(true)}
          activeOpacity={0.8}
        >
          <Ionicons name="document-text-outline" size={18} color={colors.primary} />
          <Text style={styles.invoiceBtnText}>{t('downloadInvoice')}</Text>
        </TouchableOpacity>

        {/* Rate Experience Button */}
        <TouchableOpacity
          style={styles.rateBtn}
          onPress={handleRateExperience}
          activeOpacity={0.85}
        >
          <Ionicons name="star" size={18} color="#FFFFFF" />
          <Text style={styles.rateBtnText}>{t('rateExperience')}</Text>
          <Ionicons name="arrow-forward" size={16} color="#FFFFFF" style={{ marginLeft: 4 }} />
        </TouchableOpacity>
      </ScrollView>

      {/* Invoice Modal */}
      <Modal visible={invoiceModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.invoiceCard}>
            <View style={styles.invoiceHeader}>
              <View>
                <Text style={styles.invoiceBrand}>UniServ Cooperative Platform</Text>
                <Text style={styles.invoiceSub}>{t('officialTaxInvoice') || 'Official Service Tax Invoice'}</Text>
              </View>
              <TouchableOpacity onPress={() => setInvoiceModalVisible(false)}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.invoiceBody}>
              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceKey}>{t('invoiceNo') || 'Invoice No'}:</Text>
                <Text style={styles.invoiceVal}>INV-{bookingId}-2026</Text>
              </View>
              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceKey}>{t('dateTime') || 'Date & Time'}:</Text>
                <Text style={styles.invoiceVal}>
                  {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}, {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceKey}>{t('serviceCategory') || 'Service Category'}:</Text>
                <Text style={styles.invoiceVal}>{serviceName}</Text>
              </View>
              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceKey}>{t('leadArtisan') || 'Lead Artisan'}:</Text>
                <Text style={styles.invoiceVal}>{workerName}</Text>
              </View>
              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceKey}>{t('cooperativeSociety') || 'Cooperative Society'}:</Text>
                <Text style={styles.invoiceVal}>{t('delhiLabourCooperative') || 'Delhi Labour Cooperative Union'}</Text>
              </View>

              <View style={styles.invoiceDivider} />

              <Text style={styles.itemizedModalTitle}>{t('itemizedServiceCharges') || 'ITEMIZED SERVICE CHARGES'}</Text>

              {/* Base Rate */}
              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceKey}>{t('baseDiagnostic') || 'Base Diagnostic / Rate'}:</Text>
                <Text style={styles.invoiceVal}>₹{baseRate}</Text>
              </View>

              {/* Additional Multi-Artisans */}
              {workerCount > 1 && (
                <View style={styles.invoiceRow}>
                  <Text style={[styles.invoiceKey, { color: colors.primary }]}>+{workerCount - 1} {t('additionalCoopArtisans') || 'Extra Artisans'}:</Text>
                  <Text style={[styles.invoiceVal, { color: colors.primary }]}>+₹{extraWorkerCost}</Text>
                </View>
              )}

              {/* Emergency Surge */}
              {emergencySurge > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={[styles.invoiceKey, { color: colors.error }]}>{t('emergencySurgeFee') || 'Emergency Surge'}:</Text>
                  <Text style={[styles.invoiceVal, { color: colors.error }]}>+₹{emergencySurge}</Text>
                </View>
              )}

              {/* Approved Extra Work */}
              {extraWorkCost > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={styles.invoiceKey} numberOfLines={1}>{activeBooking?.extra_work?.title || t('spares') || 'Extra Work / Spares'}:</Text>
                  <Text style={styles.invoiceVal}>+₹{extraWorkCost}</Text>
                </View>
              )}

              {/* Procured Spare Part */}
              {partOrderCost > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={[styles.invoiceKey, { color: colors.successDark }]} numberOfLines={1}>
                    {activeBooking?.part_order?.part_name || 'Procured Component'}:
                  </Text>
                  <Text style={[styles.invoiceVal, { color: colors.successDark }]}>+₹{partOrderCost}</Text>
                </View>
              )}

              {/* 2nd Assistant Artisan */}
              {helperCost > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={styles.invoiceKey}>{t('secondAssistant') || '2nd Assistant Artisan'}:</Text>
                  <Text style={styles.invoiceVal}>+₹{helperCost}</Text>
                </View>
              )}

              {/* Overtime Surcharge */}
              {overtimeCharge > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={[styles.invoiceKey, { color: '#B45309' }]}>{t('overtimeCharge') || 'Overtime (>2 hrs)'}:</Text>
                  <Text style={[styles.invoiceVal, { color: '#B45309' }]}>+₹{overtimeCharge}</Text>
                </View>
              )}

              {/* Previous Cancellation Penalty */}
              {cancellationPenalty > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={[styles.invoiceKey, { color: colors.danger }]}>{t('previousCancellationPenalty') || 'Previous Cancel Fee'}:</Text>
                  <Text style={[styles.invoiceVal, { color: colors.danger }]}>+₹{cancellationPenalty}</Text>
                </View>
              )}

              {/* First-Time Discount */}
              {discountApplied > 0 && (
                <View style={styles.invoiceRow}>
                  <Text style={[styles.invoiceKey, { color: colors.successDark }]}>{t('firstTimeDiscount') || 'Welcome Discount'}:</Text>
                  <Text style={[styles.invoiceVal, { color: colors.successDark }]}>-₹{discountApplied}</Text>
                </View>
              )}

              <View style={styles.invoiceDivider} />

              <View style={styles.invoiceRow}>
                <Text style={styles.invoiceTotalKey}>{t('totalAmountSettled') || 'Total Amount Settled'}:</Text>
                <Text style={styles.invoiceTotalVal}>₹{amountPaid}.00</Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.downloadPdfBtn}
              onPress={handleDownloadInvoicePdf}
            >
              <Ionicons name="download-outline" size={18} color="#FFFFFF" />
              <Text style={styles.downloadPdfText}>{t('downloadInvoice')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 40
  },
  successHero: {
    alignItems: 'center',
    marginBottom: 20
  },
  successIconCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.success,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
    marginBottom: 12
  },
  successTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textPrimary
  },
  paidAmountText: {
    fontSize: 34,
    fontWeight: '900',
    color: colors.primary,
    marginTop: 4
  },
  txnPill: {
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border
  },
  txnPillText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '600'
  },
  warrantySummaryCard: {
    backgroundColor: colors.successLight,
    borderRadius: 18,
    padding: 16,
    marginBottom: 16
  },
  warrantyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4
  },
  warrantyTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.successDark,
    marginLeft: 6
  },
  warrantyDesc: {
    fontSize: 11,
    color: colors.successDark,
    lineHeight: 16,
    marginTop: 2
  },
  breakdownWrap: {
    marginBottom: 16
  },
  invoiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.primaryLight,
    marginBottom: 12
  },
  invoiceBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
    marginLeft: 6
  },
  rateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 16,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4
  },
  rateBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
    marginLeft: 6
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    justifyContent: 'center',
    paddingHorizontal: 20
  },
  invoiceCard: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    padding: 20
  },
  invoiceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16
  },
  invoiceBrand: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary
  },
  invoiceSub: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2
  },
  invoiceBody: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16
  },
  itemizedModalTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.5,
    marginTop: 4,
    marginBottom: 6
  },
  invoiceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 4
  },
  invoiceKey: {
    fontSize: 12,
    color: colors.textSecondary
  },
  invoiceVal: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textPrimary
  },
  invoiceDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 8
  },
  invoiceTotalKey: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textPrimary
  },
  invoiceTotalVal: {
    fontSize: 15,
    fontWeight: '900',
    color: colors.primary
  },
  downloadPdfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 12
  },
  downloadPdfText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    marginLeft: 6
  },
  advanceContactCard: {
    backgroundColor: '#F0FDF4',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1.5,
    borderColor: colors.success,
    marginBottom: 16
  },
  advanceContactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8
  },
  advanceContactIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.successDark,
    alignItems: 'center',
    justifyContent: 'center'
  },
  advanceContactTag: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.successDark,
    letterSpacing: 0.5
  },
  advanceContactTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary
  },
  advanceContactDesc: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
    marginBottom: 12
  },
  contactDetailsBox: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8
  },
  contactDetailsLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.5
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  contactRowText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textPrimary,
    marginLeft: 6,
    flex: 1
  },
  paypalSettledCard: {
    backgroundColor: '#F0F9FF',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#BAE6FD',
    padding: 14,
    marginBottom: 16
  },
  paypalSettledHeader: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  paypalSettledBadgeTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: '#0369A1',
    letterSpacing: 0.5
  },
  paypalSettledIdText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 2
  },
  paypalSettledPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  paypalSettledPillText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#16A34A',
    marginLeft: 3
  },
  paypalSettledDivider: {
    height: 1,
    backgroundColor: '#E0F2FE',
    marginVertical: 10
  },
  paypalSettledDesc: {
    fontSize: 11,
    color: '#0369A1',
    lineHeight: 16
  },
  payoutCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#BAE6FD',
    padding: 14,
    marginBottom: 16,
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2
  },
  payoutHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  payoutHeaderTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: '#0369A1',
    letterSpacing: 0.5
  },
  payoutHeaderSub: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '600'
  },
  payoutBatchPill: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#BFDBFE'
  },
  payoutBatchPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#1D4ED8'
  },
  payoutRefreshBtn: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: '#F0F9FF',
    borderWidth: 1,
    borderColor: '#BAE6FD'
  },
  payoutDivider: {
    height: 1,
    backgroundColor: '#E0F2FE',
    marginVertical: 10
  },
  payoutItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9'
  },
  payoutItemTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A'
  },
  payoutItemDesc: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1
  },
  payoutItemAmount: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A'
  },
  payoutItemStatusPill: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    marginTop: 2
  },
  payoutItemStatusText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#B45309'
  },
  payoutStatusPaid: {
    backgroundColor: '#DCFCE7',
    borderColor: '#86EFAC'
  },
  payoutStatusPaidText: {
    color: '#15803D'
  },
  payoutStatusFailed: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5'
  },
  payoutStatusFailedText: {
    color: '#DC2626'
  },
  payoutFailureBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FECACA',
    padding: 10,
    marginTop: 10
  },
  payoutFailureTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#DC2626',
    marginLeft: 4
  },
  payoutFailureDesc: {
    fontSize: 11,
    color: '#7F1D1D',
    marginBottom: 8
  },
  payoutRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignSelf: 'flex-start',
    gap: 4
  },
  payoutRetryBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF'
  },
  payoutSkippedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 8,
    marginBottom: 8,
    gap: 6
  },
  payoutSkippedText: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '600',
    flex: 1
  },
  modeBadge: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    marginLeft: 6
  },
  modeBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#4338CA'
  },
  factsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#0070BA',
    marginBottom: 16,
    shadowColor: '#0070BA',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2
  },
  factsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  factsHeaderTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: 0.5
  },
  factsHeaderSub: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1
  },
  factsDeterministicTag: {
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  factsDeterministicText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#0284C7'
  },
  factsDivider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 10
  },
  factsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F8FAFC'
  },
  factsLabel: {
    fontSize: 12,
    color: '#475569'
  },
  factsVal: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A'
  },
  receiptCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 16
  },
  receiptHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  receiptHeaderTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: 0.5
  },
  receiptHeaderSub: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1
  },
  digitFreeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3
  },
  digitFreeBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#16A34A'
  },
  receiptDivider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 10
  },
  receiptSection: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0'
  },
  receiptLangTag: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.primary,
    marginBottom: 4,
    textTransform: 'uppercase'
  },
  receiptBodyText: {
    fontSize: 12,
    color: '#1E293B',
    lineHeight: 18,
    fontStyle: 'italic'
  },
  traceCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    marginBottom: 16
  },
  traceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  traceHeaderTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: 0.5
  },
  traceHeaderSub: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1
  },
  traceBody: {
    marginTop: 8
  },
  traceDivider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginBottom: 10
  },
  traceStepItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10
  },
  traceStepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#0070BA',
    marginTop: 4
  },
  traceStepType: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0F172A'
  },
  traceStepTime: {
    fontSize: 10,
    color: '#94A3B8'
  },
  traceStepDetail: {
    fontSize: 10,
    color: '#475569',
    marginTop: 2
  }
});

export default Screen13_PaymentSuccess;
