import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';

import { AppProviders } from '../src/providers';
import { SignOutRedirect } from '../src/session/SignOutRedirect';
import { useAppTheme } from '../src/theme';

/** Status bar icons and the native root background follow the resolved theme. */
function ThemedChrome() {
  const theme = useAppTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.colors.background).catch(() => undefined);
  }, [theme.colors.background]);
  return <StatusBar style={theme.dark ? 'light' : 'dark'} />;
}

function ThemedStack() {
  const theme = useAppTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <AppProviders>
      <ThemedChrome />
      <SignOutRedirect />
      <ThemedStack />
    </AppProviders>
  );
}
