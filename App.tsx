/**
 * Loop entry point.
 *
 * Providers only. All state, effects and screen wiring live in
 * `src/screens` — `useMapViewModel` owns the logic, `RootNavigator` owns
 * which screen renders, and this file owns neither.
 */

import React from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@design';
import { RootNavigator } from './src/screens/RootNavigator';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StatusBar barStyle="default" />
        <RootNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
