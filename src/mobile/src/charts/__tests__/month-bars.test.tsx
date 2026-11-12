import { CATEGORY_COLORS } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { lightTheme } from '../../theme';
import { MonthBars, type BarMonth } from '../MonthBars';

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('../../api/useApi', () => ({
  useApi: () => ({ listCategories: jest.fn().mockResolvedValue({ categories: [] }) }),
}));

const eur = (minor: string) => ({ minor, currency: 'EUR' });
const month = (key: string, income: string, spending: string, partial = false): BarMonth => {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return {
    key,
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, m, 1)).toISOString(),
    partial,
    income: eur(income),
    spending: eur(spending),
  };
};

const MONTHS = [
  month('2026-09', '300000', '200000'),
  month('2026-10', '245000', '204000'),
  month('2026-11', '100000', '50000', true),
];

async function renderBars(
  months: BarMonth[] = MONTHS,
  onSelectMonth: (m: BarMonth) => void = jest.fn(),
  width = 300,
) {
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <PaperProvider theme={lightTheme}>
        <MonthBars months={months} onSelectMonth={onSelectMonth} />
      </PaperProvider>
    </QueryClientProvider>,
  );
  await fireEvent(screen.getByTestId('month-bars-plot'), 'layout', {
    nativeEvent: { layout: { width, height: 160 } },
  });
}

const style = (id: string) =>
  StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<string, unknown>;

describe('MonthBars', () => {
  it('renders one pressable group per month with a descriptive label', async () => {
    await renderBars();
    expect(screen.getAllByTestId(/^month-group-/)).toHaveLength(3);
    const g = screen.getByTestId('month-group-2026-10');
    expect(g.props.accessibilityLabel).toMatch(
      /^October 2026: income 2\.450\s€, spending 2\.040\s€$/,
    );
    expect(screen.getByTestId('month-group-2026-11').props.accessibilityLabel).toMatch(
      /^November 2026 \(so far\): income/,
    );
  });

  it('income uses the accent, spending the orange category colour, the partial month is faded', async () => {
    await renderBars();
    expect(style('bar-income-2026-10').backgroundColor).toBe(lightTheme.colors.primary);
    expect(style('bar-spending-2026-10').backgroundColor).toBe(CATEGORY_COLORS.orange.light);
    expect(style('bar-income-2026-10').opacity).toBe(1);
    expect(style('bar-income-2026-11').opacity).toBe(0.45);
    expect(style('bar-spending-2026-11').opacity).toBe(0.45);
  });

  it('scales bar heights proportionally on a nice max', async () => {
    await renderBars();
    const a = style('bar-income-2026-09').height as number;
    const b = style('bar-spending-2026-09').height as number;
    expect(a).toBeGreaterThan(b);
    expect(a / b).toBeCloseTo(1.5, 1);
  });

  it('labels months with short names and "so far" on the partial month when there is room', async () => {
    await renderBars();
    expect(screen.getByText('Sep')).toBeTruthy();
    expect(screen.getByText('Oct')).toBeTruthy();
    expect(screen.getByText('Nov so far')).toBeTruthy();
  });

  it('12 months stay narrow: every other label, the current month always labelled', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) =>
      month(
        `${i < 3 ? 2025 : 2026}-${String(((i + 9) % 12) + 1).padStart(2, '0')}`,
        '1000',
        '500',
        i === 11,
      ),
    );
    await renderBars(twelve, jest.fn(), 300);
    expect(screen.getAllByTestId(/^month-group-/)).toHaveLength(12);
    // Last is Sep 2026 (partial); every other month going back is labelled.
    expect(screen.getByText('Sep')).toBeTruthy();
    expect(screen.getByText('Jul')).toBeTruthy();
    expect(screen.queryByText('Aug')).toBeNull();
    expect(screen.queryByText(/so far/)).toBeNull();
  });

  it('tapping a group reports the month', async () => {
    const onSelect = jest.fn();
    await renderBars(MONTHS, onSelect);
    await fireEvent.press(screen.getByTestId('month-group-2026-10'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: '2026-10' }));
  });

  it('all-zero months render zero-height bars without NaN', async () => {
    await renderBars([month('2026-10', '0', '0')]);
    expect(style('bar-income-2026-10').height).toBe(0);
  });
});
