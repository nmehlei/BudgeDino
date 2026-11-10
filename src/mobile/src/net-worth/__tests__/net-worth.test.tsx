import type { NetWorthAccount, NetWorthResponse } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Appearance, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { MoreScreen } from '../../more/MoreScreen';
import { darkTheme } from '../../theme';
import { createThemeStore, setThemeStore } from '../../theme-store';
import { NetWorthScreen } from '../NetWorthScreen';

const mockRouter = { push: jest.fn(), back: jest.fn() };
const mockApi = { getNetWorth: jest.fn() };

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const eur = (minor: string) => ({ minor, currency: 'EUR' });
const acc = (over: Partial<NetWorthAccount>): NetWorthAccount => ({
  id: 'a1',
  name: 'Girokonto',
  kind: 'checking',
  isOwner: true,
  disconnected: false,
  balance: eur('100000'),
  baseBalance: eur('100000'),
  balanceAt: '2026-11-10T10:00:00.000Z',
  ...over,
});

function data(over: Partial<NetWorthResponse> = {}): NetWorthResponse {
  return {
    baseCurrency: 'EUR',
    total: eur('220909'),
    fxMissing: false,
    groups: [
      {
        kind: 'checking',
        total: eur('100000'),
        fxMissing: false,
        accounts: [
          acc({}),
          acc({ id: 'a2', name: 'Neues Konto', balance: null, baseBalance: null }),
        ],
      },
      {
        kind: 'depot',
        total: eur('90909'),
        fxMissing: false,
        accounts: [
          acc({
            id: 'a3',
            name: 'US Depot',
            kind: 'depot',
            balance: { minor: '100000', currency: 'USD' },
            baseBalance: eur('90909'),
          }),
        ],
      },
    ],
    ...over,
  } as NetWorthResponse;
}

async function renderScreen(
  ui: React.ReactElement = <NetWorthScreen />,
  theme?: React.ComponentProps<typeof PaperProvider>['theme'],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider {...(theme ? { theme } : {})}>{ui}</PaperProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getNetWorth.mockReset();
});

describe('NetWorthScreen', () => {
  it('shows the total and the accounts grouped by kind with converted values', async () => {
    mockApi.getNetWorth.mockResolvedValue(data());
    await renderScreen();
    expect((await screen.findByTestId('net-worth-total')).props.children).toMatch(/^2\.209,09\s€$/);
    const checking = within(screen.getByTestId('nw-group-checking'));
    expect(checking.getByText('Checking')).toBeTruthy();
    expect(checking.getAllByText(/^1\.000,00\s€$/).length).toBeTruthy();
    expect(checking.getByText('No balance yet')).toBeTruthy();
    const depot = within(screen.getByTestId('nw-group-depot'));
    expect(depot.getByText('Depots')).toBeTruthy();
    expect(depot.getByText(/1\.000,00\s\$/)).toBeTruthy();
    expect(depot.getByText(/≈ 909,09/)).toBeTruthy();
    expect(screen.queryByTestId('nw-group-savings')).toBeNull();
    expect(screen.queryByTestId('fx-missing')).toBeNull();
    expect(screen.getByText('History graph coming soon')).toBeTruthy();
  });

  it('shows the fxMissing note and a disconnected hint', async () => {
    mockApi.getNetWorth.mockResolvedValue(
      data({
        fxMissing: true,
        groups: [
          {
            kind: 'savings',
            total: eur('0'),
            fxMissing: true,
            accounts: [
              acc({
                id: 'a9',
                kind: 'savings',
                disconnected: true,
                balance: { minor: '5000', currency: 'CHF' },
                baseBalance: null,
              }),
            ],
          },
        ],
      }),
    );
    await renderScreen();
    expect(await screen.findByTestId('fx-missing')).toBeTruthy();
    expect(screen.getByText('No rate available')).toBeTruthy();
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('shows the empty state without accounts', async () => {
    mockApi.getNetWorth.mockResolvedValue(data({ groups: [], total: eur('0') }));
    await renderScreen();
    expect(await screen.findByText('Connect a bank to see your net worth')).toBeTruthy();
    expect(screen.queryByTestId('net-worth-total')).toBeNull();
  });

  it('keeps cached data under an offline banner and offers Retry', async () => {
    mockApi.getNetWorth.mockResolvedValueOnce(data());
    await renderScreen();
    await screen.findByTestId('net-worth-total');
    mockApi.getNetWorth.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await act(async () => {
      (
        screen.getByTestId('net-worth-scroll').props.refreshControl as {
          props: { onRefresh: () => void };
        }
      ).props.onRefresh();
    });
    expect(await screen.findByTestId('offline-banner', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/Offline — showing data from/)).toBeTruthy();
    expect(screen.getByTestId('net-worth-total')).toBeTruthy();
  });

  it('shows an offline empty state without a cache', async () => {
    mockApi.getNetWorth.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderScreen();
    expect(await screen.findByText("You're offline", {}, { timeout: 4000 })).toBeTruthy();
  });

  it('pull-to-refresh refetches', async () => {
    mockApi.getNetWorth.mockResolvedValue(data());
    await renderScreen();
    await screen.findByTestId('net-worth-total');
    mockApi.getNetWorth.mockClear();
    await act(async () => {
      (
        screen.getByTestId('net-worth-scroll').props.refreshControl as {
          props: { onRefresh: () => void };
        }
      ).props.onRefresh();
    });
    expect(mockApi.getNetWorth).toHaveBeenCalledTimes(1);
  });

  it('stays usable at font scale 2: scrollable, rows wrap without truncation', async () => {
    mockApi.getNetWorth.mockResolvedValue(data());
    await renderScreen();
    await screen.findByTestId('net-worth-total');
    expect(screen.getByTestId('net-worth-scroll')).toBeTruthy();
    const scroll = within(screen.getByTestId('net-worth-scroll'));
    for (const t of scroll.getAllByText(/./)) expect(t.props.numberOfLines).toBeUndefined();
  });

  it('uses dark theme text colours only', async () => {
    jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
    const store = createThemeStore();
    store.setPreference('dark');
    setThemeStore(store);
    mockApi.getNetWorth.mockResolvedValue(data({ fxMissing: true }));
    await renderScreen(<NetWorthScreen />, darkTheme);
    await screen.findByTestId('net-worth-total');
    const allowed = [darkTheme.colors.onSurface, darkTheme.colors.onSurfaceVariant];
    for (const text of screen.getAllByText(/./)) {
      const color = (StyleSheet.flatten(text.props.style) as { color?: string }).color;
      if (color !== undefined) expect(allowed).toContain(color);
    }
    setThemeStore(undefined);
  });
});

describe('More entry', () => {
  it('has a Net worth entry that opens the screen', async () => {
    await renderScreen(<MoreScreen />);
    expect(screen.getByText('Net worth')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-net-worth'));
    expect(mockRouter.push).toHaveBeenCalledWith('/more/net-worth');
  });
});
