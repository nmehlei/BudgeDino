import type { AccountInfo, CategoryInfo, TransactionInfo } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { lightTheme } from '../../theme';

import { ApiClientError } from '../../api/errors';
import { AccountsScreen } from '../AccountsScreen';
import { TransactionDetailScreen } from '../TransactionDetailScreen';
import { TransactionsScreen } from '../TransactionsScreen';

const mockRouter = { push: jest.fn(), back: jest.fn() };
const mockApi = {
  listTransactions: jest.fn(),
  listCategories: jest.fn(),
  listAccounts: jest.fn(),
  patchTransaction: jest.fn(),
  updateAccount: jest.fn(),
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

const FOOD = 'cat-food';
const FUN = 'cat-fun';
const categories: CategoryInfo[] = [
  { id: FOOD, name: 'Food', group: null, isIncome: false, isTransfer: false, archived: false },
  { id: FUN, name: 'Fun', group: 'Leisure', isIncome: false, isTransfer: false, archived: false },
  { id: 'old', name: 'Old', group: null, isIncome: false, isTransfer: false, archived: true },
];

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
    categoryId: FOOD,
    categorySource: 'rule',
    transferGroupId: null,
    splits: [],
    ...over,
  };
}

function account(over: Partial<AccountInfo> = {}): AccountInfo {
  return {
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
    ...over,
  };
}

let client: QueryClient;
async function renderWithProviders(ui: React.ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>{ui}</PaperProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listCategories.mockResolvedValue({ categories });
  mockApi.listAccounts.mockResolvedValue({ accounts: [account()] });
});

describe('TransactionsScreen', () => {
  it('groups by booking date, shows a pending badge and paginates with the cursor', async () => {
    mockApi.listTransactions
      .mockResolvedValueOnce({
        transactions: [
          tx({ id: 't1', bookingDate: '2026-11-05' }),
          tx({ id: 't2', bookingDate: '2026-11-05', status: 'pending', counterparty: 'Cafe' }),
        ],
        nextCursor: '2026-11-05|00000000-0000-0000-0000-000000000002',
        scannedUntil: null,
      })
      .mockResolvedValueOnce({
        transactions: [
          tx({ id: 't3', bookingDate: '2026-11-04', counterparty: 'Kino', amountMinor: '2500' }),
        ],
        nextCursor: null,
        scannedUntil: null,
      });
    await renderWithProviders(<TransactionsScreen />);

    expect(await screen.findByText('REWE Markt')).toBeTruthy();
    expect(screen.getByText('Thu, 5 Nov 2026')).toBeTruthy();
    expect(screen.getAllByTestId('pending-badge')).toHaveLength(1);
    expect(screen.getAllByText('Food')).toHaveLength(2);
    expect(mockApi.listTransactions).toHaveBeenCalledTimes(1);
    expect(mockApi.listTransactions.mock.calls[0]?.[0]).toMatchObject({ limit: 50 });

    await act(async () => {
      await fireEvent(screen.getByTestId('transactions-list'), 'endReached');
    });
    expect(await screen.findByText('Kino')).toBeTruthy();
    expect(screen.getByText('Wed, 4 Nov 2026')).toBeTruthy();
    expect(mockApi.listTransactions).toHaveBeenCalledTimes(2);
    expect(mockApi.listTransactions.mock.calls[1]?.[0]).toMatchObject({
      cursor: '2026-11-05|00000000-0000-0000-0000-000000000002',
    });

    // The last page has no cursor: another end-reached must not fetch again.
    await act(async () => {
      await fireEvent(screen.getByTestId('transactions-list'), 'endReached');
    });
    expect(mockApi.listTransactions).toHaveBeenCalledTimes(2);
  });

  it('opens the detail screen on press', async () => {
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx()],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionsScreen />);
    await fireEvent.press(await screen.findByTestId('tx-row-t1'));
    expect(mockRouter.push).toHaveBeenCalledWith('/transaction/t1');
  });

  it('shows a retry state when the first load fails', async () => {
    mockApi.listTransactions.mockRejectedValue(new ApiClientError({ kind: 'server', status: 500 }));
    await renderWithProviders(<TransactionsScreen />);
    expect(await screen.findByTestId('transactions-error')).toBeTruthy();
  });
});

describe('TransactionDetailScreen', () => {
  async function renderDetail() {
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx()],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    await screen.findByText('Girokonto');
  }
  const checked = (id: string) =>
    screen.getByTestId(`category-${id}`).props.accessibilityState?.selected as boolean;

  it('opens and recategorizes a search hit that is not in the unfiltered list', async () => {
    mockApi.listTransactions.mockResolvedValue({
      transactions: [],
      nextCursor: null,
      scannedUntil: null,
    });
    let resolve: (v: unknown) => void = () => undefined;
    mockApi.patchTransaction.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderWithProviders(<TransactionDetailScreen id="t9" />);
    await act(async () => {
      client.setQueryData(['transactions', 'search', { q: 'rewe' }], {
        pages: [{ transactions: [tx({ id: 't9' })], nextCursor: null, scannedUntil: null }],
        pageParams: [undefined],
      });
    });
    await screen.findByText('Girokonto');
    await fireEvent.press(screen.getByTestId(`category-${FUN}`));
    await waitFor(() => expect(checked(FUN)).toBe(true));
    expect(mockApi.patchTransaction).toHaveBeenCalledWith('t9', { categoryId: FUN });
    resolve({ transaction: tx({ id: 't9', categoryId: FUN }), recategorized: 0 });
  });

  it('shows the transaction facts and hides archived categories', async () => {
    await renderDetail();
    expect(screen.getByText('REWE Markt')).toBeTruthy();
    expect(screen.getByText('Einkauf')).toBeTruthy();
    expect(screen.getByTestId('detail-amount').props.children).toMatch(/12,50/);
    expect(screen.queryByTestId('category-old')).toBeNull();
    expect(checked(FOOD)).toBe(true);
  });

  it('recategorizes optimistically, sends the counterparty flag and refreshes home', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    mockApi.patchTransaction.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderDetail();
    const invalidate = jest.spyOn(client, 'invalidateQueries');

    await fireEvent(screen.getByTestId('apply-to-counterparty'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId(`category-${FUN}`));

    await waitFor(() => expect(checked(FUN)).toBe(true));
    expect(checked(FOOD)).toBe(false);
    expect(mockApi.patchTransaction).toHaveBeenCalledWith('t1', {
      categoryId: FUN,
      applyToCounterparty: true,
    });

    await act(async () => {
      resolve({ transaction: tx({ categoryId: FUN, categorySource: 'manual' }), recategorized: 3 });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transactions'] });
    });
  });

  it('omits applyToCounterparty by default', async () => {
    mockApi.patchTransaction.mockResolvedValue({
      transaction: tx({ categoryId: FUN }),
      recategorized: 0,
    });
    await renderDetail();
    await fireEvent.press(screen.getByTestId(`category-${FUN}`));
    await waitFor(() => expect(mockApi.patchTransaction).toHaveBeenCalled());
    expect(mockApi.patchTransaction).toHaveBeenCalledWith('t1', { categoryId: FUN });
  });

  it('rolls back and shows a message when the server answers 422', async () => {
    mockApi.patchTransaction.mockRejectedValue(
      new ApiClientError({ kind: 'validation', issues: [] }),
    );
    await renderDetail();
    await fireEvent.press(screen.getByTestId(`category-${FUN}`));

    expect(await screen.findByText(/rejected this change/)).toBeTruthy();
    await waitFor(() => expect(checked(FOOD)).toBe(true));
    expect(checked(FUN)).toBe(false);
  });

  it('rolls back on a network error with its own message', async () => {
    mockApi.patchTransaction.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderDetail();
    await fireEvent.press(screen.getByTestId(`category-${FUN}`));
    expect(await screen.findByText(/No connection/)).toBeTruthy();
    await waitFor(() => expect(checked(FOOD)).toBe(true));
  });

  it('hides the counterparty toggle when there is no counterparty', async () => {
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx({ counterparty: null })],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    await screen.findByText('Girokonto');
    expect(screen.queryByTestId('apply-to-counterparty')).toBeNull();
  });
});

describe('recategorize ordering and detail polish', () => {
  it('serialises two changes: a failing first one does not roll back the second', async () => {
    let rejectFirst: (e: unknown) => void = () => undefined;
    mockApi.patchTransaction
      .mockReturnValueOnce(new Promise((_r, rej) => (rejectFirst = rej)))
      .mockResolvedValueOnce({ transaction: tx({ categoryId: FOOD }), recategorized: 0 });
    // After the settle the server is the truth: the second change (back to FOOD) was stored.
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx()],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    await screen.findByText('Girokonto');
    const selected = (id: string) =>
      screen.getByTestId(`category-${id}`).props.accessibilityState?.selected as boolean;

    await fireEvent.press(screen.getByTestId(`category-${FUN}`));
    await waitFor(() => expect(selected(FUN)).toBe(true));
    await fireEvent.press(screen.getByTestId(`category-${FOOD}`));
    // The second request waits for the first.
    expect(mockApi.patchTransaction).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectFirst(new ApiClientError({ kind: 'network' }));
    });
    await waitFor(() => expect(mockApi.patchTransaction).toHaveBeenCalledTimes(2));
    expect(mockApi.patchTransaction.mock.calls[1]?.[1]).toEqual({ categoryId: FOOD });
    await waitFor(() => expect(selected(FOOD)).toBe(true));
    expect(selected(FUN)).toBe(false);
  });

  it('shows a retry message instead of an empty list when categories fail to load', async () => {
    mockApi.listCategories.mockRejectedValue(new ApiClientError({ kind: 'server', status: 500 }));
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx()],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    expect(await screen.findByTestId('categories-error')).toBeTruthy();
    expect(screen.queryByText('No categories available.')).toBeNull();
  });

  it('resets the counterparty switch after a successful pick', async () => {
    mockApi.patchTransaction.mockResolvedValue({
      transaction: tx({ categoryId: FUN }),
      recategorized: 1,
    });
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx()],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    await screen.findByText('Girokonto');
    await fireEvent(screen.getByTestId('apply-to-counterparty'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId(`category-${FUN}`));
    await waitFor(() =>
      expect(screen.getByTestId('apply-to-counterparty').props.value).toBe(false),
    );
  });

  it('keeps long text untruncated at font scale 2', async () => {
    const fontScale = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    const longName = 'Very Long Counterparty Name GmbH & Co. KG '.repeat(4).trim();
    const longPurpose = 'Verwendungszweck mit sehr langem Text '.repeat(6).trim();
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx({ counterparty: longName, purpose: longPurpose })],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    const name = (await screen.findAllByText(longName))[0];
    const purpose = screen.getByText(longPurpose);
    expect(name?.props.numberOfLines).toBeUndefined();
    expect(purpose.props.numberOfLines).toBeUndefined();
    fontScale.mockRestore();
  });

  it('keeps a zero amount neutral and a positive one green', async () => {
    mockApi.listTransactions.mockResolvedValue({
      transactions: [tx({ amountMinor: '0' })],
      nextCursor: null,
      scannedUntil: null,
    });
    await renderWithProviders(<TransactionDetailScreen id="t1" />);
    await screen.findByText('Girokonto');
    const zero = StyleSheet.flatten(screen.getByTestId('detail-amount').props.style) as {
      color: string;
    };
    expect(zero.color).toBe(lightTheme.colors.onSurface);
  });
});

describe('AccountsScreen', () => {
  it('shows toggles only on own accounts', async () => {
    mockApi.listAccounts.mockResolvedValue({
      accounts: [
        account(),
        account({ id: 'acc2', name: 'Partner', isOwner: false, ownerMemberId: 'm2' }),
      ],
    });
    await renderWithProviders(<AccountsScreen />);
    expect(await screen.findByText('Partner')).toBeTruthy();
    expect(screen.getByTestId('private-acc1')).toBeTruthy();
    expect(screen.getByTestId('counts-acc1')).toBeTruthy();
    expect(screen.queryByTestId('private-acc2')).toBeNull();
    expect(screen.queryByTestId('counts-acc2')).toBeNull();
  });

  it("sends visibility and shows the server's countsTowardBudgets afterwards", async () => {
    // Making an account private makes the server switch counting off; the UI must follow the answer.
    mockApi.updateAccount.mockResolvedValue(
      account({ visibility: 'owner_only', countsTowardBudgets: false }),
    );
    await renderWithProviders(<AccountsScreen />);
    const counts = await screen.findByTestId('counts-acc1');
    expect(counts.props.value).toBe(true);

    await act(async () => {
      await fireEvent(screen.getByTestId('private-acc1'), 'valueChange', true);
    });
    expect(mockApi.updateAccount).toHaveBeenCalledWith('acc1', { visibility: 'owner_only' });
    await waitFor(() => expect(screen.getByTestId('counts-acc1').props.value).toBe(false));
    expect(screen.getByTestId('private-acc1').props.value).toBe(true);
  });

  it('keeps the old state and shows a message when the update fails', async () => {
    mockApi.updateAccount.mockRejectedValue(new ApiClientError({ kind: 'server', status: 500 }));
    await renderWithProviders(<AccountsScreen />);
    await screen.findByTestId('counts-acc1');
    await act(async () => {
      await fireEvent(screen.getByTestId('counts-acc1'), 'valueChange', false);
    });
    expect(await screen.findByText(/Couldn't save the change/)).toBeTruthy();
    expect(screen.getByTestId('counts-acc1').props.value).toBe(true);
  });
});
