import { CronExpressionParser } from 'cron-parser';
import type { RateLimitPolicy } from '../connectors/types.js';

export type Schedule = RateLimitPolicy['defaultSchedule'];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_OCCURRENCES = 1000;

/** Offset (ms) of `timeZone` from UTC at the instant `at`. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** UTC instant of the wall-clock time y-m-d hh:mm in `timeZone` (DST-aware). */
function zonedToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const first = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(first, timeZone);
}

function parseTimes(times: string[]): { hh: number; mm: number }[] {
  return times.map((t) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (!match) throw new Error(`Invalid schedule time (expected HH:MM): ${t}`);
    return { hh: Number(match[1]), mm: Number(match[2]) };
  });
}

/** Local calendar date (in `timeZone`) of the instant `at`. */
function localDate(at: number, timeZone: string): Date {
  const shifted = new Date(at + zoneOffsetMs(at, timeZone));
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** Scheduled instants in the half-open interval (from, to], ascending, in the household time zone. */
export function occurrencesBetween(
  policy: Schedule,
  timeZone: string,
  from: Date,
  to: Date,
): Date[] {
  const out: number[] = [];
  if ('times' in policy) {
    const slots = parseTimes(policy.times);
    const day = localDate(from.getTime(), timeZone);
    // one day of slack on both sides covers offset differences and DST shifts
    for (let i = -1; day.getTime() + i * DAY_MS <= to.getTime() + 2 * DAY_MS; i++) {
      const d = new Date(day.getTime() + i * DAY_MS);
      for (const { hh, mm } of slots) {
        const t = zonedToUtc(
          d.getUTCFullYear(),
          d.getUTCMonth() + 1,
          d.getUTCDate(),
          hh,
          mm,
          timeZone,
        );
        if (t > from.getTime() && t <= to.getTime()) out.push(t);
      }
    }
    out.sort((a, b) => a - b);
  } else {
    const it = CronExpressionParser.parse(policy.cron, {
      currentDate: from,
      endDate: new Date(to.getTime() + 1),
      tz: timeZone,
    });
    while (out.length < MAX_OCCURRENCES && it.hasNext()) {
      const t = it.next().toDate().getTime();
      if (t > from.getTime() && t <= to.getTime()) out.push(t);
    }
  }
  return [...new Set(out)].map((t) => new Date(t));
}

/**
 * The next scheduled runs after `from` (strictly), within the following 24 h.
 * `times` are household-local HH:MM; `cron` is evaluated in the household time zone.
 */
export function nextRuns(schedule: Schedule, timeZone: string, from: Date): Date[] {
  return occurrencesBetween(schedule, timeZone, from, new Date(from.getTime() + DAY_MS));
}
