import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { darkTheme, lightTheme } from '../../theme';
import { PaceChart } from '../PaceChart';

const day = (date: string, minor: number) => ({
  date,
  spent: { minor: String(minor), currency: 'EUR' },
});
const range = (prefix: string, minors: number[]) =>
  minors.map((m, i) => day(`${prefix}-${String(i + 1).padStart(2, '0')}`, m));

async function renderChart(
  props: Partial<React.ComponentProps<typeof PaceChart>> = {},
  theme = lightTheme,
) {
  await render(
    <PaperProvider theme={theme}>
      <PaceChart
        current={range('2026-11', [10000, 15138, 10000])}
        previous={range('2026-10', [20000, 20000, 940, 0])}
        dayCount={30}
        showToday
        currency="EUR"
        labels={{ current: 'this month', previous: 'October' }}
        {...props}
      />
    </PaperProvider>,
  );
  await fireEvent(screen.getByTestId('pace-plot'), 'layout', {
    nativeEvent: { layout: { width: 290, height: 150 } },
  });
}

describe('PaceChart', () => {
  it('draws current and previous paths, today dot and labels', async () => {
    await renderChart();
    expect(screen.getByTestId('pace-current-path')).toBeTruthy();
    expect(screen.getByTestId('pace-previous-path')).toBeTruthy();
    expect(screen.getByTestId('pace-fill-path')).toBeTruthy();
    expect(screen.getByTestId('pace-today-dot')).toBeTruthy();
    expect(screen.getByText('1 Nov')).toBeTruthy();
    expect(screen.getByText('30 Nov')).toBeTruthy();
    expect(screen.getByText('today')).toBeTruthy();
    expect(screen.getByText('October')).toBeTruthy();
  });

  it('has no previous path when previous is undefined', async () => {
    await renderChart({ previous: undefined });
    expect(screen.queryByTestId('pace-previous-path')).toBeNull();
  });

  it('has no previous path when previous sums to zero', async () => {
    await renderChart({ previous: range('2026-10', [0, 0, 0]) });
    expect(screen.queryByTestId('pace-previous-path')).toBeNull();
  });

  it('has no today dot or label when showToday is false', async () => {
    await renderChart({ showToday: false });
    expect(screen.queryByTestId('pace-today-dot')).toBeNull();
    expect(screen.queryByText('today')).toBeNull();
  });

  it('describes the comparison for accessibility', async () => {
    await renderChart();
    const label = screen.getByTestId('pace-chart').props.accessibilityLabel as string;
    expect(label).toMatch(/^Spent 351\s€ so far this month; 409\s€ by this day last month\.$/);
  });

  it('describes a closed period without "so far" and names the month before', async () => {
    await renderChart({ showToday: false, labels: { current: 'October', previous: 'September' } });
    const label = screen.getByTestId('pace-chart').props.accessibilityLabel as string;
    expect(label).toMatch(/^Spent 351\s€ in October; 409\s€ in September\.$/);
  });

  it('draws the previous-period legend swatch as dashes, not a solid bar', async () => {
    await renderChart();
    const swatch = screen.getByTestId('pace-previous-swatch');
    expect(swatch.children).toHaveLength(3);
  });

  it('draws a flat start without NaN on the 1st of the month', async () => {
    await renderChart({ current: range('2026-11', [0]), previous: undefined });
    const d = screen.getByTestId('pace-current-path').props.d as string;
    expect(d).not.toContain('NaN');
    expect(d.startsWith('M0,')).toBe(true);
  });

  const lastX = (d: string) => Number(/L([\d.]+),[\d.]+$/.exec(d)?.[1]);
  // layout width 290 minus 2 x 6 inset = 278 over 29 day steps
  const step = 278 / 29;

  it('ends a shorter previous period at its own last x', async () => {
    await renderChart({ previous: range('2026-10', [100, 100, 100, 100]) });
    const d = screen.getByTestId('pace-previous-path').props.d as string;
    expect(lastX(d)).toBeCloseTo(3 * step, 1);
  });

  it('clips a previous period longer than dayCount at the right edge', async () => {
    await renderChart({ previous: range('2026-10', Array<number>(35).fill(100)) });
    const d = screen.getByTestId('pace-previous-path').props.d as string;
    expect(lastX(d)).toBeCloseTo(278, 1);
  });

  it('renders in the dark theme', async () => {
    await renderChart({}, darkTheme);
    expect(screen.getByTestId('pace-today-dot')).toBeTruthy();
  });
});
