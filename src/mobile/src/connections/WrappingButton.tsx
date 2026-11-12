import { Pressable, StyleSheet } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

import { useAppTheme } from '../theme';

interface Props {
  mode?: 'contained' | 'text';
  /** Destructive actions use the theme's error colours. */
  destructive?: boolean;
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
  destructive = false,
  onPress,
  disabled = false,
  loading = false,
  testID,
  children,
}: Props) {
  const theme = useAppTheme();
  const contained = mode === 'contained';
  const off = disabled || loading;
  const accent = destructive ? theme.colors.error : theme.colors.primary;
  const onAccent = destructive ? theme.colors.onError : theme.colors.onPrimary;
  const fg = contained ? onAccent : accent;
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
              : accent
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
