import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { defineNotificationTask } from '../src/notifications/poll-task';
import { AppProviders } from '../src/providers';
import { SignOutRedirect } from '../src/session/SignOutRedirect';

// The headless background task must be defined at module scope, before React renders.
defineNotificationTask();

export default function RootLayout() {
  return (
    <AppProviders>
      <StatusBar style="auto" />
      <SignOutRedirect />
      <Stack screenOptions={{ headerShown: false }} />
    </AppProviders>
  );
}
