import { Pressable, StyleSheet } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

import { useAppTheme } from '../theme';

interface Props {
  mode?: 'contained' | 'text';
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  children: string;
}

/**
 * Paper's Button pins its label to one line, so a long label ("I've confirmed in my banking app")
 * is cut off with an ellipsis at large font scales. This one wraps and grows with the text instead.
 */
export function WrappingButton({
  mode = 'contained',
  onPress,
  disabled = false,
  loading = false,
  testID,
  children,
}: Props) {
  const theme = useAppTheme();
  const contained = mode === 'contained';
  const off = disabled || loading;
  const fg = contained ? theme.colors.onPrimary : theme.colors.primary;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: loading }}
      style={[
        styles.base,
        {
          backgroundColor: contained
            ? disabled
              ? theme.colors.surfaceDisabled
              : theme.colors.primary
            : 'transparent',
        },
      ]}
    >
      {loading ? <ActivityIndicator animating size={16} color={fg} /> : null}
      <Text
        variant="labelLarge"
        style={[styles.label, { color: disabled ? theme.colors.onSurfaceDisabled : fg }]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: { flexShrink: 1, textAlign: 'center' },
});
