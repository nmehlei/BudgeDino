import { useColorScheme } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

export const ACCENT = '#2E7D6B';

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: ACCENT,
    onPrimary: '#FFFFFF',
    primaryContainer: '#BFEBDD',
    onPrimaryContainer: '#00201A',
    secondary: '#4A635C',
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
  },
};

/** Paper MD3 theme following the system colour scheme. */
export function useAppTheme(): MD3Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
