import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { useAppTheme } from '../theme';

/** Placeholder for tabs that later tasks build. */
export function ComingSoon({ title }: { title: string }) {
  const theme = useAppTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineSmall">{title}</Text>
      <Text variant="bodyMedium">Coming soon</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
});
