import { describe, expect, it } from 'vitest';
import { nextRuns, occurrencesBetween } from '@budgedino/server/sync/scheduler';

const iso = (ds: Date[]) => ds.map((d) => d.toISOString());

describe('nextRuns', () => {
  const times = { times: ['06:00', '12:00', '18:00', '23:00'] };

  it('maps household-local times to UTC (CET, first run after `from`)', () => {
    const runs = nextRuns(times, 'Europe/Berlin', new Date('2026-11-09T10:00:00Z'));
    expect(runs[0]?.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(iso(runs).slice(0, 3)).toEqual([
      '2026-11-09T11:00:00.000Z',
      '2026-11-09T17:00:00.000Z',
      '2026-11-09T22:00:00.000Z',
    ]);
  });

  it('is strictly after `from` and rolls over to the next local day', () => {
    const runs = nextRuns(times, 'Europe/Berlin', new Date('2026-11-09T22:00:00Z'));
    expect(runs[0]?.toISOString()).toBe('2026-11-10T05:00:00.000Z');
  });

  it('follows DST (CEST is UTC+2)', () => {
    const runs = nextRuns(times, 'Europe/Berlin', new Date('2026-07-01T00:00:00Z'));
    expect(runs[0]?.toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('supports cron expressions in the household time zone', () => {
    const runs = nextRuns(
      { cron: '0 */4 * * *' },
      'Europe/Berlin',
      new Date('2026-11-09T10:10:00Z'),
    );
    expect(runs[0]?.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(runs[1]?.toISOString()).toBe('2026-11-09T15:00:00.000Z');
  });

  it('occurrencesBetween is (from, to]', () => {
    const got = occurrencesBetween(
      times,
      'Europe/Berlin',
      new Date('2026-11-09T11:00:00Z'),
      new Date('2026-11-09T17:00:00Z'),
    );
    expect(iso(got)).toEqual(['2026-11-09T17:00:00.000Z']);
  });
});
