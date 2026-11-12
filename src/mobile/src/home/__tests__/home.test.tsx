import type { BudgetView, ConnectorInfo, HomeResponse } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { daysLeftInPeriod, formatRelative } from '../../format/time';
import { lightTheme, WARNING_LIGHT } from '../../theme';
import { groupForHome } from '../budget-math';
import { CategoryList } from '../CategoryList';
import { HomeScreen } from '../HomeScreen';

const mockRouter = { push: jest.fn() };
const mockApi = {
  getHome: jest.fn(),
  syncConnector: jest.fn(),
  listMembers: jest.fn(),
  listCategories: jest.fn(),
};

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
    categoryIds: ['c1'],
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
      { categoryId: 'c2', name: 'Rent', spent: eur('90000'), icon: null, color: null },
      { categoryId: 'c1', name: 'Food', spent: eur('12345'), icon: null, color: null },
    ],
    daily: [],
    income: eur('250000'),
    uncategorizedIncome: eur('0'),
    fxMissing: false,
    sync: [ownOk, ownAttention, otherOk],
    ...over,
  };
}

const members = (role: 'admin' | 'member') => ({
  members: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Me',
      role,
      joinedAt: '2026-01-01T00:00:00.000Z',
      isSelf: true,
      disabled: false,
    },
  ],
});

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
  mockApi.listMembers.mockReset();
  mockApi.listCategories.mockReset();
  mockApi.listCategories.mockResolvedValue({ categories: [] });
  mockApi.listMembers.mockResolvedValue(members('member'));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('budget rows', () => {
  const styleOf = () => ({ icon: 'cart' as const, color: 'green' });
  const renderRow = (b: BudgetView, now = new Date('2026-11-12T10:00:00Z')) => {
    const breakdown = [{ categoryId: 'c1', name: 'Food', spent: b.spent, icon: null, color: null }];
    return render(
      <PaperProvider>
        <CategoryList
          groups={groupForHome([b], breakdown)}
          fxMissing={false}
          styleOf={styleOf}
          onOpenCategory={jest.fn()}
          now={now}
        />
      </PaperProvider>,
    );
  };
  const fill = () =>
    StyleSheet.flatten(screen.getByTestId('budget-bar-fill').props.style) as {
      width: string;
      backgroundColor: string;
    };

  it('shows "spent / amount", a 6 dp bar and a 2 x 12 dp pace tick at the elapsed fraction', async () => {
    // 12 Nov 10:00Z is 11.42 of 30 days into the period (UTC bounds): 38.06 %.
    await renderRow(budget());
    expect(screen.getByTestId('budget-amounts')).toHaveTextContent(/^100,00\s€ \/ 400,00\s€$/);
    expect(fill().width).toBe('25%');
    expect(fill().backgroundColor).toBe(lightTheme.colors.primary);
    const track = StyleSheet.flatten(screen.getByTestId('budget-bar-track').props.style) as {
      height: number;
    };
    expect(track.height).toBe(6);
    const tick = StyleSheet.flatten(screen.getByTestId('pace-tick').props.style) as {
      left: string;
      width: number;
      height: number;
      opacity: number;
      backgroundColor: string;
    };
    expect(tick).toMatchObject({
      left: '38.06%',
      width: 2,
      height: 12,
      opacity: 0.55,
      backgroundColor: lightTheme.colors.onSurface,
    });
    expect(screen.queryByTestId('budget-over')).toBeNull();
  });

  it('ratio 1.25 shows a full red bar and "Over by" the exact difference in the error colour', async () => {
    await renderRow(budget({ spent: eur('50000'), ratio: '1.2500' }));
    expect(fill().width).toBe('100%');
    expect(fill().backgroundColor).toBe(lightTheme.colors.error);
    expect(screen.getByTestId('budget-amounts')).toHaveTextContent(/500,00.*\/.*400,00/);
    const over = screen.getByTestId('budget-over');
    expect(over).toHaveTextContent(/^Over by 100,00\s€$/);
    expect((StyleSheet.flatten(over.props.style) as { color: string }).color).toBe(
      lightTheme.colors.error,
    );
  });

  it('refund (negative spent) clamps at 0 % and shows the negative amount', async () => {
    await renderRow(budget({ spent: eur('-2500'), ratio: '0.0000' }));
    expect(fill().width).toBe('0%');
    expect(screen.getAllByText(/-25,00/).length).toBeGreaterThan(0);
  });

  it('zero budget: no division by zero, empty bar without spending', async () => {
    await renderRow(budget({ amount: eur('0'), spent: eur('0'), ratio: '0.0000' }));
    expect(fill().width).toBe('0%');
    expect(screen.queryByTestId('budget-over')).toBeNull();
  });

  it('zero budget with spending: full red bar, over by the spending', async () => {
    await renderRow(budget({ amount: eur('0'), spent: eur('100'), ratio: '0.0000' }));
    expect(fill().width).toBe('100%');
    expect(fill().backgroundColor).toBe(lightTheme.colors.error);
    expect(screen.getByTestId('budget-over')).toHaveTextContent(/^Over by 1,00\s€$/);
  });

  it('shows JPY without decimals and a huge amount exactly', async () => {
    await renderRow(
      budget({
        amount: { minor: '5000000', currency: 'JPY' },
        spent: { minor: '123456789012345', currency: 'JPY' },
        ratio: '24691357.8025',
      }),
    );
    expect(screen.getAllByText(/123\.456\.789\.012\.345/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('budget-over')).toHaveTextContent(/123\.456\.784\.012\.345/);
  });

  it('notes missing FX rates', async () => {
    await renderRow(budget({ fxMissing: true }));
    expect(screen.getByText("Some foreign amounts couldn't be converted.")).toBeTruthy();
  });

  it('labels weekly budgets "week" and monthly ones not', async () => {
    await renderRow(budget({ periodKind: 'weekly' }));
    expect(screen.getByText('week')).toBeTruthy();
    await renderRow(budget());
    expect(screen.queryByText('week')).toBeNull();
  });
});

describe('daysLeftInPeriod', () => {
  // November 2026 in Berlin: start 2026-10-31T23:00Z, end (exclusive) 2026-11-30T23:00Z.
  const end = '2026-11-30T23:00:00.000Z';
  it('counts today and the last day, in the household time zone', () => {
    expect(daysLeftInPeriod(end, Date.parse('2026-11-12T10:00:00Z'))).toBe(19);
    expect(daysLeftInPeriod(end, Date.parse('2026-11-30T22:30:00Z'))).toBe(1);
    // 23:30Z on 31 Oct is already 1 Nov in Berlin.
    expect(daysLeftInPeriod(end, Date.parse('2026-10-31T23:30:00Z'))).toBe(30);
  });
  it('never goes negative and survives garbage', () => {
    expect(daysLeftInPeriod(end, Date.parse('2026-12-05T10:00:00Z'))).toBe(0);
    expect(daysLeftInPeriod('nonsense', Date.now())).toBe(0);
  });
});

describe('HomeScreen', () => {
  it('shows budgets, sorted breakdown, income and connector chips', async () => {
    mockApi.getHome.mockResolvedValue(home());
    await renderHome();
    await screen.findByText('Groceries');
    // One list: the budget row first, then the categories no budget covers.
    expect(screen.getByTestId('budget-b1')).toBeTruthy();
    expect(screen.getByTestId('category-row-c2')).toHaveTextContent(/Rent/);
    expect(screen.queryByTestId('category-row-c1')).toBeNull();
    expect(screen.getByTestId('income-row')).toHaveTextContent(/2\.500,00/);
    expect(screen.queryByTestId('uncategorized-income-row')).toBeNull();
    expect(screen.getByTestId('connector-chip-c-own-ok')).toBeTruthy();
    expect(screen.getAllByText('5 min ago').length).toBeGreaterThan(0);
    expect(screen.getByText('never synced')).toBeTruthy();
  });

  it('drills down from a breakdown row to that category in the displayed period', async () => {
    mockApi.getHome.mockResolvedValue(
      home({
        // Berlin midnights, as the server sends them.
        period: {
          kind: 'monthly',
          key: '2026-11',
          start: '2026-10-31T23:00:00.000Z',
          end: '2026-11-30T23:00:00.000Z',
        },
        breakdown: [
          { categoryId: 'c2', name: 'Rent', spent: eur('90000'), icon: null, color: null },
          { categoryId: null, name: 'Uncategorised', spent: eur('500'), icon: null, color: null },
        ],
      }),
    );
    await renderHome();
    await screen.findByText('Groceries');
    const rent = screen.getByTestId('category-row-c2');
    const uncategorised = screen.getByTestId('category-row-uncategorized');

    await fireEvent.press(rent);
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/transactions',
      params: { categoryId: 'c2', from: '2026-11-01', to: '2026-11-30', n: expect.any(String) },
    });

    await fireEvent.press(uncategorised);
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/transactions',
      params: { uncategorized: '1', from: '2026-11-01', to: '2026-11-30', n: expect.any(String) },
    });
  });

  it('labels chips with the display name or the bank name, never the raw type', async () => {
    mockApi.getHome.mockResolvedValue(
      home({
        sync: [
          { ...ownOk, id: 'c-fake', bank: 'fake', type: 'fake' } as ConnectorInfo,
          { ...ownOk, id: 'c-named', displayName: 'Anna DKB' } as ConnectorInfo,
          { ...ownOk, id: 'c-dkb' } as ConnectorInfo,
          { ...otherOk, bank: 'comdirect' } as ConnectorInfo,
        ],
      }),
    );
    await renderHome();
    expect(await screen.findByText('Demo bank: OK')).toBeTruthy();
    expect(screen.getByText('Anna DKB: OK')).toBeTruthy();
    expect(screen.getByText('DKB: OK')).toBeTruthy();
    expect(screen.getByText('Comdirect: OK')).toBeTruthy();
    expect(screen.queryByText(/fake: OK/)).toBeNull();
    expect(screen.queryByText(/fints: OK/)).toBeNull();
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
    await fireEvent.press(screen.getByTestId('period-previous'));
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
      // Paper's button labels (Retry) are short and single-line; all content, incl. Banner and Snackbar text, wraps.
      if (['Retry'].includes(t.props.children as string)) continue;
      expect(t.props.numberOfLines).toBeUndefined();
      expect(t.props.allowFontScaling).not.toBe(false);
    }
    const bar = StyleSheet.flatten(screen.getByTestId('budget-bar-track').props.style) as {
      height: number;
    };
    expect(bar.height).toBe(6); // decorative bar is not text, so it needs no scaling
    // Rows lay out with wrap and no fixed heights, so a long name pushes the amounts below it.
    for (const id of ['budget-amounts', 'summary-spent', 'income-row']) {
      const style = StyleSheet.flatten(screen.getByTestId(id).props.style) as { height?: number };
      expect(style.height).toBeUndefined();
    }
    await fireEvent.press(screen.getByTestId('period-previous'));
  });
});

describe('HomeScreen redesign', () => {
  const NOV = {
    kind: 'monthly' as const,
    key: '2026-11',
    start: '2026-10-31T23:00:00.000Z',
    end: '2026-11-30T23:00:00.000Z',
  };
  const OCT = {
    kind: 'monthly' as const,
    key: '2026-10',
    start: '2026-09-30T22:00:00.000Z',
    end: '2026-10-31T23:00:00.000Z',
  };

  it('header: arrows switch the period, the useless one is disabled, subtitle follows the period', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-12T10:00:00Z'));
    mockApi.getHome.mockImplementation((period: string) =>
      Promise.resolve(home({ period: period === 'previous' ? OCT : NOV })),
    );
    await renderHome();
    expect(await screen.findByText('November 2026')).toBeTruthy();
    const prev = () => screen.getByLabelText('Previous period');
    const next = () => screen.getByLabelText('Current period');
    expect(prev().props.accessibilityState).toMatchObject({ disabled: false });
    expect(next().props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByTestId('period-subtitle')).toHaveTextContent(/^19 days left/);

    await fireEvent.press(prev());
    expect(await screen.findByText('October 2026')).toBeTruthy();
    expect(screen.getByTestId('period-subtitle')).toHaveTextContent('Previous period');
    expect(prev().props.accessibilityState).toMatchObject({ disabled: true });
    expect(next().props.accessibilityState).toMatchObject({ disabled: false });

    await fireEvent.press(next());
    expect(await screen.findByText('November 2026')).toBeTruthy();
    expect(mockApi.getHome).toHaveBeenCalledWith('current');
  });

  it('summary: the headline total is the exact bigint sum of the breakdown, with "spent so far"', async () => {
    mockApi.getHome.mockResolvedValue(
      home({
        breakdown: [
          {
            categoryId: 'c2',
            name: 'Rent',
            spent: eur('9007199254740993'),
            icon: null,
            color: null,
          },
          { categoryId: 'c1', name: 'Food', spent: eur('12345'), icon: null, color: null },
        ],
      }),
    );
    await renderHome();
    // 9007199254740993 + 12345 = 9007199254753338 minor units, beyond 2^53: exact only with bigint.
    expect(await screen.findByTestId('summary-spent')).toHaveTextContent(
      /^90\.071\.992\.547\.533,38\s€$/,
    );
    expect(screen.getByText('spent so far')).toBeTruthy();
    expect(screen.queryByTestId('summary-budgeted')).toBeNull();
    expect(screen.getByTestId('income-row')).toHaveTextContent(/^Income 2\.500,00\s€$/);
  });

  it('summary: no total for mixed currencies', async () => {
    mockApi.getHome.mockResolvedValue(
      home({
        budgets: [],
        breakdown: [
          { categoryId: 'c1', name: 'Food', spent: eur('100'), icon: null, color: null },
          {
            categoryId: 'c2',
            name: 'Travel',
            spent: { minor: '100', currency: 'USD' },
            icon: null,
            color: null,
          },
        ],
      }),
    );
    await renderHome();
    expect(await screen.findByTestId('summary-mixed')).toBeTruthy();
    expect(screen.queryByTestId('summary-spent')).toBeNull();
  });

  describe('comparison and chart', () => {
    const day = (i: number, minor: number) => ({
      date: `2026-11-${String(i + 1).padStart(2, '0')}`,
      spent: eur(String(minor)),
    });
    const series = (minors: number[]) => minors.map((m, i) => day(i, m));
    // Previous month: 40938 by day 3, then quiet (30 days).

    function serve(current: number[], previous: number[] | null) {
      mockApi.getHome.mockImplementation((period: string) =>
        Promise.resolve(
          period === 'current'
            ? home({ period: NOV, daily: series(current) })
            : home({ period: OCT, daily: previous ? series(previous) : [] }),
        ),
      );
    }

    it('"less" in the primary colour: 58 € under last month by this day', async () => {
      // Current 35138 by day 3 against 40938.
      serve([10000, 10000, 15138], [20000, 10000, 10938, ...Array<number>(27).fill(0)]);
      await renderHome();
      const line = await screen.findByTestId('summary-comparison');
      expect(line).toHaveTextContent(/^↓ 58,00\s€ less than by this day last month$/);
      expect((StyleSheet.flatten(line.props.style) as { color: string }).color).toBe(
        lightTheme.colors.primary,
      );
    });

    it('"more" in the warning colour', async () => {
      serve([30000, 10000, 10938], [20000, 10000, 10938, ...Array<number>(27).fill(0)]);
      await renderHome();
      const line = await screen.findByTestId('summary-comparison');
      expect(line).toHaveTextContent(/^↑ 100,00\s€ more than by this day last month$/);
      expect((StyleSheet.flatten(line.props.style) as { color: string }).color).toBe(WARNING_LIGHT);
    });

    it('is hidden when the previous period is empty or equal', async () => {
      serve([10000, 10000, 15138], null);
      await renderHome();
      await screen.findByTestId('summary-spent');
      await waitFor(() => {
        expect(mockApi.getHome).toHaveBeenCalledWith('previous');
      });
      expect(screen.queryByTestId('summary-comparison')).toBeNull();
    });

    it('is hidden when equal', async () => {
      serve([20000, 10000, 10938], [20000, 10000, 10938, ...Array<number>(27).fill(0)]);
      await renderHome();
      await screen.findByTestId('summary-spent');
      await waitFor(() => {
        expect(client.getQueryData(['home', 'previous'])).toBeDefined();
      });
      expect(screen.queryByTestId('summary-comparison')).toBeNull();
    });

    it('draws the chart with a today dot for the current period', async () => {
      serve([10000, 10000, 15138], [20000, 10000, 10938, ...Array<number>(27).fill(0)]);
      await renderHome();
      await screen.findByTestId('pace-plot');
      await fireEvent(screen.getByTestId('pace-plot'), 'layout', {
        nativeEvent: { layout: { width: 290, height: 150 } },
      });
      expect(screen.getByTestId('pace-today-dot')).toBeTruthy();
      await waitFor(() => {
        expect(screen.getByTestId('pace-previous-path')).toBeTruthy();
      });
      expect(screen.getByText('this month')).toBeTruthy();
      expect(screen.getByText('October')).toBeTruthy();
    });

    it('on the previous period: no today dot, no comparison line, compared with the month before', async () => {
      mockApi.getHome.mockImplementation((period: string) =>
        Promise.resolve(
          period === 'current'
            ? home({ period: NOV, daily: series([100]) })
            : home({
                period: OCT,
                daily: series([10000, 10000, 15138]),
              }),
        ),
      );
      await renderHome();
      await screen.findByText('November 2026');
      await fireEvent.press(screen.getByTestId('period-previous'));
      await screen.findByText('October 2026');
      await waitFor(() => {
        expect(mockApi.getHome).toHaveBeenCalledWith('2026-09');
      });
      await fireEvent(screen.getByTestId('pace-plot'), 'layout', {
        nativeEvent: { layout: { width: 290, height: 150 } },
      });
      expect(screen.queryByTestId('pace-today-dot')).toBeNull();
      expect(screen.queryByTestId('summary-comparison')).toBeNull();
      expect(screen.getByText('spent')).toBeTruthy();
      expect(screen.getByText('September')).toBeTruthy();
    });

    it('1st of the month, nothing spent yet: flat chart, no comparison, no crash', async () => {
      serve([0], [0, 0, 0, ...Array<number>(27).fill(0)]);
      await renderHome();
      await screen.findByTestId('pace-plot');
      expect(screen.queryByTestId('summary-comparison')).toBeNull();
    });
  });

  describe('list', () => {
    const multi = budget({
      id: 'b2',
      name: 'Fun',
      categoryIds: ['c3', 'c4'],
      spent: eur('5000'),
      amount: eur('20000'),
      ratio: '0.2500',
    });
    const withMulti = () =>
      home({
        budgets: [budget(), multi],
        breakdown: [
          { categoryId: 'c2', name: 'Rent', spent: eur('90000'), icon: null, color: null },
          { categoryId: 'c3', name: 'Games', spent: eur('5000'), icon: null, color: null },
          { categoryId: 'c1', name: 'Food', spent: eur('12345'), icon: null, color: null },
        ],
      });

    it('a single-category budget is one tappable row that drills into its category and own period', async () => {
      mockApi.getHome.mockResolvedValue(
        home({
          budgets: [
            budget({
              periodKind: 'weekly',
              period: {
                key: '2026-W46',
                start: '2026-11-08T23:00:00.000Z',
                end: '2026-11-15T23:00:00.000Z',
              },
            }),
          ],
        }),
      );
      await renderHome();
      await fireEvent.press(await screen.findByTestId('budget-b1'));
      expect(mockRouter.push).toHaveBeenLastCalledWith({
        pathname: '/transactions',
        params: { categoryId: 'c1', from: '2026-11-09', to: '2026-11-15', n: expect.any(String) },
      });
      expect(screen.getByText('week')).toBeTruthy();
    });

    it('a multi-category budget is not tappable; indented sub-rows are, with 0,00 muted when unspent', async () => {
      mockApi.getHome.mockResolvedValue(withMulti());
      await renderHome();
      await screen.findByText('Fun');
      expect(screen.getByTestId('budget-b2').props.accessibilityRole).toBeUndefined();
      const games = screen.getByTestId('budget-b2-category-c3');
      expect(games).toHaveTextContent(/Games.*50,00/);
      const unspent = screen.getByTestId('budget-b2-category-c4');
      expect(unspent).toHaveTextContent(/0,00\s€/);
      await fireEvent.press(games);
      expect(mockRouter.push).toHaveBeenLastCalledWith({
        pathname: '/transactions',
        params: expect.objectContaining({ categoryId: 'c3', n: expect.any(String) }),
      });
      // Sub-rows are not repeated in the rest.
      expect(screen.queryByTestId('category-row-c3')).toBeNull();
      expect(screen.getByTestId('category-row-c2')).toBeTruthy();
    });

    it('rest rows are tappable', async () => {
      mockApi.getHome.mockResolvedValue(home());
      await renderHome();
      await fireEvent.press(await screen.findByTestId('category-row-c2'));
      expect(mockRouter.push).toHaveBeenCalledTimes(1);
    });

    it('admins get no budget editor from Home any more (single rows drill down)', async () => {
      mockApi.getHome.mockResolvedValue(home());
      mockApi.listMembers.mockResolvedValue(members('admin'));
      await renderHome();
      await fireEvent.press(await screen.findByTestId('budget-b1'));
      expect(mockRouter.push).not.toHaveBeenCalledWith('/more/budgets/b1');
    });
  });

  describe('sync line', () => {
    it('is compact in the header when everything is ok, without the status bar', async () => {
      mockApi.getHome.mockResolvedValue(home({ sync: [ownOk] }));
      await renderHome();
      await screen.findByText('Groceries');
      expect(screen.getByTestId('period-subtitle')).toHaveTextContent(
        /days? left · ✓ synced 5 min ago$/,
      );
      expect(screen.queryByTestId('sync-status')).toBeNull();
    });

    it('keeps the full bar when a connector has a problem', async () => {
      mockApi.getHome.mockResolvedValue(home({ sync: [ownOk, ownAttention] }));
      await renderHome();
      await screen.findByText('Groceries');
      expect(screen.getByTestId('sync-status')).toBeTruthy();
      expect(screen.getByTestId('period-subtitle')).not.toHaveTextContent(/synced/);
    });
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
