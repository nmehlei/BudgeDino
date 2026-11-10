import type { BudgetView, ConnectorInfo, HomeResponse } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { formatRelative } from '../../format/time';
import { lightTheme } from '../../theme';
import { BudgetCard } from '../BudgetCard';
import { HomeScreen } from '../HomeScreen';

const mockRouter = { push: jest.fn() };
const mockApi = { getHome: jest.fn(), syncConnector: jest.fn() };

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const eur = (minor: string) => ({ minor, currency: 'EUR' });

function budget(over: Partial<BudgetView> = {}): BudgetView {
  return {
    id: 'b1',
    name: 'Groceries',
    categoryIds: [],
    periodKind: 'monthly',
    amount: eur('40000'),
    spent: eur('10000'),
    ratio: '0.2500',
    fxMissing: false,
    period: { key: '2026-11', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
    ...over,
  };
}

const ownOk: ConnectorInfo = {
  id: 'c-own-ok',
  type: 'fints',
  status: 'ok',
  isOwner: true,
  bank: 'dkb',
  displayName: null,
  experimental: false,
  lastSuccessAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastErrorCode: null,
  consentExpiresAt: null,
};
const ownAttention: ConnectorInfo = { ...ownOk, id: 'c-own-att', status: 'needs_attention' };
const otherOk: ConnectorInfo = {
  id: 'c-other',
  type: 'psd2',
  status: 'ok',
  isOwner: false,
  bank: 'dkb',
  lastSuccessAt: null,
};

function home(over: Partial<HomeResponse> = {}): HomeResponse {
  return {
    period: {
      kind: 'monthly',
      key: '2026-11',
      start: '2026-11-01T00:00:00.000Z',
      end: '2026-12-01T00:00:00.000Z',
    },
    budgets: [budget()],
    breakdown: [
      { categoryId: 'c2', name: 'Rent', spent: eur('90000') },
      { categoryId: 'c1', name: 'Food', spent: eur('12345') },
    ],
    income: eur('250000'),
    uncategorizedIncome: eur('0'),
    fxMissing: false,
    sync: [ownOk, ownAttention, otherOk],
    ...over,
  };
}

let client: QueryClient;
async function renderHome() {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>
        <HomeScreen />
      </PaperProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getHome.mockReset();
  mockApi.syncConnector.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('BudgetCard', () => {
  const renderCard = (b: BudgetView) =>
    render(
      <PaperProvider>
        <BudgetCard budget={b} />
      </PaperProvider>,
    );
  const fill = () =>
    StyleSheet.flatten(screen.getByTestId('budget-bar-fill').props.style) as {
      width: string;
      backgroundColor: string;
    };

  it('ratio 1.25 shows a full red bar with the amounts', async () => {
    await renderCard(budget({ spent: eur('50000'), ratio: '1.2500' }));
    expect(fill().width).toBe('100%');
    expect(fill().backgroundColor).toBe(lightTheme.colors.error);
    expect(screen.getByText(/500,00/)).toBeTruthy();
    expect(screen.getByText(/of 400,00/)).toBeTruthy();
    expect(screen.getByText('Over budget (125 %)')).toBeTruthy();
  });

  it('refund (negative spent) clamps at 0 % and shows the negative amount', async () => {
    await renderCard(budget({ spent: eur('-2500'), ratio: '0.0000' }));
    expect(fill().width).toBe('0%');
    expect(screen.getByText(/-25,00/)).toBeTruthy();
  });

  it('zero budget: no division by zero, empty bar without spending', async () => {
    await renderCard(budget({ amount: eur('0'), spent: eur('0'), ratio: '0.0000' }));
    expect(fill().width).toBe('0%');
    expect(screen.getByText('0 % used')).toBeTruthy();
  });

  it('zero budget with spending: full red bar', async () => {
    await renderCard(budget({ amount: eur('0'), spent: eur('100'), ratio: '0.0000' }));
    expect(fill().width).toBe('100%');
    expect(fill().backgroundColor).toBe(lightTheme.colors.error);
  });

  it('shows JPY without decimals and a huge amount exactly', async () => {
    await renderCard(
      budget({
        amount: { minor: '5000000', currency: 'JPY' },
        spent: { minor: '123456789012345', currency: 'JPY' },
        ratio: '24691357.8025',
      }),
    );
    expect(screen.getByText(/123\.456\.789\.012\.345/)).toBeTruthy();
  });

  it('notes missing FX rates', async () => {
    await renderCard(budget({ fxMissing: true }));
    expect(screen.getByText("Some foreign amounts couldn't be converted.")).toBeTruthy();
  });

  it('labels the period kind', async () => {
    await renderCard(budget({ periodKind: 'weekly' }));
    expect(screen.getByText('Weekly')).toBeTruthy();
  });
});

describe('HomeScreen', () => {
  it('shows budgets, sorted breakdown, income and connector chips', async () => {
    mockApi.getHome.mockResolvedValue(home());
    await renderHome();
    await screen.findByText('Groceries');
    const rows = screen.getAllByTestId('breakdown-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/Rent/);
    expect(screen.getByTestId('income-row')).toHaveTextContent(/2\.500,00/);
    expect(screen.queryByTestId('uncategorized-income-row')).toBeNull();
    expect(screen.getByTestId('connector-chip-c-own-ok')).toBeTruthy();
    expect(screen.getAllByText('5 min ago').length).toBeGreaterThan(0);
    expect(screen.getByText('never synced')).toBeTruthy();
  });

  it('shows uncategorised income when present', async () => {
    mockApi.getHome.mockResolvedValue(home({ uncategorizedIncome: eur('1000') }));
    await renderHome();
    expect(await screen.findByTestId('uncategorized-income-row')).toBeTruthy();
  });

  it('switches to the previous period and caches both periods separately', async () => {
    mockApi.getHome.mockImplementation((period: string) =>
      Promise.resolve(
        period === 'previous'
          ? home({ budgets: [budget({ id: 'b0', name: 'Old budget' })] })
          : home(),
      ),
    );
    await renderHome();
    await screen.findByText('Groceries');
    await fireEvent.press(screen.getByText('Previous'));
    await waitFor(() => {
      expect(mockApi.getHome).toHaveBeenCalledWith('previous');
    });
    await waitFor(() => {
      expect(client.getQueryData(['home', 'previous'])).toBeDefined();
    });
    const current = client.getQueryData(['home', 'current']);
    const previous = client.getQueryData(['home', 'previous']);
    expect(current).toBeDefined();
    expect(previous).toBeDefined();
    expect(previous).not.toEqual(current);
  });

  it('a non-429 sync error shows "Sync failed" and still refetches', async () => {
    mockApi.getHome.mockResolvedValue(home());
    mockApi.syncConnector.mockRejectedValue(new ApiClientError({ kind: 'server', status: 500 }));
    await renderHome();
    await screen.findByText('Groceries');
    const calls = mockApi.getHome.mock.calls.length;
    await act(async () => {
      await (
        screen.getByTestId('home-scroll').props.refreshControl as {
          props: { onRefresh: () => Promise<void> };
        }
      ).props.onRefresh();
    });
    expect(await screen.findByText('Sync failed')).toBeTruthy();
    expect(mockApi.getHome.mock.calls.length).toBeGreaterThan(calls);
  });

  it('shows a humanised period header', async () => {
    mockApi.getHome.mockResolvedValue(
      home({
        period: {
          kind: 'monthly',
          key: '2026-11',
          start: '2026-10-31T23:00:00.000Z',
          end: '2026-11-30T23:00:00.000Z',
        },
      }),
    );
    await renderHome();
    expect(await screen.findByText('November 2026')).toBeTruthy();
  });

  it('needs-attention chip of an own connector opens Connections; others are inert', async () => {
    mockApi.getHome.mockResolvedValue(
      home({ sync: [ownAttention, { ...otherOk, status: 'needs_attention' }] }),
    );
    await renderHome();
    await fireEvent.press(await screen.findByTestId('connector-chip-c-own-att'));
    expect(mockRouter.push).toHaveBeenCalledWith('/connections');
    mockRouter.push.mockClear();
    await fireEvent.press(screen.getByTestId('connector-chip-c-other'));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('pull-to-refresh syncs only own ok connectors, then refetches', async () => {
    mockApi.getHome.mockResolvedValue(home());
    mockApi.syncConnector.mockResolvedValue({ runId: 'r1' });
    await renderHome();
    await screen.findByText('Groceries');
    const calls = mockApi.getHome.mock.calls.length;
    await act(async () => {
      await (
        screen.getByTestId('home-scroll').props.refreshControl as {
          props: { onRefresh: () => Promise<void> };
        }
      ).props.onRefresh();
    });
    expect(mockApi.syncConnector).toHaveBeenCalledTimes(1);
    expect(mockApi.syncConnector).toHaveBeenCalledWith('c-own-ok');
    expect(mockApi.getHome.mock.calls.length).toBeGreaterThan(calls);
  });

  it('429 on sync shows a toast with the wait time and still refetches', async () => {
    mockApi.getHome.mockResolvedValue(home());
    mockApi.syncConnector.mockRejectedValue(
      new ApiClientError({ kind: 'rate_limited', retryAfterSec: 42 }),
    );
    await renderHome();
    await screen.findByText('Groceries');
    await act(async () => {
      await (
        screen.getByTestId('home-scroll').props.refreshControl as {
          props: { onRefresh: () => Promise<void> };
        }
      ).props.onRefresh();
    });
    expect(await screen.findByText('Already syncing, try again in 42 s')).toBeTruthy();
  });

  it('offline with cached data: shows the data, the offline banner and a working retry', async () => {
    mockApi.getHome.mockResolvedValue(home());
    await renderHome();
    await screen.findByText('Groceries');

    mockApi.getHome.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['home'] });
    });
    await waitFor(() => {
      expect(screen.getByTestId('offline-banner')).toBeTruthy();
    });
    expect(screen.getByText(/^Offline — showing data from \d\d\.\d\d\., \d\d:\d\d$/)).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();

    mockApi.getHome.mockResolvedValue(home());
    await fireEvent.press(screen.getByText('Retry'));
    await waitFor(() => {
      expect(screen.queryByTestId('offline-banner')).toBeNull();
    });
  });

  it('offline without a cache: clear empty state with retry, no endless spinner', async () => {
    mockApi.getHome.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderHome();
    expect(await screen.findByText("You're offline", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByLabelText('Loading')).toBeNull();

    mockApi.getHome.mockResolvedValue(home());
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('Groceries')).toBeTruthy();
  });

  it('a server error without cache shows a generic error state', async () => {
    mockApi.getHome.mockRejectedValue(new ApiClientError({ kind: 'schema_mismatch' }));
    await renderHome();
    expect(await screen.findByText('Something went wrong', {}, { timeout: 8000 })).toBeTruthy();
  }, 15000);

  // Structural proxy only: jest cannot lay text out, so this checks that nothing opts out of font
  // scaling or truncates (numberOfLines) and that the screen scrolls. Real layout needs a device.
  it('stays usable at font scale 2: scrollable, wrapping text, no truncation', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    mockApi.syncConnector.mockRejectedValue(new ApiClientError({ kind: 'server', status: 500 }));
    mockApi.getHome.mockResolvedValue(
      home({
        budgets: [budget({ name: 'A very long budget name that has to wrap onto several lines' })],
      }),
    );
    await renderHome();
    await screen.findByText(/A very long budget name/);
    expect(screen.getByTestId('home-scroll')).toBeTruthy();
    // Bring up the Banner (offline) and the Snackbar (sync failed) so their text is covered too.
    mockApi.getHome.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await act(async () => {
      await (
        screen.getByTestId('home-scroll').props.refreshControl as {
          props: { onRefresh: () => Promise<void> };
        }
      ).props.onRefresh();
    });
    await screen.findByText(/^Offline — showing data from/, {}, { timeout: 5000 });
    await screen.findByText('Sync failed');
    for (const t of screen.getAllByText(/.+/)) {
      // Paper's button labels (segmented buttons, Retry) are short and single-line; all content, incl. Banner and Snackbar text, wraps.
      if (['Current', 'Previous', 'Retry'].includes(t.props.children as string)) continue;
      expect(t.props.numberOfLines).toBeUndefined();
      expect(t.props.allowFontScaling).not.toBe(false);
    }
    const bar = StyleSheet.flatten(screen.getByTestId('budget-bar-track').props.style) as {
      height: number;
    };
    expect(bar.height).toBe(8); // decorative bar is not text, so it needs no scaling
    await fireEvent.press(screen.getByText('Previous'));
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('buckets', () => {
    expect(formatRelative('2026-11-10T11:59:40Z', now)).toBe('just now');
    expect(formatRelative('2026-11-10T11:00:00Z', now)).toBe('60 min ago'.replace('60 min', '1 h'));
    expect(formatRelative('2026-11-08T12:00:00Z', now)).toBe('2 d ago');
    expect(formatRelative('nonsense', now)).toBe('unknown');
  });
});
