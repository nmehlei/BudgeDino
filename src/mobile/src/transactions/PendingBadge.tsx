import { StyleSheet } from 'react-native';
import { Text } from 'react-native-paper';

import { useAppTheme, useWarningColor } from '../theme';

/** Small "Pending" pill for transactions that are not booked yet. */
export function PendingBadge() {
  const theme = useAppTheme();
  const warning = useWarningColor();
  return (
    <Text
      variant="labelSmall"
      testID="pending-badge"
      style={[
        styles.badge,
        { color: warning, borderColor: warning, backgroundColor: theme.colors.surface },
      ]}
    >
      Pending
    </Text>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
});
