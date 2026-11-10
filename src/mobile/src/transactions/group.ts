import type { TransactionInfo } from '@budgedino/shared';

import { HOUSEHOLD_TZ_FALLBACK, zonedYmd } from '../format/time';

export interface TransactionSection {
  /** `YYYY-MM-DD` booking date. */
  date: string;
  title: string;
  data: TransactionInfo[];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Header for a booking date: "Today", "Yesterday" or "Mon, 9 Nov 2026". A booking date is a calendar
 * day, so only "today" depends on the zone (the household's Europe/Berlin).
 */
export function formatDateHeader(
  isoDate: string,
  now: number = Date.now(),
  timeZone: string = HOUSEHOLD_TZ_FALLBACK,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  let today: string;
  try {
    today = zonedYmd(now, timeZone).iso;
  } catch {
    today = '';
  }
  if (isoDate === today) return 'Today';
  if (today !== '' && isoDate === shiftIsoDate(today, -1)) return 'Yesterday';
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return `${weekday}, ${d} ${MONTHS[m - 1] ?? ''} ${y}`;
}

/** Groups an already date-ordered list into sections by booking date, keeping order. */
export function groupByBookingDate(
  transactions: readonly TransactionInfo[],
  now: number = Date.now(),
): TransactionSection[] {
  const sections: TransactionSection[] = [];
  for (const tx of transactions) {
    const last = sections[sections.length - 1];
    if (last && last.date === tx.bookingDate) {
      last.data.push(tx);
    } else {
      sections.push({
        date: tx.bookingDate,
        title: formatDateHeader(tx.bookingDate, now),
        data: [tx],
      });
    }
  }
  return sections;
}
