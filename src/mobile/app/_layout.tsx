import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AppProviders } from '../src/providers';
import { SignOutRedirect } from '../src/session/SignOutRedirect';

export default function RootLayout() {
  return (
    <AppProviders>
      <StatusBar style="auto" />
      <SignOutRedirect />
      <Stack screenOptions={{ headerShown: false }} />
    </AppProviders>
  );
}
