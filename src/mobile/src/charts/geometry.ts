/** Running total per day. Refunds can lower it, but never below 0. */
export function cumulative(daily: Array<{ spent: { minor: string } }>): bigint[] {
  const out: bigint[] = [];
  let sum = 0n;
  for (const day of daily) {
    sum += BigInt(day.spent.minor);
    if (sum < 0n) sum = 0n;
    out.push(sum);
  }
  return out;
}

/** The next 1/2/5 x 10^k at or above `maxMinor`, at least 100 minor units (whole currency units). */
export function niceMax(maxMinor: bigint): bigint {
  let magnitude = 100n;
  for (;;) {
    for (const factor of [1n, 2n, 5n]) {
      const candidate = factor * magnitude;
      if (candidate >= maxMinor) return candidate;
    }
    magnitude *= 10n;
  }
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * SVG path through the values: x = i / (dayCount - 1) * w, y scaled so `max` is the top. A single value
 * is drawn as a one-day horizontal segment so the first of the period shows a flat start.
 */
export function linePath(
  values: bigint[],
  dayCount: number,
  max: bigint,
  w: number,
  h: number,
): string {
  if (values.length === 0) return '';
  const step = dayCount > 1 ? w / (dayCount - 1) : w;
  const y = (v: bigint) => (max > 0n ? h - (Number(v) / Number(max)) * h : h);
  const points = values.map((v, i) => `${num(i * step)},${num(y(v))}`);
  if (points.length === 1) {
    const only = values[0] as bigint;
    return `M${points[0]}L${num(step)},${num(y(only))}`;
  }
  return `M${points.join('L')}`;
}

/**
 * Cumulative spending today (1-based day index) against the previous period's cumulative sum at the same
 * day, clamped to the previous period's length. Null when previous sums to zero or there is no data.
 */
export function comparisonAt(
  current: bigint[],
  previous: bigint[],
): { day: number; current: bigint; previous: bigint } | null {
  if (current.length === 0 || previous.length === 0) return null;
  const prevTotal = previous[previous.length - 1] as bigint;
  if (prevTotal <= 0n) return null;
  const day = current.length;
  return {
    day,
    current: current[day - 1] as bigint,
    previous: previous[Math.min(day, previous.length) - 1] as bigint,
  };
}
