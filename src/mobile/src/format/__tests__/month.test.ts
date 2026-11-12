import {
  daysInMonth,
  monthDayRange,
  monthLongName,
  parseMonthKey,
  periodDayRange,
  previousMonthKey,
} from '../month';

describe('month keys', () => {
  it('January goes to December of the year before', () => {
    expect(previousMonthKey('2027-01')).toBe('2026-12');
    expect(previousMonthKey('2026-11')).toBe('2026-10');
  });

  it('knows month lengths 28/29/30/31', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-10')).toBe(31);
  });

  it('names months and builds the drill-down range', () => {
    expect(monthLongName('2026-10')).toBe('October');
    expect(monthDayRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthDayRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('turns a month or ISO week key into inclusive days', () => {
    expect(periodDayRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    // ISO week 46 of 2026: Mon 9 Nov to Sun 15 Nov.
    expect(periodDayRange('2026-W46')).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    // Week 1 of 2027 starts on Mon 4 Jan; week 53 of 2026 starts Mon 28 Dec and ends in January.
    expect(periodDayRange('2027-W01')).toEqual({ from: '2027-01-04', to: '2027-01-10' });
    expect(periodDayRange('2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(periodDayRange('2026-W99')).toEqual({});
  });

  it('rejects malformed keys', () => {
    expect(parseMonthKey('2026-13')).toBeNull();
    expect(parseMonthKey('2026-W45')).toBeNull();
    expect(previousMonthKey('nope')).toBeNull();
    expect(daysInMonth('nope')).toBe(0);
    expect(monthDayRange('nope')).toEqual({});
    expect(monthLongName('nope')).toBeNull();
  });
});
