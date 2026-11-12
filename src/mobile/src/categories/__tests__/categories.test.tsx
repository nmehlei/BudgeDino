import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { CategoriesScreen } from '../CategoriesScreen';
import { isRulesQueryKey } from '../keys';
import { RulesScreen } from '../RulesScreen';

jest.setTimeout(20_000);

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockApi = {
  listMembers: jest.fn(),
  listCategories: jest.fn(),
  createCategory: jest.fn(),
  patchCategory: jest.fn(),
  listRules: jest.fn(),
  deleteRule: jest.fn(),
};

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const members = (role: 'admin' | 'member') => ({
  members: [
    {
      id: 'm1',
      displayName: 'Nora',
      role,
      joinedAt: '2026-01-01T00:00:00.000Z',
      isSelf: true,
      disabled: false,
    },
  ],
});
const cat = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  group: null,
  isIncome: false,
  isTransfer: false,
  archived: false,
  ...extra,
});
const categories = [
  cat('c1', 'Groceries', { group: 'Living' }),
  cat('c2', 'Rent', { group: 'Living' }),
  cat('c3', 'Hobbies'),
  cat('c4', 'Salary', { isIncome: true, group: 'Earnings' }),
  cat('c5', 'Transfer', { isTransfer: true }),
  cat('c6', 'Old Gym', { archived: true }),
];

const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

async function renderUi(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>{ui}</PaperProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listMembers.mockResolvedValue(members('admin'));
  mockApi.listCategories.mockResolvedValue({ categories });
  mockApi.listRules.mockResolvedValue({ rules: [] });
});

describe('CategoriesScreen', () => {
  it('groups categories by group and collapses archived ones', async () => {
    await renderUi(<CategoriesScreen />);
    expect(await screen.findByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Living')).toBeTruthy();
    expect(screen.getByText('Earnings')).toBeTruthy();
    expect(screen.getByText('Income')).toBeTruthy();
    expect(screen.getByText('Hobbies')).toBeTruthy();
    // Archived ones sit in a collapsed section.
    expect(screen.getByText('Archived (1)')).toBeTruthy();
    expect(screen.queryByText('Old Gym')).toBeNull();
    await fireEvent.press(screen.getByText('Archived (1)'));
    expect(await screen.findByText('Old Gym')).toBeTruthy();
  });

  it('lets an admin add a category', async () => {
    mockApi.createCategory.mockResolvedValue({ category: cat('c9', 'Pets') });
    await renderUi(<CategoriesScreen />);
    await screen.findByText('Groceries');
    await fireEvent.press(await screen.findByTestId('add-category'));
    await fireEvent.changeText(screen.getByTestId('category-name'), '  Pets ');
    await fireEvent.changeText(screen.getByTestId('category-group'), 'Living');
    await fireEvent.press(screen.getByTestId('category-save'));
    await waitFor(() => {
      expect(mockApi.createCategory).toHaveBeenCalledWith({
        name: 'Pets',
        group: 'Living',
        isIncome: false,
      });
    });
    await waitFor(() => {
      expect(mockApi.listCategories).toHaveBeenCalledTimes(2);
    });
  });

  it('says a category with the name exists on 409', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiClientError({ kind: 'server', status: 409 }));
    await renderUi(<CategoriesScreen />);
    await screen.findByText('Groceries');
    await fireEvent.press(await screen.findByTestId('add-category'));
    await fireEvent.changeText(screen.getByTestId('category-name'), 'Rent');
    await fireEvent.press(screen.getByTestId('category-save'));
    expect(await screen.findByText('A category with this name exists.')).toBeTruthy();
    expect(screen.queryByTestId('unarchive-existing')).toBeNull();
  });

  it('shows the generic rejection message on a validation error', async () => {
    mockApi.createCategory.mockRejectedValue(
      new ApiClientError({ kind: 'validation', issues: [] }),
    );
    await renderUi(<CategoriesScreen />);
    await screen.findByText('Groceries');
    await fireEvent.press(await screen.findByTestId('add-category'));
    await fireEvent.changeText(screen.getByTestId('category-name'), 'Rent');
    await fireEvent.press(screen.getByTestId('category-save'));
    expect(
      await screen.findByText('The server rejected these values. Check them and try again.'),
    ).toBeTruthy();
    expect(screen.queryByText('This category cannot be changed.')).toBeNull();
  });

  it('offers to unarchive when the clashing name is an archived category', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiClientError({ kind: 'server', status: 409 }));
    mockApi.patchCategory.mockResolvedValue({ category: cat('c6', 'Old Gym') });
    await renderUi(<CategoriesScreen />);
    await screen.findByText('Groceries');
    await fireEvent.press(await screen.findByTestId('add-category'));
    await fireEvent.changeText(screen.getByTestId('category-name'), 'old gym');
    await fireEvent.press(screen.getByTestId('category-save'));
    expect(await screen.findByText(/It is archived/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('unarchive-existing'));
    await waitFor(() => {
      expect(mockApi.patchCategory).toHaveBeenCalledWith('c6', { archived: false });
    });
  });

  it('renames a category', async () => {
    mockApi.patchCategory.mockResolvedValue({ category: cat('c3', 'Leisure') });
    await renderUi(<CategoriesScreen />);
    await fireEvent.press(await screen.findByTestId('edit-category-c3'));
    expect(screen.getByTestId('category-name').props.value).toBe('Hobbies');
    await fireEvent.changeText(screen.getByTestId('category-name'), 'Leisure');
    await fireEvent.press(screen.getByTestId('category-save'));
    await waitFor(() => {
      expect(mockApi.patchCategory).toHaveBeenCalledWith('c3', { name: 'Leisure' });
    });
  });

  it('clears a group by sending an empty string', async () => {
    mockApi.patchCategory.mockResolvedValue({ category: cat('c1', 'Groceries') });
    await renderUi(<CategoriesScreen />);
    await fireEvent.press(await screen.findByTestId('edit-category-c1'));
    await fireEvent.changeText(screen.getByTestId('category-group'), '');
    await fireEvent.press(screen.getByTestId('category-save'));
    await waitFor(() => {
      expect(mockApi.patchCategory).toHaveBeenCalledWith('c1', { group: '' });
    });
  });

  it('archives and unarchives', async () => {
    mockApi.patchCategory.mockResolvedValue({ category: cat('c3', 'Hobbies') });
    await renderUi(<CategoriesScreen />);
    await fireEvent.press(await screen.findByTestId('archive-category-c3'));
    await waitFor(() => {
      expect(mockApi.patchCategory).toHaveBeenCalledWith('c3', { archived: true });
    });
    await fireEvent.press(screen.getByText('Archived (1)'));
    await fireEvent.press(await screen.findByTestId('unarchive-category-c6'));
    await waitFor(() => {
      expect(mockApi.patchCategory).toHaveBeenCalledWith('c6', { archived: false });
    });
  });

  it('gives the Transfer category no edit actions', async () => {
    await renderUi(<CategoriesScreen />);
    expect(await screen.findByText('Transfer')).toBeTruthy();
    await screen.findByTestId('edit-category-c3');
    expect(screen.queryByTestId('edit-category-c5')).toBeNull();
    expect(screen.queryByTestId('archive-category-c5')).toBeNull();
  });

  it('shows a member the list read-only', async () => {
    mockApi.listMembers.mockResolvedValue(members('member'));
    await renderUi(<CategoriesScreen />);
    expect(await screen.findByText('Groceries')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('categories-readonly')).toBeTruthy();
    });
    expect(screen.queryByTestId('add-category')).toBeNull();
    expect(screen.queryByTestId('edit-category-c3')).toBeNull();
    expect(screen.queryByTestId('archive-category-c3')).toBeNull();
  });

  it('shows an error with Retry when the members lookup fails, not a member view', async () => {
    mockApi.listMembers.mockRejectedValueOnce(new ApiClientError({ kind: 'network' }));
    await renderUi(<CategoriesScreen />);
    expect(await screen.findByTestId('categories-error')).toBeTruthy();
    expect(screen.queryByTestId('categories-readonly')).toBeNull();
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByTestId('add-category')).toBeTruthy();
  });

  it('opens the rules screen', async () => {
    await renderUi(<CategoriesScreen />);
    await fireEvent.press(await screen.findByTestId('open-rules'));
    expect(mockRouter.push).toHaveBeenCalledWith('/more/categories/rules');
  });
});

describe('RulesScreen', () => {
  const rules = [
    {
      id: 'r1',
      categoryId: 'c1',
      match: { kind: 'counterpartyContains', value: 'REWE' },
      createdAt: '2026-05-01T00:00:00.000Z',
    },
    {
      id: 'r2',
      categoryId: 'c6',
      match: { kind: 'iban', value: 'DE02120300000000202051' },
      createdAt: '2026-05-02T00:00:00.000Z',
    },
  ];

  it('lists own rules as match to category, archived categories included', async () => {
    mockApi.listRules.mockResolvedValue({ rules });
    await renderUi(<RulesScreen />);
    expect(await screen.findByText('REWE → Groceries')).toBeTruthy();
    expect(screen.getByText('DE02120300000000202051 → Old Gym')).toBeTruthy();
    expect(screen.getByText(/Deleting a rule does not change past transactions/)).toBeTruthy();
  });

  it('deletes a rule only after confirming', async () => {
    mockApi.listRules.mockResolvedValue({ rules });
    mockApi.deleteRule.mockResolvedValue(undefined);
    await renderUi(<RulesScreen />);
    await fireEvent.press(await screen.findByTestId('delete-rule-r1'));
    expect(mockApi.deleteRule).not.toHaveBeenCalled();
    expect(screen.getByTestId('rule-delete-dialog')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('rule-delete-confirm'));
    await waitFor(() => {
      expect(mockApi.deleteRule).toHaveBeenCalledWith('r1');
    });
    await waitFor(() => {
      expect(mockApi.listRules).toHaveBeenCalledTimes(2);
    });
  });

  it('cancelling the dialog deletes nothing', async () => {
    mockApi.listRules.mockResolvedValue({ rules });
    await renderUi(<RulesScreen />);
    await fireEvent.press(await screen.findByTestId('delete-rule-r1'));
    await fireEvent.press(screen.getByTestId('rule-delete-cancel'));
    expect(mockApi.deleteRule).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no rules', async () => {
    mockApi.listRules.mockResolvedValueOnce({ rules: [] });
    await renderUi(<RulesScreen />);
    expect(await screen.findByText(/No rules yet/)).toBeTruthy();
  });

  it('shows an error with Retry when loading fails', async () => {
    mockApi.listRules.mockRejectedValueOnce(new ApiClientError({ kind: 'network' }));
    await renderUi(<RulesScreen />);
    expect(await screen.findByTestId('rules-error')).toBeTruthy();
    mockApi.listRules.mockResolvedValue({ rules });
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('REWE → Groceries')).toBeTruthy();
  });

  it('keeps rules out of the offline cache', () => {
    expect(isRulesQueryKey(['rules'])).toBe(true);
    expect(isRulesQueryKey(['categories'])).toBe(false);
  });
});
