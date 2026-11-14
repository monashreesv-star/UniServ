import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Alert, TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from '../context/UserContext';
import { useBooking } from '../context/BookingContext';
import { API_BASE_URL } from '../config/api';
import { navigationRef } from './navigationRef';
import { colors } from '../theme/colors';

// Ensure document.title is always UniServ on web
if (typeof document !== 'undefined') {
  document.title = 'UniServ';
}

// Screens
import Screen01_LanguageSelection from '../screens/Screen01_LanguageSelection';
import Screen02_OTPLogin from '../screens/Screen02_OTPLogin';
import Screen02_Registration from '../screens/Screen02_Registration';
import BottomTabNavigator from './BottomTabNavigator';
import Screen04_ServiceDetail from '../screens/Screen04_ServiceDetail';
import Screen05_BookingForm from '../screens/Screen05_BookingForm';
import Screen06_WorkerMatch from '../screens/Screen06_WorkerMatch';
import Screen07_LiveTracking from '../screens/Screen07_LiveTracking';
import Screen08_StartOTP from '../screens/Screen08_StartOTP';
import Screen09_JobInProgress from '../screens/Screen09_JobInProgress';
import Screen10_ExtraWorkApproval from '../screens/Screen10_ExtraWorkApproval';
import Screen11_CompletionOTP from '../screens/Screen11_CompletionOTP';
import Screen12_PaymentScreen from '../screens/Screen12_PaymentScreen';
import Screen12_BulkPaymentScreen from '../screens/Screen12_BulkPaymentScreen';
import Screen13_PaymentSuccess from '../screens/Screen13_PaymentSuccess';
import Screen13_BulkProjectSuccess from '../screens/Screen13_BulkProjectSuccess';
import Screen14_RatingScreen from '../screens/Screen14_RatingScreen';
import Screen15_NoWorkerAvailable from '../screens/Screen15_NoWorkerAvailable';
import Screen16_ComplaintScreen from '../screens/Screen16_ComplaintScreen';
import Screen17_SevaSurakshaScreen from '../screens/Screen17_SevaSurakshaScreen';
import Screen18_CommunityScreen from '../screens/Screen18_CommunityScreen';
import Screen_RegisterForAnother from '../screens/Screen_RegisterForAnother';
import Screen_IVRSCall from '../screens/Screen_IVRSCall';

const Stack = createNativeStackNavigator();

export const AppNavigator = () => {
  const { isLoggedIn, isLoading, user } = useUser();
  const { setActiveBooking } = useBooking();

  const isFullyRegisteredAndLoggedIn = Boolean(isLoggedIn && user && user.isRegistered);

  const [payPalProcessing, setPayPalProcessing] = useState(() => {
    if (typeof window !== 'undefined' && window.location) {
      const search = window.location.search || '';
      return (
        search.includes('paypal_return=true') ||
        search.includes('paypal_cancel=true') ||
        (search.includes('token=') && search.includes('PayerID='))
      );
    }
    return false;
  });
  const [payPalStatusText, setPayPalStatusText] = useState('Verifying PayPal Sandbox Authorization Hold...');
  const [payPalAuthError, setPayPalAuthError] = useState(null);
  const [pendingNavigation, setPendingNavigation] = useState(null);

  // Set document.title on mount
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = 'UniServ';
    }
  }, []);

  // Handle return from PayPal sandbox before navigation renders
  useEffect(() => {
    if (!payPalProcessing) return;

    const resolvePayPal = async () => {
      let draft = null;
      try {
        if (typeof document !== 'undefined') {
          document.title = 'UniServ';
        }
        const search = window.location.search || '';
        const params = new URLSearchParams(search);
        const isCancel = params.get('paypal_cancel') === 'true' || params.get('cancel') === 'true';
        const isReturn = params.get('paypal_return') === 'true' || (params.get('token') && params.get('PayerID'));
        const token = params.get('token');
        const payerId = params.get('PayerID');
        const bookingId = params.get('booking_id');

        const rawDraft = await AsyncStorage.getItem('@uniserv_paypal_booking_draft');
        try {
          draft = rawDraft ? JSON.parse(rawDraft) : null;
        } catch (e) {}

        // CASE 1: BUYER CANCELLED ON PAYPAL
        if (isCancel) {
          if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
            window.history.replaceState({}, 'UniServ', window.location.pathname);
          }
          if (draft) {
            await AsyncStorage.setItem('@uniserv_paypal_cancel_notice', 'true');
            setPendingNavigation({
              route: 'BookingForm',
              params: {
                service: draft.service,
                bookingType: draft.booking_type,
                restoredDraft: draft
              }
            });
          }
          setPayPalProcessing(false);
          return;
        }

        // CASE 2: BUYER APPROVED ON PAYPAL
        if (isReturn) {
          // Double-auth prevention: if page was refreshed after return and already authorized
          if (draft && draft.status === 'AUTHORIZED' && draft.paypal_authorization_id) {
            if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
              window.history.replaceState({}, 'UniServ', window.location.pathname);
            }
            const rec = draft.bookingRecord || {
              ...draft,
              payment_method: 'PAYPAL_SANDBOX',
              paypal_status: 'AUTHORIZED'
            };
            const last4 = draft.paypal_authorization_id ? String(draft.paypal_authorization_id).slice(-4) : 'none';
            console.log(`PayPal authorize: ${draft.status} ${last4}`);
            setActiveBooking(rec);
            setPendingNavigation({
              route: 'WorkerMatch',
              params: {
                service: draft.service,
                bookingType: draft.booking_type,
                booking: rec
              }
            });
            setPayPalProcessing(false);
            return;
          }

          setPayPalStatusText('Authorizing PayPal sandbox payment hold with settlement engine...');
          const targetOrderId = token || draft?.orderId;
          const targetBookingId = bookingId || draft?.bookingId;

          const res = await fetch(`${API_BASE_URL}/api/orders/authorize`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              orderId: targetOrderId,
              bookingId: targetBookingId,
              payerId: payerId || null
            })
          });

          const data = await res.json();

          // Clean URL params immediately
          if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
            window.history.replaceState({}, 'UniServ', window.location.pathname);
          }

          if (res.ok && data.success) {
            // Temporary console log (no secrets): "PayPal authorize: <status> <last 4 chars of authorizationId>"
            const last4 = data.authorizationId ? String(data.authorizationId).slice(-4) : 'none';
            console.log(`PayPal authorize: ${data.status} ${last4}`);

            const resolvedBookingId = data.bookingId || targetBookingId;
            const bookingRecord = {
              ...(draft?.bookingRecord || draft || {}),
              booking_id: resolvedBookingId,
              bookingId: resolvedBookingId,
              paypal_booking_id: resolvedBookingId,
              payment_method: 'PAYPAL_SANDBOX',
              paypal_order_id: data.orderId || targetOrderId,
              paypal_authorization_id: data.authorizationId,
              paypal_mode: data.mode || 'REAL_SANDBOX',
              paypal_status: 'AUTHORIZED',
              paypal_authorized_usd: draft?.authorizedAmountUsd || data.authorizedAmountUsd || '1.45',
              paypal_payer: draft?.payer || null,
              status: 'Booking Confirmed',
              statusIndex: 0
            };

            // Save updated draft to prevent re-auth on subsequent refresh
            await AsyncStorage.setItem('@uniserv_paypal_booking_draft', JSON.stringify({
              ...draft,
              status: 'AUTHORIZED',
              paypal_authorization_id: data.authorizationId,
              bookingRecord
            }));

            // Persist directly to active booking storage (per-user and active fallback)
            const activePhone = user?.phone ? String(user.phone).replace(/[^0-9]/g, '') : '9876543210';
            await AsyncStorage.setItem(`@uniserv_active_booking_${activePhone}`, JSON.stringify(bookingRecord));
            await AsyncStorage.setItem('@uniserv_active_booking', JSON.stringify(bookingRecord));

            setActiveBooking(bookingRecord);
            setPendingNavigation({
              route: 'WorkerMatch',
              params: {
                service: bookingRecord.service,
                bookingType: bookingRecord.booking_type,
                booking: bookingRecord
              }
            });
          } else {
            // Handle PayPal errors (ORDER_NOT_APPROVED, INSTRUMENT_DECLINED, etc.)
            const errorName = data.error || 'AUTHORIZATION_FAILED';
            const debugId = data.debugId || 'none';
            const message = data.message || 'PayPal sandbox authorization failed.';
            console.error(`PayPal authorize failed: ${errorName} (Debug ID: ${debugId})`);
            setPayPalAuthError({
              errorName,
              debugId,
              message,
              draft
            });
            setPayPalProcessing(false);
            return;
          }
        }
      } catch (err) {
        console.error('PayPal return resolution error:', err);
        setPayPalAuthError({
          errorName: 'SERVER_UNREACHABLE',
          debugId: 'none',
          message: 'Payment server not reachable. Please ensure the UniServ API server is running on port 5000.',
          draft
        });
        if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
          window.history.replaceState({}, 'UniServ', window.location.pathname);
        }
        setPayPalProcessing(false);
      } finally {
        setPayPalProcessing(false);
      }
    };

    resolvePayPal();
  }, [payPalProcessing]);

  // Navigate to target screen once navigator is mounted and user is logged in
  useEffect(() => {
    if (!pendingNavigation || !isFullyRegisteredAndLoggedIn) return;

    let mounted = true;
    let attempts = 0;

    const tryNavigate = () => {
      if (!mounted) return;
      if (navigationRef.current && typeof navigationRef.current.navigate === 'function') {
        try {
          navigationRef.current.navigate(pendingNavigation.route, pendingNavigation.params);
          setPendingNavigation(null);
          return;
        } catch (e) {
          console.warn('Navigation attempt waiting for navigator readiness:', e.message);
        }
      }
      attempts++;
      if (attempts < 25) {
        setTimeout(tryNavigate, 100);
      }
    };

    const timer = setTimeout(tryNavigate, 150);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [pendingNavigation, isFullyRegisteredAndLoggedIn]);

  // Initial Loading Splash Screen or Return Processing
  if (isLoading || payPalProcessing) {
    return (
      <View style={styles.splashContainer}>
        <View style={styles.splashIconCircle}>
          <Ionicons name="shield-checkmark" size={42} color="#FFFFFF" />
        </View>
        <Text style={styles.splashGovTag}>UNISERV COOPERATIVE GIG PLATFORM</Text>
        <Text style={styles.splashTitle}>UniServ</Text>
        <Text style={styles.splashSub}>Independent Prototype • Sandbox Payments Only</Text>
        <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 24 }} />
        <Text style={styles.splashStatusText}>
          {payPalProcessing ? payPalStatusText : 'Initializing Cooperative Platform & Sandbox Services...'}
        </Text>
      </View>
    );
  }

  // PayPal Authorization Failure State: Show Error Name, Debug ID, and Try Again button
  if (payPalAuthError) {
    return (
      <View style={styles.errorContainer}>
        <View style={styles.errorCard}>
          <View style={styles.errorIconCircle}>
            <Ionicons name="alert-circle" size={42} color="#DC2626" />
          </View>
          <Text style={styles.errorHeaderTag}>PAYPAL SANDBOX PAYMENT NOTICE</Text>
          <Text style={styles.errorTitle}>Authorization Unsuccessful</Text>
          <View style={styles.errorBadgeRow}>
            <View style={styles.errorNameBadge}>
              <Text style={styles.errorNameBadgeText}>{payPalAuthError.errorName}</Text>
            </View>
            {payPalAuthError.debugId && payPalAuthError.debugId !== 'none' && (
              <View style={styles.errorDebugBadge}>
                <Text style={styles.errorDebugBadgeText}>Debug ID: {payPalAuthError.debugId}</Text>
              </View>
            )}
          </View>
          <Text style={styles.errorMessage}>{payPalAuthError.message}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={async () => {
              const restored = payPalAuthError.draft;
              setPayPalAuthError(null);
              if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
                window.history.replaceState({}, 'UniServ', window.location.pathname);
              }
              setPendingNavigation({
                route: 'BookingForm',
                params: {
                  service: restored?.service,
                  bookingType: restored?.booking_type,
                  restoredDraft: restored
                }
              });
            }}
          >
            <Ionicons name="refresh" size={18} color="#FFFFFF" style={{ marginRight: 8 }} />
            <Text style={styles.retryBtnText}>Try Again (Restore Booking Draft)</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName={isFullyRegisteredAndLoggedIn ? 'MainTabs' : 'OTPLogin'}
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right'
      }}
    >
      {!isFullyRegisteredAndLoggedIn ? (
        // -------------------------------------------------------------------
        // UNAUTHENTICATED STACK (OTPLogin / LanguageSelection / Registration)
        // -------------------------------------------------------------------
        <Stack.Group>
          <Stack.Screen name="OTPLogin" component={Screen02_OTPLogin} />
          <Stack.Screen name="LanguageSelection" component={Screen01_LanguageSelection} />
          <Stack.Screen name="Registration" component={Screen02_Registration} />
        </Stack.Group>
      ) : (
        // -------------------------------------------------------------------
        // AUTHENTICATED STACK (MainTabs & Service Workflows)
        // -------------------------------------------------------------------
        <Stack.Group>
          {/* Main Tabbed App */}
          <Stack.Screen name="MainTabs" component={BottomTabNavigator} />
          <Stack.Screen name="Home" component={BottomTabNavigator} />

          {/* Community & Society Bulk Hub */}
          <Stack.Screen name="Community" component={Screen18_CommunityScreen} />

          {/* Service Request & Matching Flow */}
          <Stack.Screen
            name="ServiceDetail"
            component={Screen04_ServiceDetail}
          />
          <Stack.Screen
            name="BookingForm"
            component={Screen05_BookingForm}
          />
          <Stack.Screen
            name="WorkerMatch"
            component={Screen06_WorkerMatch}
          />
          <Stack.Screen name="NoWorkerAvailable" component={Screen15_NoWorkerAvailable} />

          {/* Live Tracking & Execution Flow */}
          <Stack.Screen name="LiveTracking" component={Screen07_LiveTracking} />
          <Stack.Screen name="StartOTP" component={Screen08_StartOTP} />
          <Stack.Screen name="JobInProgress" component={Screen09_JobInProgress} />
          <Stack.Screen name="ExtraWorkApproval" component={Screen10_ExtraWorkApproval} />
          <Stack.Screen name="CompletionOTP" component={Screen11_CompletionOTP} />

          {/* Payment & Settlement Flow */}
          <Stack.Screen name="Payment" component={Screen12_PaymentScreen} />
          <Stack.Screen name="BulkPayment" component={Screen12_BulkPaymentScreen} />
          <Stack.Screen name="PaymentSuccess" component={Screen13_PaymentSuccess} />
          <Stack.Screen name="BulkProjectSuccess" component={Screen13_BulkProjectSuccess} />
          <Stack.Screen name="Rating" component={Screen14_RatingScreen} />
          <Stack.Screen name="RatingScreen" component={Screen14_RatingScreen} />

          {/* Seva Suraksha & Grievance Modals */}
          <Stack.Screen
            name="Complaint"
            component={Screen16_ComplaintScreen}
            options={{ animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="SevaSuraksha"
            component={Screen17_SevaSurakshaScreen}
            options={{ animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="RegisterForAnother"
            component={Screen_RegisterForAnother}
          />
          <Stack.Screen
            name="IVRSCall"
            component={Screen_IVRSCall}
            options={{ animation: 'slide_from_bottom' }}
          />
        </Stack.Group>
      )}
    </Stack.Navigator>
  );
};

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  splashIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4
  },
  splashGovTag: {
    fontSize: 9,
    fontWeight: '900',
    color: '#94A3B8',
    letterSpacing: 1,
    marginBottom: 6
  },
  splashTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: '#FFFFFF'
  },
  splashSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
    textAlign: 'center'
  },
  splashStatusText: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 14,
    textAlign: 'center',
    letterSpacing: 0.2
  },
  errorContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20
  },
  errorCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 24,
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#FEE2E2'
  },
  errorIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FEF2F2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12
  },
  errorHeaderTag: {
    fontSize: 10,
    fontWeight: '900',
    color: '#DC2626',
    letterSpacing: 0.8,
    marginBottom: 4
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 10,
    textAlign: 'center'
  },
  errorBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'center',
    marginBottom: 12
  },
  errorNameBadge: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6
  },
  errorNameBadgeText: {
    color: '#B91C1C',
    fontSize: 12,
    fontWeight: '800'
  },
  errorDebugBadge: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6
  },
  errorDebugBadgeText: {
    color: '#475569',
    fontSize: 11,
    fontWeight: '700'
  },
  errorMessage: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    width: '100%'
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800'
  }
});

export default AppNavigator;
