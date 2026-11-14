/**
 * ============================================================================
 * UniServ Navigator Error Boundary
 * ============================================================================
 * Catches any unhandled React or navigation errors within the navigator hierarchy.
 * Prevents white-screen crashes and renders a clean, user-friendly recovery UI.
 * ============================================================================
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

export class NavigatorErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('NavigatorErrorBoundary caught an error:', error, errorInfo);
  }

  handleBackToHome = () => {
    this.setState({ hasError: false, error: null });
    if (typeof window !== 'undefined' && window.location) {
      window.location.href = '/';
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <View style={styles.card}>
            <View style={styles.iconCircle}>
              <Ionicons name="alert-circle" size={44} color="#EF4444" />
            </View>
            <Text style={styles.title}>Navigation Notice</Text>
            <Text style={styles.subtitle}>
              {this.state.error?.message || 'A navigation error occurred while resolving your session.'}
            </Text>
            <Text style={styles.detail}>
              Your session state has been preserved. Click below to return to the home screen.
            </Text>
            <TouchableOpacity
              style={styles.button}
              onPress={this.handleBackToHome}
              activeOpacity={0.85}
            >
              <Ionicons name="home" size={18} color="#FFFFFF" />
              <Text style={styles.buttonText}>Back to Home</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    maxWidth: 420,
    width: '100%',
    borderWidth: 1,
    borderColor: '#334155'
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#F8FAFC',
    marginBottom: 8,
    textAlign: 'center'
  },
  subtitle: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 12,
    lineHeight: 18
  },
  detail: {
    fontSize: 11,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 20
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    gap: 8,
    width: '100%'
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700'
  }
});

export default NavigatorErrorBoundary;
