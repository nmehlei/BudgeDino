import { VERSION } from '@budgedino/shared';
import { Redirect } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

import { useSession } from '../src/session/useSession';
import { useAppTheme } from '../src/theme';

/** Root route: splash while the session loads, onboarding when signed out, home when signed in. */
export default function Index() {
  const theme = useAppTheme();
  const { status, serverUrl } = useSession();

  if (status === 'signed_out') {
    return <Redirect href={serverUrl ? '/(auth)/login' : '/(auth)/server'} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {status === 'loading' ? (
        <ActivityIndicator animating accessibilityLabel="Loading" />
      ) : (
        <>
          {/* Placeholder until the real home screen lands. */}
          <Text variant="displaySmall">BudgeDino</Text>
          <Text variant="bodySmall">shared v{VERSION}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
