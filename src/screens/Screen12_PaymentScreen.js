import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useBooking } from '../context/BookingContext';
import { useUser } from '../context/UserContext';
import Header from '../components/Header';
import PaymentBreakdown from '../components/PaymentBreakdown';
import Screen12_BulkPaymentScreen from './Screen12_BulkPaymentScreen';
import { fetchBillPreview, captureOrder, settleWithAgent, fetchSettlementStatus } from '../utils/jobTelemetry';

export const Screen12_PaymentScreen = ({ route, navigation }) => {
  const { activeBooking, totalAmount, completePayment, isFirstTimeUser, FIRST_TIME_DISCOUNT, computeTotal } = useBooking();
  const { user, t } = useUser();

  const currentBooking = activeBooking || route?.params?.booking;

  // If bulk project is active, delegate directly to dedicated Bulk Payment Screen
  if (currentBooking?.is_bulk_project) {
    return <Screen12_BulkPaymentScreen navigation={navigation} />;
  }

  const [selectedMethod, setSelectedMethod] = useState('UPI');
  const [upiId, setUpiId] = useState('priya.sharma@okaxis');
  const [isProcessing, setIsProcessing] = useState(false);

  const isPayPal = currentBooking?.payment_method === 'PAYPAL_SANDBOX' || Boolean(currentBooking?.paypal_authorization_id);

  const [billPreview, setBillPreview] = useState(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(isPayPal);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isAgentAuditing, setIsAgentAuditing] = useState(false);
  const [auditElapsed, setAuditElapsed] = useState(0);
  const [isStillWorking, setIsStillWorking] = useState(false);
  const [captureError, setCaptureError] = useState(null);

  useEffect(() => {
    if (!isPayPal) {
      setIsPreviewLoading(false);
      return;
    }
    const targetBookingId = currentBooking?.paypal_booking_id || currentBooking?.bookingId || currentBooking?.booking_id;
    if (!targetBookingId) {
      setIsPreviewLoading(false);
      return;
    }
    setIsPreviewLoading(true);
    fetchBillPreview(targetBookingId)
      .then((preview) => {
        if (preview) {
          setBillPreview(preview);
        }
      })
      .catch((e) => {
        console.warn('Failed to load bill preview:', e);
      })
      .finally(() => {
        setIsPreviewLoading(false);
      });
  }, [
    isPayPal,
    currentBooking?.paypal_booking_id,
    currentBooking?.bookingId,
    currentBooking?.booking_id
  ]);

  const PAYMENT_METHODS = [
    { id: 'UPI', label: t('instantUpi') || 'Instant UPI / Cooperative Wallet', icon: 'flash', badge: t('fastest') || 'Fastest' },
    { id: 'Card', label: t('cardPayment') || 'Credit / Debit Card', icon: 'card', badge: null },
    { id: 'Wallet', label: t('coopWallet') || 'Cooperative Citizen Wallet', icon: 'wallet', badge: `₹500 ${t('balance') || 'Balance'}` },
    { id: 'Cash', label: t('codPayment') || 'Cash on Delivery', icon: 'cash', badge: null }
  ];

  // Dynamic final amount calculation for solo service
  const amountToPay = computeTotal ? computeTotal(currentBooking) : (totalAmount || currentBooking?.total_amount || 350);
  const finalBillRupees = billPreview ? billPreview.totalRupees : amountToPay;
  const finalBillUsd = billPreview
    ? billPreview.finalAmountUsd
    : (Math.round((finalBillRupees * 100) / 85) / 100).toFixed(2);
  const authorizedHoldUsd = currentBooking?.paypal_authorized_usd || billPreview?.authorizedAmountUsd || '1.45';

  const handlePay = async () => {
    if (isProcessing || isCapturing || isAgentAuditing) return; // Prevent double-tap!

    if (isPayPal) {
      setIsAgentAuditing(true);
      setCaptureError(null);
      setAuditElapsed(0);
      setIsStillWorking(false);

      const targetBookingId = currentBooking?.paypal_booking_id || currentBooking?.bookingId || currentBooking?.booking_id;
      if (!targetBookingId) {
        setIsAgentAuditing(false);
        Alert.alert('Error', 'Missing booking ID for settlement');
        return;
      }

      // Elapsed timer & 45s fallback poller
      let elapsedSeconds = 0;
      let pollInterval = null;
      const timer = setInterval(() => {
        elapsedSeconds++;
        setAuditElapsed(elapsedSeconds);
        if (elapsedSeconds > 45) {
          setIsStillWorking(true);
          if (!pollInterval) {
            pollInterval = setInterval(async () => {
              try {
                const pollData = await fetchSettlementStatus(targetBookingId);
                if (pollData && (pollData.settlementStatus === 'COMPLETED' || pollData.decision)) {
                  clearInterval(timer);
                  clearInterval(pollInterval);
                  finishSettlement(pollData);
                }
              } catch (e) {}
            }, 2500);
          }
        }
      }, 1000);

      function finishSettlement(settlementResult) {
        clearInterval(timer);
        if (pollInterval) clearInterval(pollInterval);
        setIsAgentAuditing(false);

        const isHeld = settlementResult.decision === 'HOLD_FOR_HUMAN';
        const capture = settlementResult.captureResult;
        const capturedUsdVal = capture?.captured_cents
          ? (capture.captured_cents / 100).toFixed(2)
          : (settlementResult.capturedAmountUsd || (isHeld ? '0.00' : finalBillUsd));

        if (typeof completePayment === 'function') {
          completePayment('PAYPAL_SANDBOX', {
            paypal_capture_id: capture?.capture_id || settlementResult.captureId,
            paypal_capture_status: capture?.status || (isHeld ? 'HELD' : 'COMPLETED'),
            paypal_captured_usd: capturedUsdVal,
            paypal_status: isHeld ? 'HOLD_FOR_HUMAN' : 'CAPTURED',
            paypal_hold_reason: settlementResult.holdReason,
            paid_amount: isHeld ? 0 : finalBillRupees
          });
        }

        navigation.navigate('PaymentSuccess', {
          booking: {
            ...currentBooking,
            paypal_capture_id: capture?.capture_id || settlementResult.captureId,
            paypal_capture_status: capture?.status || (isHeld ? 'HELD' : 'COMPLETED'),
            paypal_captured_usd: capturedUsdVal,
            paypal_status: isHeld ? 'HOLD_FOR_HUMAN' : 'CAPTURED',
            paypal_hold_reason: settlementResult.holdReason,
            paid_amount: isHeld ? 0 : finalBillRupees,
            settlement_trace: settlementResult.trace,
            settlement_receipt: settlementResult.receipt,
            settlement_decision: settlementResult.decision,
            settlement_mode: settlementResult.mode
          },
          settlementResult,
          captureResult: capture ? {
            captureId: capture.capture_id,
            captureStatus: capture.status,
            capturedAmountUsd: capturedUsdVal,
            status: isHeld ? 'HOLD_FOR_HUMAN' : 'CAPTURED',
            holdReason: settlementResult.holdReason,
            paypalFeeUsd: capture.paypal_fee_usd,
            payout: settlementResult.payout
          } : {
            status: isHeld ? 'HOLD_FOR_HUMAN' : 'CAPTURED',
            holdReason: settlementResult.holdReason,
            payout: settlementResult.payout
          }
        });
      }

      try {
        const result = await settleWithAgent({
          bookingId: targetBookingId,
          customerLanguageCode: user?.language || 'en'
        });

        if (result && result.settlementStatus === 'COMPLETED') {
          finishSettlement(result);
        } else if (result && result.inProgress) {
          setIsStillWorking(true);
        } else {
          finishSettlement(result);
        }
      } catch (err) {
        clearInterval(timer);
        if (pollInterval) clearInterval(pollInterval);
        setIsAgentAuditing(false);
        console.error('AI settlement error:', err);
        setCaptureError(err.message || 'Settlement failed');
        Alert.alert(
          'Settlement Notice',
          `${err.message || 'Could not complete settlement'}${err.error ? `\n(${err.error})` : ''}`
        );
      }
      return;
    }

    // Standard non-PayPal payment flow
    setIsProcessing(true);
    setTimeout(() => {
      try {
        if (typeof completePayment === 'function') {
          completePayment(selectedMethod);
        }
      } catch (err) {
        console.error('Payment completion err:', err);
      } finally {
        setIsProcessing(false);
        navigation.navigate('PaymentSuccess', { booking: currentBooking });
      }
    }, 1000);
  };

  const isExtraApproved = currentBooking?.extra_work?.approved;
  const isHelperApproved = currentBooking?.second_worker || currentBooking?.helper_request?.status === 'approved';

  if (!currentBooking) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <Header
          title={t('paymentSettlement') || 'Payment Settlement'}
          showBack
          onBack={() => navigation.navigate('Home')}
        />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Ionicons name="card-outline" size={48} color={colors.primary} />
          <Text style={{ fontSize: 18, fontWeight: '800', color: colors.textPrimary, marginTop: 16 }}>
            No Active Bill Found
          </Text>
          <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 18 }}>
            There is currently no active booking awaiting payment on this account.
          </Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 24, width: '100%', maxWidth: 360 }}>
            <TouchableOpacity
              style={[styles.payBtn, { flex: 1, paddingHorizontal: 16 }]}
              onPress={() => navigation.navigate('Home')}
            >
              <Text style={styles.payBtnText}>Return to Home</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.payBtn, { flex: 1, paddingHorizontal: 16, backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1' }]}
              onPress={() => {
                try {
                  navigation.navigate('MainTabs', { screen: 'BookingsTab' });
                } catch (e) {
                  navigation.navigate('Home');
                }
              }}
            >
              <Text style={[styles.payBtnText, { color: '#334155' }]}>Past Bookings</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <Header
        title={t('paymentSettlement') || 'Payment Settlement'}
        showBack
        onBack={() => navigation.goBack()}
      />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Payable Amount Card */}
        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>
            {isPayPal ? 'TOTAL PAYABLE (FINAL SERVICE SETTLEMENT)' : t('totalPayable')}
          </Text>
          <Text style={styles.amountVal}>
            {isPayPal ? `$${finalBillUsd} USD` : `₹${amountToPay}`}
          </Text>
          {isPayPal && (
            <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4, fontWeight: '600' }}>
              Equivalent to ₹${finalBillRupees} (1 USD = 85.00 INR sandbox demo rate)
            </Text>
          )}
          {isPayPal && billPreview?.demoTimeScale && (
            <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginTop: 6, borderWidth: 1, borderColor: '#FDE68A' }}>
              <Text style={{ fontSize: 10, fontWeight: '800', color: '#92400E' }}>
                DEMO TIME SCALE: {billPreview.demoTimeScale}x
              </Text>
            </View>
          )}
          <View style={styles.bookingRefRow}>
            <Text style={styles.bookingRefText}>{t('bookingId') || 'Booking ID'}: {currentBooking?.booking_id || 'BK84920'}</Text>
            <View style={styles.verifiedTag}>
              <Ionicons name="checkmark-circle" size={12} color={colors.successDark} />
              <Text style={styles.verifiedTagText}>{t('workVerified') || 'Work Verified'}</Text>
            </View>
          </View>
        </View>

        {/* PayPal Sandbox Authorization Hold Banner */}
        {isPayPal && (
          <View style={styles.paypalAuthCard}>
            <View style={styles.paypalAuthHeader}>
              <Ionicons name="card" size={20} color="#0070BA" />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.paypalAuthBadgeTitle}>
                  {currentBooking?.paypal_mode === 'SIMULATED'
                    ? 'PAYPAL SIMULATED AUTHORIZATION HOLD (DEMO)'
                    : 'PAYPAL SANDBOX AUTHORIZATION HOLD'}
                </Text>
                <Text style={styles.paypalAuthIdText}>
                  Auth ID: {currentBooking.paypal_authorization_id}
                </Text>
              </View>
              <View style={styles.paypalStatusPill}>
                <Text style={styles.paypalStatusPillText}>HELD IN SANDBOX</Text>
              </View>
            </View>
            <View style={styles.paypalAuthDivider} />
            <View style={styles.paypalAuthDetailsRow}>
              <Text style={styles.paypalAuthDetailText}>
                Maximum hold:{' '}
                <Text style={{ fontWeight: '800', color: '#0F172A' }}>
                  ${authorizedHoldUsd} USD
                </Text>
              </Text>
              <Text style={styles.paypalAuthDetailText}>
                Payer:{' '}
                <Text style={{ fontWeight: '700', color: '#0F172A' }}>
                  {currentBooking.paypal_payer?.name || user?.name || 'Customer'}
                </Text>
              </Text>
            </View>
            <Text style={styles.paypalAuthNotice}>
              Settlement captures strictly the final bill (${finalBillUsd} USD) against this hold ceiling.
            </Text>
          </View>
        )}

        {/* Settlement Agent Auditing Progress Card (Stage 5.2) */}
        {isPayPal && isAgentAuditing && (
          <View style={styles.agentAuditingCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.agentPulseCircle}>
                <ActivityIndicator size="small" color="#0070BA" />
              </View>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.agentAuditingTitle}>Settlement agent is auditing the job</Text>
                <Text style={styles.agentAuditingSubtitle}>
                  {isStillWorking
                    ? 'Still working on verification... polling audit state from server'
                    : 'Verifying service telemetry, anomaly policy rules, and cooperative split quotas...'}
                </Text>
              </View>
            </View>
            <View style={styles.agentAuditingTimerRow}>
              <View style={styles.agentTimerBadge}>
                <Ionicons name="timer-outline" size={13} color="#0070BA" />
                <Text style={styles.agentTimerText}>{auditElapsed}s elapsed</Text>
              </View>
              <Text style={styles.agentGuardedText}>Autonomous AI Audit • Strict Server Guards Active</Text>
            </View>
          </View>
        )}

        {/* Itemized Cost Breakdown Card */}
        <View style={styles.itemizedCard}>
          <Text style={styles.itemizedHeader}>{t('itemizedServiceCharges') || 'ITEMIZED SERVICE CHARGES'}</Text>
          
          {/* Base Service Rate (Lead Artisan) */}
          <View style={styles.itemRow}>
            <Text style={styles.itemLabel}>
              {currentBooking?.service?.name || t('homeService') || 'Home Service'} ({currentBooking?.worker_count > 1 ? `${t('leadArtisan') || 'Lead Artisan'}: ` : ''}{currentBooking?.trade_subtype || t('baseDiagnostic') || 'Base Diagnostic'})
            </Text>
            <Text style={styles.itemVal}>
              ₹{currentBooking?.worker_count > 1 ? (currentBooking?.single_worker_base || (currentBooking?.base_amount - (currentBooking?.extra_worker_cost || 0))) : (currentBooking?.base_amount || currentBooking?.service?.start_price || 299)}
            </Text>
          </View>

          {/* Additional Multi-Artisans (Cleaner & Gardener up to 3) */}
          {currentBooking?.worker_count > 1 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                <Ionicons name="people" size={13} color={colors.primary} style={{ marginRight: 4 }} />
                <Text style={[styles.itemLabel, { color: colors.primary, fontWeight: '700' }]} numberOfLines={1}>
                  +{currentBooking.worker_count - 1} {t('additionalCoopArtisans') || 'Additional Cooperative Artisans'} ({currentBooking.worker_count}x {t('speed') || 'Speed'})
                </Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.primary, fontWeight: '800' }]}>
                +₹{currentBooking?.extra_worker_cost || ((currentBooking.worker_count - 1) * 199)}
              </Text>
            </View>
          )}

          {/* Emergency Priority Surge */}
          {currentBooking?.emergency_surge > 0 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="flash" size={13} color={colors.error} style={{ marginRight: 4 }} />
                <Text style={[styles.itemLabel, { color: colors.error }]}>{t('emergencySurgeFee') || 'Emergency Priority Surge'} (&lt;15 min)</Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.error }]}>+₹{currentBooking.emergency_surge}</Text>
            </View>
          )}

          {/* Approved Extra Spare Parts */}
          {isExtraApproved && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                <Ionicons name="construct" size={13} color={colors.primary} style={{ marginRight: 4 }} />
                <Text style={styles.itemLabel} numberOfLines={1}>
                  {currentBooking?.extra_work?.title || t('spares') || 'Approved Spare Parts'}
                </Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.primary }]}>
                +₹{currentBooking?.extra_work?.amount}
              </Text>
            </View>
          )}

          {/* Procured Spare Part / Component (Phase I) */}
          {currentBooking?.part_order?.part_cost > 0 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                <Ionicons name="cog" size={13} color={colors.successDark} style={{ marginRight: 4 }} />
                <Text style={styles.itemLabel} numberOfLines={1}>
                  {currentBooking?.part_order?.part_name || 'Procured Replacement Component'}
                </Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.successDark, fontWeight: '800' }]}>
                +₹{currentBooking.part_order.part_cost}
              </Text>
            </View>
          )}

          {/* Approved 2nd Assistant Artisan */}
          {isHelperApproved && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                <Ionicons name="people" size={13} color={colors.cooperativePurple} style={{ marginRight: 4 }} />
                <Text style={styles.itemLabel} numberOfLines={1}>
                  {t('secondAssistant') || '2nd Assistant Artisan'} ({currentBooking?.second_worker?.name || 'Amit Verma'})
                </Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.cooperativePurple }]}>
                +₹{currentBooking?.helper_request?.amount || currentBooking?.service?.helper_request?.amount || 200}
              </Text>
            </View>
          )}

          {/* Distance Travel Surcharge (>7 km: ₹7/km) */}
          {currentBooking?.distance_charge > 0 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                <Ionicons name="location" size={13} color="#0369A1" style={{ marginRight: 4 }} />
                <View>
                  <Text style={[styles.itemLabel, { color: '#0369A1', fontWeight: '700' }]}>
                    {t('distanceTravelSurcharge') || 'Distance Travel Surcharge'} ({currentBooking?.distance_km || currentBooking?.worker?.distance_km} km)
                  </Text>
                  <Text style={{ fontSize: 10, color: colors.textMuted }}>
                    Standard base covers up to 7 km • ₹7/km for {Math.max(0, Math.round((currentBooking?.distance_km || currentBooking?.worker?.distance_km || 7) - 7))} extra km
                  </Text>
                </View>
              </View>
              <Text style={[styles.itemVal, { color: '#0369A1', fontWeight: '800' }]}>
                +₹{currentBooking.distance_charge}
              </Text>
            </View>
          )}

          {/* Overtime Surcharge (>2 Hours - Phase II) */}
          {currentBooking?.overtime_charge > 0 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="time" size={13} color="#D97706" style={{ marginRight: 4 }} />
                <Text style={[styles.itemLabel, { color: '#B45309', fontWeight: '700' }]}>
                  {t('overtimeCharge') || 'Extended Duration Overtime (>2 hrs)'}
                </Text>
              </View>
              <Text style={[styles.itemVal, { color: '#B45309', fontWeight: '800' }]}>
                +₹{currentBooking.overtime_charge}
              </Text>
            </View>
          )}

          {/* Previous Booking Cancellation Penalty (Phase III) */}
          {currentBooking?.cancellation_penalty_fee > 0 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="alert-circle" size={13} color={colors.danger} style={{ marginRight: 4 }} />
                <Text style={[styles.itemLabel, { color: colors.danger, fontWeight: '700' }]}>
                  {t('previousCancellationPenalty') || 'Previous Booking Cancellation Fee'}
                </Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.danger, fontWeight: '800' }]}>
                +₹{currentBooking.cancellation_penalty_fee}
              </Text>
            </View>
          )}

          {/* Welcome Discount */}
          {currentBooking?.discount_applied > 0 && (
            <View style={styles.itemRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="gift" size={13} color={colors.successDark} style={{ marginRight: 4 }} />
                <Text style={[styles.itemLabel, { color: colors.successDark }]}>{t('firstTimeDiscount') || 'First-Time User Welcome Discount'}</Text>
              </View>
              <Text style={[styles.itemVal, { color: colors.successDark }]}>-₹{currentBooking.discount_applied}</Text>
            </View>
          )}

          {/* Net Total Row */}
          <View style={styles.netTotalRow}>
            <Text style={styles.netTotalLabel}>{t('netAmountPayable') || 'Net Amount Payable'}</Text>
            <Text style={styles.netTotalVal}>₹{amountToPay}</Text>
          </View>
        </View>

        {/* WHERE YOUR MONEY GOES: Fair Wage Breakdown (Calculated directly on amountToPay) */}
        <View style={styles.breakdownContainer}>
          <Text style={styles.sectionHeading}>{t('whereMoneyGoes') || 'WHERE YOUR MONEY GOES (TRANSPARENT 80/10/6/4 SPLIT)'}</Text>
          <PaymentBreakdown totalAmount={amountToPay} />
        </View>

        {/* Payment Methods Selection */}
        <Text style={[styles.sectionHeading, { marginTop: 8 }]}>
          {isPayPal ? 'SECURED PAYMENT METHOD' : t('selectPayment')}
        </Text>
        {isPayPal ? (
          <View style={styles.paypalSelectedCard}>
            <View style={styles.paypalSelectedHeader}>
              <Ionicons name="logo-paypal" size={26} color="#0070BA" />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.paypalSelectedTitle}>PayPal Sandbox Pre-Authorized Hold</Text>
                <Text style={styles.paypalSelectedSub}>
                  Authorization ID: {activeBooking.paypal_authorization_id}
                </Text>
              </View>
              <View style={styles.paypalActivePill}>
                <Ionicons name="checkmark-circle" size={13} color="#16A34A" />
                <Text style={styles.paypalActivePillText}>ACTIVE HOLD</Text>
              </View>
            </View>
            <View style={styles.paypalSelectedDivider} />
            <Text style={styles.paypalSelectedDesc}>
              Settlement executes automatically against the active PayPal sandbox authorization hold (${activeBooking.paypal_authorized_usd || '1.45'} USD). Payer: {activeBooking.paypal_payer?.name || user?.name || 'Customer'}. No additional credentials or cards needed.
            </Text>
          </View>
        ) : (
          <View style={styles.methodsList}>
            {PAYMENT_METHODS.map((method) => {
              const isSelected = selectedMethod === method.id;
              return (
                <TouchableOpacity
                  key={method.id}
                  style={[styles.methodCard, isSelected && styles.methodCardSelected]}
                  onPress={() => setSelectedMethod(method.id)}
                  activeOpacity={0.75}
                >
                  <View style={styles.methodLeft}>
                    <View style={[styles.methodIconBox, isSelected && styles.methodIconBoxSelected]}>
                      <Ionicons
                        name={method.icon}
                        size={20}
                        color={isSelected ? colors.primary : colors.textSecondary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.methodLabel, isSelected && styles.methodLabelSelected]}>
                        {method.label}
                      </Text>
                      {method.badge && (
                        <Text style={styles.methodBadge}>{method.badge}</Text>
                      )}
                    </View>
                  </View>
                  <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                    {isSelected && <View style={styles.radioDot} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* If UPI is selected, show UPI ID field */}
        {!isPayPal && selectedMethod === 'UPI' && (
          <View style={styles.upiInputCard}>
            <Text style={styles.upiInputLabel}>{t('enterVpa') || 'Enter Virtual Payment Address (VPA)'}</Text>
            <View style={styles.upiInputWrap}>
              <Ionicons name="at" size={18} color={colors.primary} style={{ marginRight: 8 }} />
              <TextInput
                style={styles.upiTextInput}
                value={upiId}
                onChangeText={setUpiId}
                placeholder="username@bank"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
              />
              <View style={styles.upiVerifiedBadge}>
                <Ionicons name="checkmark-circle" size={14} color={colors.successDark} />
                <Text style={styles.upiVerifiedText}>{t('autoVerified') || 'Auto-Verified'}</Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Sticky Bottom Pay Action */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.payBtn, isPayPal && styles.payBtnPayPal, isAgentAuditing && { opacity: 0.85, backgroundColor: '#005ea6' }]}
          onPress={handlePay}
          disabled={isProcessing || isCapturing || isPreviewLoading || isAgentAuditing}
          activeOpacity={0.85}
        >
          {isProcessing || isCapturing || isAgentAuditing ? (
            <View style={styles.payBtnRow}>
              <ActivityIndicator size="small" color="#FFFFFF" />
              <Text style={styles.payBtnText}>
                {isAgentAuditing ? `Auditing Settlement (${auditElapsed}s)...` : 'Processing...'}
              </Text>
            </View>
          ) : (
            <View style={styles.payBtnRow}>
              <Ionicons name={isPayPal ? "logo-paypal" : "lock-closed"} size={16} color="#FFFFFF" />
              <Text style={styles.payBtnText}>
                {isPayPal
                  ? `Settle Final Bill • $${finalBillUsd} USD`
                  : `${t('payNow')} • ₹${amountToPay}`}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
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
    paddingTop: 16,
    paddingBottom: 90
  },
  amountCard: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
    shadowColor: colors.shadowColor,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2
  },
  amountLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.5
  },
  amountVal: {
    fontSize: 36,
    fontWeight: '900',
    color: colors.primary,
    marginVertical: 2
  },
  bookingRefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2
  },
  bookingRefText: {
    fontSize: 12,
    color: colors.textSecondary,
    marginRight: 8
  },
  verifiedTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.successLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6
  },
  verifiedTagText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.successDark,
    marginLeft: 3
  },
  itemizedCard: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 14
  },
  itemizedHeader: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textSecondary,
    letterSpacing: 0.5,
    marginBottom: 10
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6
  },
  itemLabel: {
    fontSize: 12,
    color: colors.textPrimary,
    fontWeight: '500'
  },
  itemVal: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary
  },
  netTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 10,
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  netTotalLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textPrimary
  },
  netTotalVal: {
    fontSize: 18,
    fontWeight: '900',
    color: colors.primary
  },
  breakdownContainer: {
    marginBottom: 14
  },
  sectionHeading: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.primary,
    letterSpacing: 0.5,
    marginBottom: 8
  },
  methodsList: {
    gap: 10,
    marginBottom: 14
  },
  methodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.border
  },
  methodCardSelected: {
    borderColor: colors.primaryLight,
    backgroundColor: colors.primarySubtle
  },
  methodLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10
  },
  methodIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.surfaceSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  methodIconBoxSelected: {
    backgroundColor: colors.surface
  },
  methodLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  methodLabelSelected: {
    color: colors.primary,
    fontWeight: '800'
  },
  methodBadge: {
    fontSize: 10,
    color: colors.textSecondary,
    marginTop: 2
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.borderDark,
    alignItems: 'center',
    justifyContent: 'center'
  },
  radioCircleSelected: {
    borderColor: colors.primary
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary
  },
  upiInputCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16
  },
  upiInputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8
  },
  upiInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 46,
    borderWidth: 1,
    borderColor: colors.border
  },
  upiTextInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    height: '100%'
  },
  upiVerifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  upiVerifiedText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.successDark,
    marginLeft: 3
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  payBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4
  },
  payBtnPayPal: {
    backgroundColor: '#0070BA',
    shadowColor: '#0070BA'
  },
  payBtnRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  payBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
    marginLeft: 8
  },
  paypalAuthCard: {
    backgroundColor: '#F0F9FF',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#BAE6FD',
    padding: 14,
    marginBottom: 16
  },
  paypalAuthHeader: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  paypalAuthBadgeTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: '#0369A1',
    letterSpacing: 0.5
  },
  paypalAuthIdText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 2
  },
  paypalStatusPill: {
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#7DD3FC'
  },
  paypalStatusPillText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#0284C7'
  },
  paypalAuthDivider: {
    height: 1,
    backgroundColor: '#E0F2FE',
    marginVertical: 10
  },
  paypalAuthDetailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8
  },
  paypalAuthDetailText: {
    fontSize: 11,
    color: '#64748B'
  },
  paypalAuthNotice: {
    fontSize: 11,
    color: '#0369A1',
    lineHeight: 16,
    fontStyle: 'italic'
  },
  paypalSelectedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#0070BA',
    padding: 16,
    marginBottom: 16,
    shadowColor: '#0070BA',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2
  },
  paypalSelectedHeader: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  paypalSelectedTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A'
  },
  paypalSelectedSub: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2
  },
  paypalActivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  paypalActivePillText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#16A34A',
    marginLeft: 3
  },
  paypalSelectedDivider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginVertical: 10
  },
  paypalSelectedDesc: {
    fontSize: 11,
    color: '#475569',
    lineHeight: 16
  },
  agentAuditingCard: {
    backgroundColor: '#F0F9FF',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#0284C7',
    padding: 16,
    marginBottom: 16,
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3
  },
  agentPulseCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#E0F2FE',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#38BDF8'
  },
  agentAuditingTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0369A1'
  },
  agentAuditingSubtitle: {
    fontSize: 12,
    color: '#475569',
    marginTop: 3,
    lineHeight: 16
  },
  agentAuditingTimerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#BAE6FD'
  },
  agentTimerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6
  },
  agentTimerText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0369A1',
    marginLeft: 4
  },
  agentGuardedText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0284C7'
  }
});

export default Screen12_PaymentScreen;
