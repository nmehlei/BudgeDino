import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { FinTSSession } from '@budgedino/server/connectors/fints/port';
import { FinTSDialogRegistry, type DialogMeta } from '@budgedino/server/connectors/fints/dialogs';

const meta: DialogMeta = {
  step: 'sync',
  tanReference: 'REF-1',
  startedAt: '2026-11-09T10:00:00.000Z',
};

function fakeSession(tag: string): FinTSSession {
  return { tag } as unknown as FinTSSession;
}

function clock(start = '2026-11-09T10:00:00.000Z') {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
  };
}

describe('FinTSDialogRegistry', () => {
  it('returns the stored session once via take, and peek does not remove it', () => {
    const registry = new FinTSDialogRegistry({ ttlMs: 60_000, max: 10, now: clock().now });
    const session = fakeSession('a');
    const handle = registry.put(session, meta);

    expect(registry.peek(handle)).toEqual({ session, meta });
    expect(registry.peek(handle)).toEqual({ session, meta });
    expect(registry.take(handle)).toEqual({ session, meta });
    expect(registry.take(handle)).toBeUndefined();
    expect(registry.peek(handle)).toBeUndefined();
  });

  it('returns undefined for an expired handle and removes it', () => {
    const c = clock();
    const registry = new FinTSDialogRegistry({ ttlMs: 1_000, max: 10, now: c.now });
    const handle = registry.put(fakeSession('a'), meta);

    c.advance(999);
    expect(registry.peek(handle)).toBeDefined();
    c.advance(1);
    expect(registry.peek(handle)).toBeUndefined();
    expect(registry.take(handle)).toBeUndefined();
  });

  it('returns undefined for an unknown handle', () => {
    const registry = new FinTSDialogRegistry({ ttlMs: 1_000, max: 10, now: clock().now });
    expect(registry.take('does-not-exist')).toBeUndefined();
    expect(registry.peek('does-not-exist')).toBeUndefined();
  });

  it('issues unguessable handles: 32 random bytes, base64url, unique per put', () => {
    const registry = new FinTSDialogRegistry({ ttlMs: 60_000, max: 1_000, now: clock().now });
    const handles = new Set<string>();
    for (let i = 0; i < 200; i++) {
      handles.add(registry.put(fakeSession(String(i)), meta));
    }
    expect(handles.size).toBe(200);
    for (const handle of handles) {
      expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(handle, 'base64url')).toHaveLength(32);
      expect(handle).toHaveLength(43);
    }
  });

  it('evicts the oldest entry when max is reached', () => {
    const registry = new FinTSDialogRegistry({ ttlMs: 60_000, max: 2, now: clock().now });
    const a = registry.put(fakeSession('a'), meta);
    const b = registry.put(fakeSession('b'), meta);
    const c = registry.put(fakeSession('c'), meta);

    expect(registry.peek(a)).toBeUndefined();
    expect(registry.peek(b)?.session).toEqual(fakeSession('b'));
    expect(registry.peek(c)?.session).toEqual(fakeSession('c'));
  });

  it('drop removes a handle and ignores unknown handles', () => {
    const registry = new FinTSDialogRegistry({ ttlMs: 60_000, max: 10, now: clock().now });
    const handle = registry.put(fakeSession('a'), meta);
    registry.drop(handle);
    registry.drop('does-not-exist');
    expect(registry.take(handle)).toBeUndefined();
  });

  it('sweep drops expired entries and keeps live ones', () => {
    const c = clock();
    const registry = new FinTSDialogRegistry({ ttlMs: 1_000, max: 10, now: c.now });
    const old = registry.put(fakeSession('old'), meta);
    c.advance(600);
    const fresh = registry.put(fakeSession('fresh'), meta);
    c.advance(500);

    registry.sweep();

    expect(registry.peek(old)).toBeUndefined();
    expect(registry.peek(fresh)).toBeDefined();
  });

  it('clear drops every live session (shutdown)', () => {
    const registry = new FinTSDialogRegistry({ ttlMs: 60_000, max: 10, now: clock().now });
    const a = registry.put(fakeSession('a'), meta);
    const b = registry.put(fakeSession('b'), meta);
    registry.clear();
    expect(registry.peek(a)).toBeUndefined();
    expect(registry.peek(b)).toBeUndefined();
  });

  it('defaults to a 15 minute TTL and 100 entries', () => {
    const c = clock();
    const registry = new FinTSDialogRegistry({ now: c.now });
    const first = registry.put(fakeSession('first'), meta);

    c.advance(15 * 60_000 - 1);
    expect(registry.peek(first)).toBeDefined();
    c.advance(1);
    expect(registry.peek(first)).toBeUndefined();

    const registry2 = new FinTSDialogRegistry({ now: c.now });
    const oldest = registry2.put(fakeSession('oldest'), meta);
    for (let i = 0; i < 99; i++) registry2.put(fakeSession(String(i)), meta);
    expect(registry2.peek(oldest)).toBeDefined();
    registry2.put(fakeSession('overflow'), meta);
    expect(registry2.peek(oldest)).toBeUndefined();
  });

  it('does not leak sessions through inspect or JSON', () => {
    const registry = new FinTSDialogRegistry({ now: clock().now });
    registry.put({ canary: 'SESSION-CANARY-91' } as unknown as FinTSSession, meta);

    expect(inspect(registry, { depth: 10, showHidden: true })).toBe('FinTSDialogRegistry{size: 1}');
    expect(JSON.stringify(registry)).not.toContain('SESSION-CANARY-91');
    expect(`${inspect(registry)}${JSON.stringify(registry)}`).not.toContain('SESSION-CANARY-91');
  });
});

describe('FinTSDialogRegistry.restore', () => {
  it('puts a taken dialog back under the same handle with a fresh lifetime', () => {
    const c = clock();
    const registry = new FinTSDialogRegistry({ ttlMs: 60_000, max: 10, now: c.now });
    const handle = registry.put(fakeSession('a'), meta);
    c.advance(50_000);
    const entry = registry.take(handle);
    expect(entry).toBeDefined();
    if (entry) registry.restore(handle, entry);
    c.advance(30_000);
    expect(registry.peek(handle)?.meta).toEqual(meta);
    expect(registry.take(handle)).toBeDefined();
    expect(registry.take(handle)).toBeUndefined();
  });
});
