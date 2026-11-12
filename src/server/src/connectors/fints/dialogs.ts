import { randomBytes } from 'node:crypto';
import type { FinTSSession } from './port';

/**
 * Non-secret bookkeeping for an open bank dialog. Only the handle (never this, nor the session)
 * leaves the process, via the connector's persisted DialogState.
 */
export interface DialogMeta {
  step: 'sync' | 'statements-probe';
  tanReference: string;
  accountRef?: string;
  /** Which statements call the probe used, so it can be continued or restarted. */
  probe?: 'statements' | 'credit-card';
  startedAt: string;
}

export interface FinTSDialogEntry {
  session: FinTSSession;
  meta: DialogMeta;
}

export interface FinTSDialogRegistryOptions {
  /** Lifetime of a dialog; matches the P1 challenge lifetime cap. */
  ttlMs?: number;
  /** Maximum live dialogs; the oldest is evicted when a new one would exceed it. */
  max?: number;
  now: () => Date;
}

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX = 100;

interface StoredEntry extends FinTSDialogEntry {
  expiresAtMs: number;
}

/**
 * In-process store for live lib-fints sessions, which cannot be serialised. Handles are 32 random
 * bytes, base64url-encoded. Lost on restart by design: a pending TAN is then re-requested.
 */
export class FinTSDialogRegistry {
  readonly #entries = new Map<string, StoredEntry>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => Date;

  constructor(opts: FinTSDialogRegistryOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.max = opts.max ?? DEFAULT_MAX;
    this.now = opts.now;
  }

  put(session: FinTSSession, meta: DialogMeta): string {
    this.sweep();
    while (this.#entries.size >= this.max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    const handle = randomBytes(32).toString('base64url');
    this.#entries.set(handle, {
      session,
      meta,
      expiresAtMs: this.now().getTime() + this.ttlMs,
    });
    return handle;
  }

  /** Returns the dialog and removes it; a dialog can be resumed only once. */
  take(handle: string): FinTSDialogEntry | undefined {
    const entry = this.live(handle);
    this.#entries.delete(handle);
    return entry;
  }

  /**
   * Puts a previously taken dialog back under its own handle (a transient bank failure must not lose
   * the session). It gets a fresh lifetime; the connector's challenge `expiresAt` still caps the
   * client-visible window.
   */
  restore(handle: string, entry: FinTSDialogEntry): void {
    this.sweep();
    this.#entries.set(handle, { ...entry, expiresAtMs: this.now().getTime() + this.ttlMs });
  }

  /** Returns the dialog without removing it. */
  peek(handle: string): FinTSDialogEntry | undefined {
    return this.live(handle);
  }

  drop(handle: string): void {
    this.#entries.delete(handle);
  }

  /** Removes every expired dialog. */
  sweep(): void {
    const nowMs = this.now().getTime();
    for (const [handle, entry] of this.#entries) {
      if (nowMs >= entry.expiresAtMs) this.#entries.delete(handle);
    }
  }

  /** Drops every dialog, for shutdown. */
  clear(): void {
    this.#entries.clear();
  }

  /** Keeps live sessions (and their credentials) out of JSON.stringify and util.inspect output. */
  toJSON(): { type: 'FinTSDialogRegistry'; size: number } {
    return { type: 'FinTSDialogRegistry', size: this.#entries.size };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `FinTSDialogRegistry{size: ${this.#entries.size}}`;
  }

  private live(handle: string): FinTSDialogEntry | undefined {
    const entry = this.#entries.get(handle);
    if (!entry) return undefined;
    if (this.now().getTime() >= entry.expiresAtMs) {
      this.#entries.delete(handle);
      return undefined;
    }
    return { session: entry.session, meta: entry.meta };
  }
}
