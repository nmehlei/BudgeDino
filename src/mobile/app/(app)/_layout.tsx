import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { ActivityIndicator } from 'react-native-paper';

import { NotificationPoller } from '../../src/notifications/NotificationPoller';
import { AppLock } from '../../src/security/AppLock';
import { useScreenProtection } from '../../src/security/useScreenProtection';
import { useSession } from '../../src/session/useSession';
import { useAppTheme } from '../../src/theme';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

function tabIcon(name: IconName) {
  return function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <MaterialCommunityIcons name={name} color={String(color)} size={size} />;
  };
}

/** Everything that exists only for a signed-in user: screen protection, app lock, notification polling. */
function AuthenticatedShell() {
  const theme = useAppTheme();
  useScreenProtection();
  return (
    <AppLock>
      <NotificationPoller />
      <AppTabs theme={theme} />
    </AppLock>
  );
}

/**
 * Signed-in shell with the four bottom tabs. Also the root gate: splash while the session loads,
 * onboarding when signed out (server screen without a stored URL, otherwise login).
 */
export default function AppLayout() {
  const theme = useAppTheme();
  const { status, serverUrl } = useSession();

  if (status === 'signed_out') {
    return <Redirect href={serverUrl ? '/(auth)/login' : '/(auth)/server'} />;
  }
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator animating accessibilityLabel="Loading" />
      </View>
    );
  }

  return <AuthenticatedShell />;
}

function AppTabs({ theme }: { theme: ReturnType<typeof useAppTheme> }) {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarStyle: { backgroundColor: theme.colors.surface },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home-outline') }} />
      <Tabs.Screen
        name="transactions"
        options={{ title: 'Transactions', tabBarIcon: tabIcon('swap-horizontal') }}
      />
      <Tabs.Screen
        name="connections"
        options={{ title: 'Connections', tabBarIcon: tabIcon('bank-outline') }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: tabIcon('cog-outline') }}
      />
      {/* Pushed from the list; not a tab of its own. */}
      <Tabs.Screen name="transaction/[id]" options={{ href: null }} />
    </Tabs>
  );
}
