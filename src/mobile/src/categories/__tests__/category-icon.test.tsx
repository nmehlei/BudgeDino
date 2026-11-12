import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react-native';
import { CATEGORY_COLORS, fallbackCategoryStyle } from '@budgedino/shared';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { CategoryIcon } from '../CategoryIcon';
import { useCategoryStyleById } from '../useCategoryStyle';

let mockDark = false;
const mockApi = { listCategories: jest.fn() };

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('../../theme', () => {
  const actual = jest.requireActual<typeof import('../../theme')>('../../theme');
  return {
    ...actual,
    useAppTheme: () => (mockDark ? actual.darkTheme : actual.lightTheme),
  };
});

const cat = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  group: null,
  isIncome: false,
  isTransfer: false,
  archived: false,
  icon: null,
  color: null,
  ...extra,
});

const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

beforeEach(() => {
  mockDark = false;
  mockApi.listCategories.mockReset();
});

describe('CategoryIcon', () => {
  it.each([
    ['light', false],
    ['dark', true],
  ])('renders the glyph and tinted background for a key in %s', async (_name, dark) => {
    mockDark = dark;
    const mode = dark ? 'dark' : 'light';
    await render(
      <PaperProvider>
        <CategoryIcon icon="cart" color="green" size="lg" />
      </PaperProvider>,
    );
    const circle = screen.getByTestId('category-icon', { includeHiddenElements: true });
    const hex = CATEGORY_COLORS.green[mode];
    expect(circle.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: `${hex}21`,
        }),
      ]),
    );
    expect(circle.props.accessibilityElementsHidden).toBe(true);
    // The glyph is drawn in the colour at 55 % of the size.
    const glyph = within(circle).getByText(/./, { includeHiddenElements: true });
    expect(StyleSheet.flatten(glyph.props.style)).toEqual(
      expect.objectContaining({ color: hex, fontSize: 24 }),
    );
  });
});

describe('useCategoryStyleById', () => {
  async function setup(categories: unknown[]) {
    mockApi.listCategories.mockResolvedValue({ categories });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const hook = await renderHook(() => useCategoryStyleById(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <PaperProvider>{children}</PaperProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => {
      expect(mockApi.listCategories).toHaveBeenCalled();
    });
    return hook;
  }

  it('resolves stored, fallback and uncategorised', async () => {
    const { result } = await setup([
      cat('stored', { icon: 'cart', color: 'blue' }),
      cat('plain'),
      cat('old', { archived: true, icon: 'dog', color: 'red' }),
    ]);
    await waitFor(() => {
      expect(result.current('stored')).toEqual({ icon: 'cart', color: CATEGORY_COLORS.blue.light });
    });
    // Archived ones resolve too.
    expect(result.current('old')).toEqual({ icon: 'dog', color: CATEGORY_COLORS.red.light });
    // No stored values: the deterministic fallback.
    const fb = fallbackCategoryStyle('plain');
    expect(result.current('plain')).toEqual({
      icon: 'tag',
      color: CATEGORY_COLORS[fb.color].light,
    });
    // An id that is not in the list: the fallback as well.
    const fbUnknown = fallbackCategoryStyle('nope');
    expect(result.current('nope')).toEqual({
      icon: 'tag',
      color: CATEGORY_COLORS[fbUnknown.color].light,
    });
    // Uncategorised.
    expect(result.current(null)).toEqual({ icon: 'help', color: CATEGORY_COLORS.grey.light });
  });

  it('uses the dark palette in dark mode', async () => {
    mockDark = true;
    const { result } = await setup([cat('stored', { icon: 'cart', color: 'blue' })]);
    await waitFor(() => {
      expect(result.current('stored').color).toBe(CATEGORY_COLORS.blue.dark);
    });
  });
});
