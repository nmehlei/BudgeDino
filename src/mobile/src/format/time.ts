/** "just now", "5 min ago", "3 h ago", "2 d ago" for an ISO timestamp (or epoch ms). */
export function formatRelative(value: string | number, now: number = Date.now()): string {
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(t)) return 'unknown';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** "09.11., 14:05" in the device time zone. */
export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}., ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "09.11.2026" in the device time zone. */
export function formatDate(value: string | number): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export const HOUSEHOLD_TZ_FALLBACK = 'Europe/Berlin';

const MONTHS = [
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

/** Calendar year, month (0-based), day and `YYYY-MM-DD` string of an instant in a time zone. */
export function zonedYmd(
  epochMs: number,
  timeZone: string = HOUSEHOLD_TZ_FALLBACK,
): { y: number; m: number; d: number; iso: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const y = get('year');
  const m = get('month') - 1;
  const d = get('day');
  const iso = `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { y, m, d, iso };
}

/**
 * Human period header from the server's `start` (inclusive) and `end` (exclusive) instants:
 * monthly "November 2026", weekly "10–16 Nov" or "28 Oct – 3 Nov" across months. Days are taken in
 * the household time zone, so a Berlin midnight (22:00/23:00Z the day before) is not off by one.
 */
export function formatPeriodLabel(
  kind: 'weekly' | 'monthly',
  startIso: string,
  endIso: string,
  timeZone: string = HOUSEHOLD_TZ_FALLBACK,
): string {
  const fallback = kind === 'weekly' ? 'Week' : 'Month';
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return fallback;
  try {
    const s = zonedYmd(start, timeZone);
    if (kind === 'monthly') return `${MONTHS[s.m] ?? ''} ${s.y}`;
    const e = zonedYmd(Math.max(start, end - 1), timeZone); // end is exclusive: last included day
    const mon = (m: number) => (MONTHS[m] ?? '').slice(0, 3);
    if (s.y === e.y && s.m === e.m) return `${s.d}–${e.d} ${mon(e.m)}`;
    return `${s.d} ${mon(s.m)} – ${e.d} ${mon(e.m)}`;
  } catch {
    return fallback;
  }
}
