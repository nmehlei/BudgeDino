import type { AccountInfo, CategoryInfo, TransactionInfo } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { TransactionsScreen } from '../TransactionsScreen';

const mockRouter = { push: jest.fn(), back: jest.fn() };
const mockApi = {
  listTransactions: jest.fn(),
  listCategories: jest.fn(),
  listAccounts: jest.fn(),
};

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 360, height: 800 }),
}));

const categories: CategoryInfo[] = [
  {
    id: 'cat-food',
    name: 'Food',
    group: null,
    isIncome: false,
    isTransfer: false,
    archived: false,
  },
  { id: 'old', name: 'Old', group: null, isIncome: false, isTransfer: false, archived: true },
];
const account: AccountInfo = {
  id: 'acc1',
  connectorId: 'c1',
  disconnected: false,
  ownerMemberId: 'm1',
  name: 'Girokonto',
  ibanMasked: '•••• 3000',
  kind: 'checking',
  currency: 'EUR',
  visibility: 'household',
  countsTowardBudgets: true,
  balanceMinor: '10000',
  isOwner: true,
};

function tx(over: Partial<TransactionInfo> = {}): TransactionInfo {
  return {
    id: 't1',
    accountId: 'acc1',
    status: 'booked',
    bookingDate: '2026-11-05',
    valueDate: null,
    amountMinor: '-1250',
    currency: 'EUR',
    counterparty: 'REWE Markt',
    purpose: 'Einkauf',
    categoryId: 'cat-food',
    categorySource: 'rule',
    transferGroupId: null,
    splits: [],
    ...over,
  };
}

const page = (over: object = {}) => ({
  transactions: [tx()],
  nextCursor: null,
  scannedUntil: null,
  ...over,
});

const CURSOR = '2026-03-02|00000000-0000-0000-0000-000000000009';

async function renderScreen(params?: Parameters<typeof TransactionsScreen>[0]['params']) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const ui = (p: typeof params) => (
    <QueryClientProvider client={client}>
      <PaperProvider>
        <TransactionsScreen params={p} />
      </PaperProvider>
    </QueryClientProvider>
  );
  const result = await render(ui(params));
  return { rerender: (p: typeof params) => result.rerender(ui(p)) };
}

const lastQuery = () => mockApi.listTransactions.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listCategories.mockResolvedValue({ categories });
  mockApi.listAccounts.mockResolvedValue({ accounts: [account] });
  mockApi.listTransactions.mockResolvedValue(page());
});

describe('transaction search and filters', () => {
  it('queries q after a 300 ms debounce and not for fewer than 2 characters', async () => {
    await renderScreen();
    expect(await screen.findByText('REWE Markt')).toBeTruthy();
    const calls = mockApi.listTransactions.mock.calls.length;

    jest.useFakeTimers();
    try {
      await fireEvent.changeText(screen.getByTestId('transactions-search'), 'r');
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockApi.listTransactions).toHaveBeenCalledTimes(calls);

      await fireEvent.changeText(screen.getByTestId('transactions-search'), '  rewe ');
      await act(async () => {
        jest.advanceTimersByTime(299);
      });
      expect(mockApi.listTransactions).toHaveBeenCalledTimes(calls);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'rewe', limit: 50 }));
  });

  it('sets categoryId and accountId from the chips and clears them again', async () => {
    await renderScreen();
    expect(await screen.findByText('REWE Markt')).toBeTruthy();

    await fireEvent.press(screen.getByText('Category'));
    expect(screen.queryByTestId('category-option-old')).toBeNull();
    await fireEvent.press(await screen.findByTestId('category-option-cat-food'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ categoryId: 'cat-food' }));

    await fireEvent.press(screen.getByText('Account'));
    await fireEvent.press(await screen.findByTestId('account-option-acc1'));
    await waitFor(() => expect(lastQuery()).toMatchObject({ accountId: 'acc1' }));

    await fireEvent.press(screen.getByLabelText('Remove category filter'));
    await waitFor(() => expect(lastQuery().categoryId).toBeUndefined());
    expect(lastQuery()).toMatchObject({ accountId: 'acc1' });
  });

  it('shows a date-range chip from route params and removing it clears from and to', async () => {
    await renderScreen({ from: '2026-11-01', to: '2026-11-30' });
    expect(await screen.findByText('1 Nov – 30 Nov')).toBeTruthy();
    expect(mockApi.listTransactions.mock.calls[0]?.[0]).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
    });

    await fireEvent.press(screen.getByLabelText('Remove date filter'));
    await waitFor(() => expect(screen.queryByText('1 Nov – 30 Nov')).toBeNull());
    expect(lastQuery().from).toBeUndefined();
    expect(lastQuery().to).toBeUndefined();
  });

  it('applies the uncategorized route param without a categoryId', async () => {
    await renderScreen({ uncategorized: '1' });
    expect(await screen.findByLabelText('Remove uncategorised filter')).toBeTruthy();
    expect(mockApi.listTransactions.mock.calls[0]?.[0]).toMatchObject({ uncategorized: true });
    expect(mockApi.listTransactions.mock.calls[0]?.[0]).not.toHaveProperty('categoryId');
  });

  it('applies a categoryId route param', async () => {
    await renderScreen({ categoryId: 'cat-food' });
    expect(await screen.findByLabelText('Remove category filter')).toBeTruthy();
    expect(mockApi.listTransactions.mock.calls[0]?.[0]).toMatchObject({ categoryId: 'cat-food' });
  });

  it('offers to search further when the scan cap stopped on an empty page', async () => {
    mockApi.listTransactions.mockImplementation(async (q: { q?: string; cursor?: string }) => {
      if (!q.q) return page();
      if (!q.cursor)
        return page({ transactions: [], nextCursor: CURSOR, scannedUntil: '2026-03-02' });
      return page({ transactions: [tx({ id: 't9', counterparty: 'Rewe Altbestand' })] });
    });
    await renderScreen();
    expect(await screen.findByText('REWE Markt')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('transactions-search'), 'rewe');
    expect(await screen.findByText('Searched back to 02.03.2026')).toBeTruthy();
    expect(screen.queryByText('No results')).toBeNull();

    await fireEvent.press(screen.getByText('Search further'));
    expect(await screen.findByText('Rewe Altbestand')).toBeTruthy();
    expect(lastQuery()).toMatchObject({ q: 'rewe', cursor: CURSOR });
  });

  it('says "No results" for an empty final page, even after searching further', async () => {
    mockApi.listTransactions.mockImplementation(async (q: { q?: string; cursor?: string }) => {
      if (!q.q) return page();
      if (!q.cursor)
        return page({ transactions: [], nextCursor: CURSOR, scannedUntil: '2026-03-02' });
      return page({ transactions: [] });
    });
    await renderScreen();
    await screen.findByText('REWE Markt');
    await fireEvent.changeText(screen.getByTestId('transactions-search'), 'zzz');
    await fireEvent.press(await screen.findByText('Search further'));
    expect(await screen.findByText('No results')).toBeTruthy();
    expect(screen.queryByText('Search further')).toBeNull();
  });

  it('keeps offering "Search further" when an empty capped page follows earlier matches', async () => {
    const CURSOR2 = '2026-01-02|00000000-0000-0000-0000-000000000008';
    mockApi.listTransactions.mockImplementation(async (q: { q?: string; cursor?: string }) => {
      if (!q.q) return page();
      if (!q.cursor) return page({ nextCursor: CURSOR, scannedUntil: '2026-03-02' });
      if (q.cursor === CURSOR)
        return page({ transactions: [], nextCursor: CURSOR2, scannedUntil: '2026-01-02' });
      return page({ transactions: [tx({ id: 't7', counterparty: 'Rewe Spät' })] });
    });
    await renderScreen();
    await screen.findByText('REWE Markt');
    await fireEvent.changeText(screen.getByTestId('transactions-search'), 'rewe');
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'rewe' }));
    await screen.findByText('REWE Markt');
    await act(async () => {
      await fireEvent(screen.getByTestId('transactions-list'), 'endReached');
    });
    expect(await screen.findByText('Searched back to 02.01.2026')).toBeTruthy();
    expect(screen.getByText('REWE Markt')).toBeTruthy();
    await fireEvent.press(screen.getByText('Search further'));
    expect(await screen.findByText('Rewe Spät')).toBeTruthy();
    expect(screen.queryByText('Search further')).toBeNull();
  });

  it('re-applies a repeated drill-down after the chips were cleared', async () => {
    const drill = { categoryId: 'cat-food', from: '2026-11-01', to: '2026-11-30', n: '1' };
    const { rerender } = await renderScreen(drill);
    await fireEvent.press(await screen.findByLabelText('Remove category filter'));
    await fireEvent.press(screen.getByLabelText('Remove date filter'));
    await waitFor(() => expect(lastQuery().categoryId).toBeUndefined());

    await rerender({ ...drill, n: '2' });
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ categoryId: 'cat-food', from: '2026-11-01' }),
    );
    expect(await screen.findByText('1 Nov – 30 Nov')).toBeTruthy();
  });
});
