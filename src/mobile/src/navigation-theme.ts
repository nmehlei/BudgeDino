import { DarkTheme, DefaultTheme, type Theme as NavigationTheme } from 'expo-router';
import type { MD3Theme } from 'react-native-paper';

/** React Navigation theme derived from a Paper theme (screens, cards, headers, tab bar). */
export function toNavigationTheme(theme: MD3Theme): NavigationTheme {
  const base = theme.dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: theme.dark,
    colors: {
      primary: theme.colors.primary,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.onSurface,
      border: theme.colors.outlineVariant,
      notification: theme.colors.error,
    },
  };
}
