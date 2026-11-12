import { createContext, useContext, type ReactNode } from 'react';

/**
 * Stand-ins for expo-router's React Navigation theming exports. The real package is ESM-only and
 * cannot load under jest, so tests mock `expo-router` and spread these in.
 */
const fonts = {
  regular: { fontFamily: 'system', fontWeight: '400' },
  medium: { fontFamily: 'system', fontWeight: '500' },
  bold: { fontFamily: 'system', fontWeight: '700' },
  heavy: { fontFamily: 'system', fontWeight: '900' },
} as const;

export const DefaultTheme = {
  dark: false,
  colors: {
    primary: 'rgb(0, 122, 255)',
    background: 'rgb(242, 242, 242)',
    card: 'rgb(255, 255, 255)',
    text: 'rgb(28, 28, 30)',
    border: 'rgb(216, 216, 216)',
    notification: 'rgb(255, 59, 48)',
  },
  fonts,
};
export const DarkTheme = { ...DefaultTheme, dark: true };

const Ctx = createContext<typeof DefaultTheme | undefined>(undefined);

export function ThemeProvider({
  value,
  children,
}: {
  value: typeof DefaultTheme;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx) ?? DefaultTheme;
}
