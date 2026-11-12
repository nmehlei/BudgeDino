import { Temporal } from 'temporal-polyfill';

/** Budget periods: weekly = ISO Mon-Sun, monthly = calendar month, in an IANA time zone. */
export type PeriodKind = 'weekly' | 'monthly';

export interface Period {
  readonly kind: PeriodKind;
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
  /** '2026-W46' (weekly) or '2026-11' (monthly). */
  readonly key: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function startOfDay(day: Temporal.PlainDate, timeZone: string): Date {
  return new Date(day.toZonedDateTime(timeZone).epochMilliseconds);
}

export function periodFor(instant: Date, kind: PeriodKind, timeZone: string): Period {
  const day = Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  if (kind === 'weekly') {
    const first = day.subtract({ days: day.dayOfWeek - 1 });
    return {
      kind,
      start: startOfDay(first, timeZone),
      end: startOfDay(first.add({ weeks: 1 }), timeZone),
      key: `${day.yearOfWeek}-W${pad2(day.weekOfYear ?? 0)}`,
    };
  }
  const first = day.with({ day: 1 });
  return {
    kind,
    start: startOfDay(first, timeZone),
    end: startOfDay(first.add({ months: 1 }), timeZone),
    key: `${day.year}-${pad2(day.month)}`,
  };
}

export function previousPeriod(p: Period, timeZone: string): Period {
  return periodFor(new Date(p.start.getTime() - 1), p.kind, timeZone);
}
