import { useSyncExternalStore } from 'react';
import { useColorScheme } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

import { getThemeStore, resolveScheme } from './theme-store';

export const ACCENT = '#2E7D6B';

/** Semantic "warning" (amber) colours; Paper's theme has no such token. */
export const WARNING_LIGHT = '#B26A00';
export const WARNING_DARK = '#FFB74D';

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: ACCENT,
    onPrimary: '#FFFFFF',
    primaryContainer: '#BFEBDD',
    onPrimaryContainer: '#00201A',
    secondary: '#4A635C',
    // The selected segmented button / chip is the green family, not Paper's purple-grey default.
    secondaryContainer: '#CDE9DF',
    onSecondaryContainer: '#07201A',
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#6FD6BD',
    onPrimary: '#00382D',
    primaryContainer: '#1F5F50',
    onPrimaryContainer: '#BFEBDD',
    secondary: '#B1CCC3',
    secondaryContainer: '#1F5F50',
    onSecondaryContainer: '#BFEBDD',
    // Calm near-black surface hierarchy with a faint green tint: background < surface < cards.
    background: '#0E1311',
    onBackground: '#E1E8E4',
    surface: '#151B18',
    onSurface: '#E1E8E4',
    surfaceVariant: '#202824',
    onSurfaceVariant: '#BCC8C2',
    outline: '#86928C',
    outlineVariant: '#38433E',
    surfaceDisabled: 'rgba(225, 232, 228, 0.12)',
    onSurfaceDisabled: 'rgba(225, 232, 228, 0.38)',
    elevation: {
      level0: 'transparent',
      level1: '#171D1A',
      level2: '#1B221F',
      level3: '#1F2723',
      level4: '#212A26',
      level5: '#242E29',
    },
  },
};

/** Resolved Paper theme: the stored Appearance preference (System / Light / Dark), live. */
export function useAppTheme(): MD3Theme {
  const store = getThemeStore();
  const preference = useSyncExternalStore(
    store.subscribe,
    store.getPreference,
    store.getPreference,
  );
  const system = useColorScheme();
  return resolveScheme(preference, system) === 'dark' ? darkTheme : lightTheme;
}

/** Amber for budgets approaching their limit; follows the resolved theme. */
export function useWarningColor(): string {
  return useAppTheme().dark ? WARNING_DARK : WARNING_LIGHT;
}

/** Semantic "success" green (incoming money); Paper's theme has no such token. */
export const SUCCESS_LIGHT = '#2E7D32';
export const SUCCESS_DARK = '#81C784';

/** Green for positive amounts; follows the resolved theme. */
export function useSuccessColor(): string {
  return useAppTheme().dark ? SUCCESS_DARK : SUCCESS_LIGHT;
}
