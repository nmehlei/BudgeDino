import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFinTSWiring } from '@budgedino/server/connectors/fints/wire';
import type { FinTSSession } from '@budgedino/server/connectors/fints/port';
import { createLogger } from '@budgedino/server/observability/logger';
import { ScriptedFinTSPort } from '../../../support/fints/scripted-port';

const logger = createLogger({ level: 'silent' });
const product = { id: 'PRODUCT', version: '1.0' };
const meta = { step: 'sync' as const, tanReference: 'R', startedAt: '2026-11-09T10:00:00.000Z' };

afterEach(() => vi.useRealTimers());

describe('createFinTSWiring', () => {
  it('provides the fints connector', () => {
    const w = createFinTSWiring({ product, logger, port: new ScriptedFinTSPort({}) });
    expect(w.connector.type).toBe('fints');
    w.stop();
  });

  it('sweeps expired dialogs every 60 s and stops sweeping on stop()', () => {
    vi.useFakeTimers();
    let ms = Date.parse('2026-11-09T10:00:00Z');
    const w = createFinTSWiring({
      product,
      logger,
      port: new ScriptedFinTSPort({}),
      now: () => new Date(ms),
    });
    const sweep = vi.spyOn(w.dialogs, 'sweep');
    vi.advanceTimersByTime(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    w.stop();
    ms += 3_600_000;
    vi.advanceTimersByTime(120_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('stop() clears open dialogs', () => {
    const w = createFinTSWiring({ product, logger, port: new ScriptedFinTSPort({}) });
    const handle = w.dialogs.put({} as FinTSSession, meta);
    expect(w.dialogs.peek(handle)).toBeDefined();
    w.stop();
    expect(w.dialogs.peek(handle)).toBeUndefined();
  });

  it('the timer does not keep the process alive', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const w = createFinTSWiring({ product, logger, port: new ScriptedFinTSPort({}) });
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    w.stop();
    spy.mockRestore();
  });
});
