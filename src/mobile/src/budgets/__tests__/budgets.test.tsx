import type { BudgetView, CategoryInfo } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { BudgetForm } from '../BudgetForm';
import { BudgetsScreen } from '../BudgetsScreen';

jest.setTimeout(20_000);

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockApi = {
  listBudgets: jest.fn(),
  createBudget: jest.fn(),
  patchBudget: jest.fn(),
  archiveBudget: jest.fn(),
  listCategories: jest.fn(),
  listMembers: jest.fn(),
};

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const cat = (id: string, name: string, over: Partial<CategoryInfo> = {}): CategoryInfo => ({
  id,
  name,
  group: null,
  isIncome: false,
  isTransfer: false,
  archived: false,
  icon: null,
  color: null,
  ...over,
});
const CATEGORIES = [
  cat('c-food', 'Groceries'),
  cat('c-fun', 'Fun'),
  cat('c-old', 'Old hobby', { archived: true }),
  cat('c-salary', 'Salary', { isIncome: true }),
  cat('c-transfer', 'Transfer', { isTransfer: true }),
];

const budget = (over: Partial<BudgetView> = {}): BudgetView => ({
  id: 'b1',
  name: 'Food',
  categoryIds: ['c-food'],
  periodKind: 'monthly',
  amount: { minor: '50000', currency: 'EUR' },
  spent: { minor: '1000', currency: 'EUR' },
  ratio: '0.0200',
  fxMissing: false,
  period: { key: '2026-11', start: '2026-10-31T23:00:00.000Z', end: '2026-11-30T23:00:00.000Z' },
  ...over,
});

const member = (role: 'admin' | 'member') => ({
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

const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

async function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>{ui}</PaperProvider>
    </QueryClientProvider>,
  );
  return { client, invalidate };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listCategories.mockResolvedValue({ categories: CATEGORIES });
  mockApi.listBudgets.mockResolvedValue({ budgets: [budget()] });
  mockApi.listMembers.mockResolvedValue(member('admin'));
});

describe('BudgetsScreen', () => {
  it('lists name, period and amount', async () => {
    await renderWithProviders(<BudgetsScreen />);
    expect(await screen.findByText('Food')).toBeTruthy();
    expect(screen.getByText(/Monthly/)).toBeTruthy();
    expect(screen.getByText(/500,00/)).toBeTruthy();
  });

  it('shows the FAB to admins and opens the create form', async () => {
    await renderWithProviders(<BudgetsScreen />);
    await fireEvent.press(await screen.findByTestId('add-budget'));
    expect(mockRouter.push).toHaveBeenCalledWith('/more/budgets/new');
  });

  it('opens the edit form for a row', async () => {
    await renderWithProviders(<BudgetsScreen />);
    await fireEvent.press(await screen.findByTestId('budget-b1'));
    expect(mockRouter.push).toHaveBeenCalledWith('/more/budgets/b1');
  });

  it('gives members a read-only list: no FAB, no edit, no delete', async () => {
    mockApi.listMembers.mockResolvedValue(member('member'));
    await renderWithProviders(<BudgetsScreen />);
    expect(await screen.findByText('Food')).toBeTruthy();
    await screen.findByTestId('budgets-readonly');
    expect(screen.queryByTestId('add-budget')).toBeNull();
    expect(screen.queryByTestId('delete-budget-b1')).toBeNull();
    await fireEvent.press(screen.getByTestId('budget-b1'));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('stays read-only (no crash) when the members request is forbidden', async () => {
    mockApi.listMembers.mockRejectedValue(new ApiClientError({ kind: 'server', status: 403 }));
    await renderWithProviders(<BudgetsScreen />);
    expect(await screen.findByText('Food')).toBeTruthy();
    expect(screen.queryByTestId('add-budget')).toBeNull();
  });

  it('shows a retryable error when budgets cannot be loaded', async () => {
    mockApi.listBudgets.mockRejectedValueOnce(new ApiClientError({ kind: 'server', status: 500 }));
    await renderWithProviders(<BudgetsScreen />);
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    mockApi.listBudgets.mockResolvedValue({ budgets: [budget()] });
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('Food')).toBeTruthy();
  });

  it('deletes only after confirmation and refreshes budgets and home', async () => {
    mockApi.archiveBudget.mockResolvedValue({ id: 'b1', archived: true });
    const { invalidate } = await renderWithProviders(<BudgetsScreen />);
    await fireEvent.press(await screen.findByTestId('delete-budget-b1'));
    expect(mockApi.archiveBudget).not.toHaveBeenCalled();
    await fireEvent.press(await screen.findByTestId('delete-budget-confirm'));
    expect(mockApi.archiveBudget).toHaveBeenCalledWith('b1');
    await screen.findByText('Budget deleted');
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['budgets', 'home']));
  });

  it('cancelling the confirmation deletes nothing', async () => {
    await renderWithProviders(<BudgetsScreen />);
    await fireEvent.press(await screen.findByTestId('delete-budget-b1'));
    await fireEvent.press(await screen.findByTestId('delete-budget-cancel'));
    expect(mockApi.archiveBudget).not.toHaveBeenCalled();
  });
});

describe('BudgetForm', () => {
  it('creates a budget with a string minor amount, the selected categories and the period', async () => {
    mockApi.createBudget.mockResolvedValue({ budget: budget() });
    const { invalidate } = await renderWithProviders(<BudgetForm />);
    await fireEvent.changeText(await screen.findByTestId('budget-name'), '  Fun money ');
    await fireEvent.press(await screen.findByTestId('category-c-fun'));
    await fireEvent.press(screen.getByTestId('category-c-food'));
    await fireEvent.press(screen.getByTestId('period-weekly'));
    await fireEvent.changeText(screen.getByTestId('budget-amount'), '500');
    await fireEvent.press(screen.getByTestId('budget-save'));

    expect(mockApi.createBudget).toHaveBeenCalledTimes(1);
    const body = mockApi.createBudget.mock.calls[0]?.[0] as {
      name: string;
      categoryIds: string[];
      periodKind: string;
      amount: { minor: unknown; currency: string };
    };
    expect(body.name).toBe('Fun money');
    expect([...body.categoryIds].sort()).toEqual(['c-food', 'c-fun']);
    expect(body.periodKind).toBe('weekly');
    expect(body.amount).toEqual({ minor: '50000', currency: 'EUR' });
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['budgets', 'home']));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('shows field errors and sends nothing for bad input', async () => {
    await renderWithProviders(<BudgetForm />);
    await fireEvent.press(await screen.findByTestId('budget-save'));
    expect(screen.getByText('Enter a name')).toBeTruthy();
    expect(screen.getByText('Pick at least one category')).toBeTruthy();
    expect(screen.getByText('Enter an amount')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('budget-amount'), '1,234');
    await fireEvent.press(screen.getByTestId('budget-save'));
    expect(screen.getByText('Use at most 2 decimal places')).toBeTruthy();
    expect(mockApi.createBudget).not.toHaveBeenCalled();
  });

  it('offers only active spending categories, but still shows an archived one on an existing budget', async () => {
    const existing = budget({ categoryIds: ['c-food', 'c-old'] });
    await renderWithProviders(<BudgetForm budget={existing} />);
    expect(await screen.findByTestId('category-c-fun')).toBeTruthy();
    expect(screen.getByTestId('category-c-food')).toBeTruthy();
    expect(screen.getByTestId('category-c-old')).toBeTruthy();
    expect(screen.queryByTestId('category-c-salary')).toBeNull();
    expect(screen.queryByTestId('category-c-transfer')).toBeNull();
  });

  it('does not offer an archived category for a new budget', async () => {
    await renderWithProviders(<BudgetForm />);
    await screen.findByTestId('category-c-fun');
    expect(screen.queryByTestId('category-c-old')).toBeNull();
  });

  it('edits a budget: prefilled, patches with a string minor amount', async () => {
    mockApi.patchBudget.mockResolvedValue({ budget: budget() });
    await renderWithProviders(
      <BudgetForm budget={budget({ amount: { minor: '123456', currency: 'EUR' } })} />,
    );
    const amount = await screen.findByTestId('budget-amount');
    expect(amount.props.value).toBe('1234,56');
    await fireEvent.changeText(amount, '1.500,5');
    await fireEvent.press(screen.getByTestId('budget-save'));
    expect(mockApi.patchBudget).toHaveBeenCalledWith('b1', {
      name: 'Food',
      categoryIds: ['c-food'],
      periodKind: 'monthly',
      amount: { minor: '150050', currency: 'EUR' },
    });
  });

  it('tells a non-admin they cannot edit, without a form', async () => {
    mockApi.listMembers.mockResolvedValue(member('member'));
    await renderWithProviders(<BudgetForm />);
    expect(await screen.findByTestId('budget-admin-only')).toBeTruthy();
    expect(screen.queryByTestId('budget-save')).toBeNull();
  });

  it('shows a friendly message when the server answers 403', async () => {
    mockApi.createBudget.mockRejectedValue(new ApiClientError({ kind: 'server', status: 403 }));
    await renderWithProviders(<BudgetForm />);
    await fireEvent.changeText(await screen.findByTestId('budget-name'), 'X');
    await fireEvent.press(await screen.findByTestId('category-c-fun'));
    await fireEvent.changeText(screen.getByTestId('budget-amount'), '10');
    await fireEvent.press(screen.getByTestId('budget-save'));
    expect(await screen.findByText('Only admins can change budgets.')).toBeTruthy();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
