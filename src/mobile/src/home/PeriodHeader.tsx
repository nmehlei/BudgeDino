import { StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';

import { useAppTheme } from '../theme';

export type HomePeriod = 'current' | 'previous';

/**
 * Period title between two arrows. The API offers only the current and the previous period, so `‹`
 * goes back to the previous one and `›` returns to the current one; the arrow that leads nowhere is
 * disabled. The subtitle is "N days left" on the current period and "Previous period" on the other.
 */
export function PeriodHeader({
  value,
  onChange,
  title,
  subtitle,
}: {
  value: HomePeriod;
  onChange: (period: HomePeriod) => void;
  title: string;
  subtitle?: string | undefined;
}) {
  const theme = useAppTheme();
  return (
    <View style={styles.row} testID="period-header">
      <IconButton
        icon="chevron-left"
        accessibilityLabel="Previous period"
        testID="period-previous"
        disabled={value === 'previous'}
        onPress={() => onChange('previous')}
      />
      <View style={styles.titles}>
        <Text variant="headlineSmall" style={styles.center} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text
            variant="bodyMedium"
            style={[styles.center, { color: theme.colors.onSurfaceVariant }]}
            testID="period-subtitle"
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <IconButton
        icon="chevron-right"
        accessibilityLabel="Current period"
        testID="period-current"
        disabled={value === 'current'}
        onPress={() => onChange('current')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  titles: { flex: 1, alignItems: 'center' },
  center: { textAlign: 'center' },
});
