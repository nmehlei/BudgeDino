import type { TransactionInfo } from '@budgedino/shared';

import { formatDateHeader, groupByBookingDate, zonedIsoDate } from '../group';

const tx = (id: string, bookingDate: string): TransactionInfo => ({
  id,
  accountId: 'a',
  status: 'booked',
  bookingDate,
  valueDate: null,
  amountMinor: '-100',
  currency: 'EUR',
  counterparty: null,
  purpose: null,
  categoryId: null,
  categorySource: 'none',
  transferGroupId: null,
  splits: [],
});

describe('formatDateHeader', () => {
  // 2026-11-10 00:30 in Berlin is still 2026-11-09 23:30Z.
  const now = Date.parse('2026-11-09T23:30:00Z');

  it('uses the Berlin calendar day for Today and Yesterday', () => {
    expect(zonedIsoDate(now)).toBe('2026-11-10');
    expect(formatDateHeader('2026-11-10', now)).toBe('Today');
    expect(formatDateHeader('2026-11-09', now)).toBe('Yesterday');
  });

  it('formats older dates with weekday, day, month and year', () => {
    expect(formatDateHeader('2026-11-02', now)).toBe('Mon, 2 Nov 2026');
    expect(formatDateHeader('2025-12-31', now)).toBe('Wed, 31 Dec 2025');
  });

  it('returns a malformed value unchanged', () => {
    expect(formatDateHeader('soon', now)).toBe('soon');
  });
});

describe('groupByBookingDate', () => {
  it('groups consecutive transactions of the same booking date, keeping order', () => {
    const sections = groupByBookingDate(
      [tx('1', '2026-11-05'), tx('2', '2026-11-05'), tx('3', '2026-11-04')],
      Date.parse('2026-11-20T12:00:00Z'),
    );
    expect(sections.map((s) => [s.date, s.data.map((t) => t.id)])).toEqual([
      ['2026-11-05', ['1', '2']],
      ['2026-11-04', ['3']],
    ]);
    expect(sections[0]?.title).toBe('Thu, 5 Nov 2026');
  });
});
