import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { UserProvider } from './src/context/UserContext';
import { BookingProvider } from './src/context/BookingContext';
import AppNavigator from './src/navigation/AppNavigator';
import { navigationRef } from './src/navigation/navigationRef';
import NavigatorErrorBoundary from './src/components/NavigatorErrorBoundary';

// Ensure web document title is always UniServ
if (typeof document !== 'undefined') {
  document.title = 'UniServ';
}

export default function App() {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = 'UniServ';
    }
  }, []);

  return (
    <SafeAreaProvider>
      <UserProvider>
        <BookingProvider>
          <NavigationContainer ref={navigationRef}>
            <StatusBar style="dark" backgroundColor="#FFFFFF" />
            <NavigatorErrorBoundary>
              <AppNavigator />
            </NavigatorErrorBoundary>
          </NavigationContainer>
        </BookingProvider>
      </UserProvider>
    </SafeAreaProvider>
  );
}
