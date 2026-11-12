import type { StatisticsResponse } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { lightTheme, WARNING_LIGHT } from '../../theme';
import { StatisticsScreen } from '../StatisticsScreen';

const mockRouter = { push: jest.fn() };
const mockApi = { getStatistics: jest.fn(), listCategories: jest.fn() };

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const eur = (minor: string) => ({ minor, currency: 'EUR' });
const mon = (key: string, income: string, spending: string, partial = false) => {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return {
    key,
    // Berlin month bounds (one hour before UTC midnight; DST is irrelevant for the day).
    start: new Date(Date.UTC(y, m - 1, 1) - 3_600_000).toISOString(),
    end: new Date(Date.UTC(y, m, 1) - 3_600_000).toISOString(),
    partial,
    income: eur(income),
    spending: eur(spending),
  };
};
const cat = (
  id: string | null,
  name: string,
  spent: string,
  previousSpent: string | null,
  trendSpent = spent,
) => ({
  categoryId: id,
  name,
  icon: null,
  color: null,
  spent: eur(spent),
  trendSpent: eur(trendSpent),
  previousSpent: previousSpent === null ? null : eur(previousSpent),
});

function stats(over: Partial<StatisticsResponse> = {}): StatisticsResponse {
  return {
    months: [
      mon('2026-09', '300000', '200000'),
      mon('2026-10', '245000', '204000'),
      mon('2026-11', '100000', '50000', true),
    ],
    averageKept: eur('41000'),
    categories: [
      cat('c1', 'Rent', '500000', '500000'),
      cat('c2', 'Food', '100000', '92593'),
      cat('c3', 'Fun', '50000', '56818'),
      cat('c4', 'Travel', '40000', '0'),
      cat('c5', 'Gifts', '30000', '30000'),
      cat('c6', 'Misc', '20000', '10000'),
      cat(null, 'Uncategorized', '10000', '0'),
    ],
    fxMissing: false,
    ...over,
  };
}

async function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider theme={lightTheme}>
        <StatisticsScreen />
      </PaperProvider>
    </QueryClientProvider>,
  );
}
const flat = (id: string) =>
  StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<string, string>;

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getStatistics.mockReset();
  mockApi.listCategories.mockResolvedValue({ categories: [] });
});

describe('StatisticsScreen', () => {
  it('loads 6 months and refetches with 12 on toggle', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Income vs spending');
    expect(mockApi.getStatistics).toHaveBeenCalledWith(6);
    expect(screen.getByText('Top categories, 6 months')).toBeTruthy();
    await fireEvent.press(screen.getByText('12 months'));
    await waitFor(() => expect(mockApi.getStatistics).toHaveBeenCalledWith(12));
    await screen.findByText('Top categories, 12 months');
  });

  it('renders one bar group per month', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Income vs spending');
    await fireEvent(screen.getByTestId('month-bars-plot'), 'layout', {
      nativeEvent: { layout: { width: 300, height: 160 } },
    });
    expect(screen.getAllByTestId(/^month-group-/)).toHaveLength(3);
  });

  it('tapping a month opens Transactions for its first to last day', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Income vs spending');
    await fireEvent(screen.getByTestId('month-bars-plot'), 'layout', {
      nativeEvent: { layout: { width: 300, height: 160 } },
    });
    await fireEvent.press(screen.getByTestId('month-group-2026-10'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/transactions',
      params: expect.objectContaining({ from: '2026-10-01', to: '2026-10-31' }),
    });
    const params = mockRouter.push.mock.calls[0][0].params as Record<string, string>;
    expect(params.categoryId).toBeUndefined();
  });

  it('shows what was kept on average', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    expect(await screen.findByText(/^You kept on average 410,00\s€ a month$/)).toBeTruthy();
  });

  it('negative average: "You spent on average X more than you earned"', async () => {
    mockApi.getStatistics.mockResolvedValue(stats({ averageKept: eur('-25000') }));
    await renderScreen();
    expect(
      await screen.findByText(/^You spent on average 250,00\s€ more than you earned$/),
    ).toBeTruthy();
  });

  it('hides the average line when averageKept is null', async () => {
    mockApi.getStatistics.mockResolvedValue(stats({ averageKept: null }));
    await renderScreen();
    await screen.findByText('Income vs spending');
    expect(screen.queryByText(/on average/)).toBeNull();
  });

  it('shows the top 5 categories, "Show all" expands inline', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Rent');
    expect(screen.getByText('Gifts')).toBeTruthy();
    expect(screen.queryByText('Misc')).toBeNull();
    await fireEvent.press(screen.getByText('Show all'));
    expect(screen.getByText('Misc')).toBeTruthy();
    expect(screen.getByText('Uncategorized')).toBeTruthy();
    expect(screen.getByText('Show less')).toBeTruthy();
  });

  it('trend: rise in the warning colour, fall in primary, none when previous is 0 or equal', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Rent');
    const rise = screen.getByTestId('category-trend-c2');
    expect(rise).toHaveTextContent('▲ 8 %');
    expect(flat('category-trend-c2').color).toBe(WARNING_LIGHT);
    expect(screen.getByTestId('category-trend-c3')).toHaveTextContent('▼ 12 %');
    expect(flat('category-trend-c3').color).toBe(lightTheme.colors.primary);
    expect(screen.queryByTestId('category-trend-c4')).toBeNull();
    expect(screen.queryByTestId('category-trend-c1')).toBeNull();
  });

  it('compares trendSpent (complete months), not spent, and shows no trend for incomplete history', async () => {
    mockApi.getStatistics.mockResolvedValue(
      stats({
        categories: [
          // Window total includes a big partial current month; the complete months are steady.
          cat('s', 'Steady', '300000', '100000', '100000'),
          cat('n', 'NoHistory', '50000', null, '50000'),
        ],
      }),
    );
    await renderScreen();
    await screen.findByText('Steady');
    expect(screen.queryByTestId('category-trend-s')).toBeNull();
    expect(screen.queryByTestId('category-trend-n')).toBeNull();
  });

  it('rounds the trend half away from zero with bigint maths', async () => {
    mockApi.getStatistics.mockResolvedValue(
      stats({
        categories: [
          cat('a', 'A', '10050', '10000'),
          cat('b', 'B', '9950', '10000'),
          cat('c', 'C', '9007199254740993000', '9007199254740992000'),
        ],
      }),
    );
    await renderScreen();
    await screen.findByText('A');
    expect(screen.getByTestId('category-trend-a')).toHaveTextContent('▲ 1 %');
    expect(screen.getByTestId('category-trend-b')).toHaveTextContent('▼ 1 %');
    expect(screen.queryByTestId('category-trend-c')).toBeNull();
  });

  it('share bar is relative to the largest category', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Rent');
    expect(flat('category-share-c1').width).toBe('100%');
    expect(flat('category-share-c2').width).toBe('20%');
  });

  it('tapping a category drills down with the window', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('category-row-c2'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/transactions',
      params: expect.objectContaining({ categoryId: 'c2', from: '2026-09-01', to: '2026-11-30' }),
    });
  });

  it('uncategorized drills down with uncategorized=1', async () => {
    mockApi.getStatistics.mockResolvedValue(stats());
    await renderScreen();
    await screen.findByText('Rent');
    await fireEvent.press(screen.getByText('Show all'));
    await fireEvent.press(screen.getByTestId('category-row-uncategorized'));
    const params = mockRouter.push.mock.calls[0][0].params as Record<string, string>;
    expect(params.uncategorized).toBe('1');
    expect(params.categoryId).toBeUndefined();
  });

  it('empty state for a brand-new household (no months)', async () => {
    mockApi.getStatistics.mockResolvedValue(
      stats({ months: [], averageKept: null, categories: [] }),
    );
    await renderScreen();
    expect(await screen.findByText('Statistics appear after your first full month.')).toBeTruthy();
    expect(screen.queryByTestId('statistics-error')).toBeNull();
  });

  it('empty state when only the current month exists', async () => {
    mockApi.getStatistics.mockResolvedValue(
      stats({ months: [mon('2026-11', '100', '50', true)], averageKept: null }),
    );
    await renderScreen();
    expect(await screen.findByText('Statistics appear after your first full month.')).toBeTruthy();
  });

  it('shows the FX notice', async () => {
    mockApi.getStatistics.mockResolvedValue(stats({ fxMissing: true }));
    await renderScreen();
    expect(await screen.findByText("Some foreign amounts couldn't be converted.")).toBeTruthy();
  });

  it('error without cache: error state with Retry', async () => {
    mockApi.getStatistics.mockRejectedValue(new ApiClientError({ kind: 'unauthorized' }));
    await renderScreen();
    expect(await screen.findByTestId('statistics-error', {}, { timeout: 10000 })).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('offline without cache: offline empty state', async () => {
    mockApi.getStatistics.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderScreen();
    expect(await screen.findByText("You're offline", {}, { timeout: 5000 })).toBeTruthy();
  });
});
