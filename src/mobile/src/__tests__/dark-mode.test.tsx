import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { useTheme } from 'expo-router';
import { Appearance, StyleSheet, Text as RNText } from 'react-native';

import AppLayout from '../../app/(app)/_layout';
import { CategoryList } from '../home/CategoryList';
import type { toNavigationTheme } from '../navigation-theme';
import { AppProviders } from '../providers';
import { createSessionStore } from '../session/session-store';
import { darkTheme, lightTheme, useAppTheme } from '../theme';
import { createThemeStore, setThemeStore } from '../theme-store';

let mockTabsOptions: Record<string, unknown> | undefined;
let mockSystemScheme: 'light' | 'dark' = 'light';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockSystemScheme,
}));

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: jest.fn() }));
jest.mock('../notifications/poll-task', () => ({ clearNotificationState: jest.fn() }));
jest.mock('../security/AppLock', () => ({
  AppLock: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../security/useScreenProtection', () => ({ useScreenProtection: jest.fn() }));
jest.mock('../notifications/NotificationPoller', () => ({ NotificationPoller: () => null }));
jest.mock('../session/useSession', () => ({
  useSession: () => ({ status: 'signed_in', serverUrl: 'https://budget.example.test' }),
}));
jest.mock('expo-router', () => {
  const actual = jest.requireActual<object>('./support/router-theme');
  const Tabs = Object.assign(
    ({ screenOptions }: { screenOptions: Record<string, unknown> }) => {
      mockTabsOptions = screenOptions;
      return null;
    },
    { Screen: () => null },
  );
  return { ...actual, Tabs, Redirect: () => null };
});

const noopStore = createSessionStore({
  prefs: { getString: () => undefined, set: () => undefined, remove: () => undefined },
  token: { get: async () => null, set: async () => undefined, remove: async () => undefined },
});

type Probe = { nav: ReturnType<typeof toNavigationTheme>; dark: boolean };

function ThemeProbe() {
  const nav = useTheme();
  const paper = useAppTheme();
  return <RNText testID="probe">{JSON.stringify({ nav, dark: paper.dark })}</RNText>;
}

function readProbe(): Probe {
  return JSON.parse(String(screen.getByTestId('probe').props.children)) as Probe;
}

async function renderProviders(child: React.ReactNode) {
  await render(
    <AppProviders
      queryClient={new QueryClient()}
      sessionStore={noopStore}
      openCache={() => Promise.reject(new Error('no cache'))}
    >
      {child}
    </AppProviders>,
  );
}

beforeEach(() => {
  mockTabsOptions = undefined;
  mockSystemScheme = 'light';
  jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
});
afterEach(() => {
  setThemeStore(undefined);
  jest.restoreAllMocks();
});

describe('dark mode wiring', () => {
  it('gives React Navigation the Paper dark colours (not its light defaults)', async () => {
    setThemeStore(createThemeStore());
    mockSystemScheme = 'dark';
    await renderProviders(<ThemeProbe />);
    const { nav, dark } = readProbe();
    expect(dark).toBe(true);
    expect(nav.dark).toBe(true);
    expect(nav.colors.background).toBe(darkTheme.colors.background);
    expect(nav.colors.card).toBe(darkTheme.colors.surface);
    expect(nav.colors.text).toBe(darkTheme.colors.onSurface);
    expect(nav.colors.primary).toBe(darkTheme.colors.primary);
  });

  it('uses the light Paper colours in light mode', async () => {
    setThemeStore(createThemeStore());
    mockSystemScheme = 'light';
    await renderProviders(<ThemeProbe />);
    expect(readProbe().nav.colors.background).toBe(lightTheme.colors.background);
  });

  it('an explicit Dark preference wins over a light system', async () => {
    const store = createThemeStore();
    store.setPreference('dark');
    setThemeStore(store);
    mockSystemScheme = 'light';
    await renderProviders(<ThemeProbe />);
    expect(readProbe().dark).toBe(true);
  });

  it('themes the tab bar from the dark Paper theme', async () => {
    const store = createThemeStore();
    store.setPreference('dark');
    setThemeStore(store);
    await renderProviders(<AppLayout />);
    const options = mockTabsOptions as {
      tabBarActiveTintColor: string;
      tabBarInactiveTintColor: string;
      tabBarStyle: { backgroundColor: string };
      sceneStyle: { backgroundColor: string };
    };
    expect(options.tabBarStyle.backgroundColor).toBe(darkTheme.colors.surface);
    expect(options.tabBarActiveTintColor).toBe(darkTheme.colors.primary);
    expect(options.tabBarInactiveTintColor).toBe(darkTheme.colors.onSurfaceVariant);
    expect(options.sceneStyle.backgroundColor).toBe(darkTheme.colors.background);
  });

  it('renders every budget row text in a light dark-theme colour, never an unset (black) one', async () => {
    const store = createThemeStore();
    store.setPreference('dark');
    setThemeStore(store);
    const eur = (minor: string) => ({ minor, currency: 'EUR' });
    await renderProviders(
      <CategoryList
        fxMissing
        styleOf={() => ({ icon: 'cart', color: 'green' })}
        onOpenCategory={() => undefined}
        groups={[
          {
            kind: 'budget',
            categories: [{ categoryId: 'c1', name: 'Food', spent: eur('10000') }],
            budget: {
              id: 'b1',
              name: 'Groceries',
              categoryIds: ['c1'],
              periodKind: 'weekly',
              amount: eur('40000'),
              spent: eur('10000'),
              ratio: '0.2500',
              fxMissing: true,
              period: {
                key: '2026-11',
                start: '2026-11-01T00:00:00.000Z',
                end: '2026-12-01T00:00:00.000Z',
              },
            },
          },
        ]}
      />,
    );
    const allowed = [darkTheme.colors.onSurface, darkTheme.colors.onSurfaceVariant];
    const texts = screen.getAllByText(/./);
    expect(texts.length).toBeGreaterThan(3);
    for (const text of texts) {
      const color = (StyleSheet.flatten(text.props.style) as { color?: string }).color;
      expect(allowed).toContain(color);
    }
  });

  it('dark text and surfaces have readable contrast', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    };
    expect(
      ratio(darkTheme.colors.onSurfaceVariant, darkTheme.colors.surfaceVariant),
    ).toBeGreaterThan(7);
    expect(ratio(darkTheme.colors.onSurface, darkTheme.colors.background)).toBeGreaterThan(7);
  });
});
