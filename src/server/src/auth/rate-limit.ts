/**
 * Attempt counter with a fixed window. Behind an interface so the in-memory implementation (fine for
 * a single instance, P1) can be replaced by a Postgres-backed one when running several instances.
 */
export interface RateLimiter {
  /**
   * Counts one attempt for `key` BEFORE the guarded work and returns the attempts in the current
   * window including this one. Must be atomic so a parallel burst cannot slip past the check.
   */
  hit(key: string): Promise<number>;
  /** True when a result of `hit` exceeds the limit (the caller must refuse). */
  isOver(count: number): boolean;
  /** Takes back one attempt (e.g. the IP counter after a successful login). */
  release(key: string): Promise<void>;
  reset(key: string): Promise<void>;
  /** Seconds until the window of `key` ends (for `Retry-After`). */
  retryAfterSeconds(key: string): Promise<number>;
}

interface Entry {
  count: number;
  windowStart: number;
}

export interface InMemoryRateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Hard cap on tracked keys so attacker-chosen keys cannot grow memory without bound. */
  maxKeys?: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: InMemoryRateLimiterOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.windowStart >= this.options.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  hit(key: string): Promise<number> {
    const entry = this.live(key);
    if (entry) {
      entry.count += 1;
      return Promise.resolve(entry.count);
    }
    if (this.entries.size >= this.maxKeys) this.evict();
    this.entries.set(key, { count: 1, windowStart: this.now() });
    return Promise.resolve(1);
  }

  isOver(count: number): boolean {
    return count > this.options.limit;
  }

  release(key: string): Promise<void> {
    const entry = this.live(key);
    if (entry) entry.count = Math.max(0, entry.count - 1);
    return Promise.resolve();
  }

  reset(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  retryAfterSeconds(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return Promise.resolve(0);
    return Promise.resolve(
      Math.max(1, Math.ceil((entry.windowStart + this.options.windowMs - this.now()) / 1000)),
    );
  }

  /** Drops expired entries, then the oldest ones if still full. */
  private evict(): void {
    for (const key of [...this.entries.keys()]) this.live(key);
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
