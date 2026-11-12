/**
 * Calendar maths on `YYYY-MM` month keys. The server already resolved the household time zone into the
 * key, so nothing here touches a time zone (no Intl zone lookups, no device clock).
 */

export interface MonthParts {
  year: number;
  /** 1 to 12. */
  month: number;
}

const LONG_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function parseMonthKey(key: string): MonthParts | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
}

const keyOf = (year: number, month: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

/** The key of the month before `key`, or null for a malformed key. */
export function previousMonthKey(key: string): string | null {
  const p = parseMonthKey(key);
  if (!p) return null;
  return p.month === 1 ? keyOf(p.year - 1, 12) : keyOf(p.year, p.month - 1);
}

/** Days in the month (28 to 31, leap years included), 0 for a malformed key. */
export function daysInMonth(key: string): number {
  const p = parseMonthKey(key);
  if (!p) return 0;
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

/** "November", or null for a malformed key. */
export function monthLongName(key: string): string | null {
  const p = parseMonthKey(key);
  return p ? (LONG_NAMES[p.month - 1] ?? null) : null;
}

/** First and last day of the month as `YYYY-MM-DD`, empty for a malformed key. */
export function monthDayRange(key: string): { from?: string; to?: string } {
  const p = parseMonthKey(key);
  if (!p) return {};
  const prefix = keyOf(p.year, p.month);
  return { from: `${prefix}-01`, to: `${prefix}-${String(daysInMonth(key)).padStart(2, '0')}` };
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Inclusive first and last day of a period key: `YYYY-MM` (calendar month) or `YYYY-Www` (ISO week,
 * Monday to Sunday). Empty for anything else.
 */
export function periodDayRange(key: string): { from?: string; to?: string } {
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!week) return monthDayRange(key);
  const w = Number(week[2]);
  if (w < 1 || w > 53) return {};
  const jan4 = Date.UTC(Number(week[1]), 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (w - 1) * 7 * DAY_MS;
  return { from: isoDay(monday), to: isoDay(monday + 6 * DAY_MS) };
}
