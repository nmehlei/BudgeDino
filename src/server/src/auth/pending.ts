import { newToken } from './tokens.js';

export interface PendingRegistration {
  id: string;
  inviteTokenHash: string;
  householdId: string;
  role: 'admin' | 'member';
  email: string;
  emailBidx: string;
  displayName: string;
  deviceName: string;
  passwordHash: string;
  totpSecret: string;
  expiresAt: number;
  failedAttempts: number;
}

export type NewPendingRegistration = Omit<
  PendingRegistration,
  'id' | 'expiresAt' | 'failedAttempts'
>;

/** Registrations awaiting their first TOTP code. Interface so a table-backed store can replace it. */
export interface PendingRegistrationStore {
  create(data: NewPendingRegistration, nowMs: number): Promise<string>;
  get(id: string, nowMs: number): Promise<PendingRegistration | undefined>;
  /** Counts a wrong code; the registration is dropped once `maxAttempts` is reached. */
  recordFailure(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export const PENDING_TTL_MS = 15 * 60 * 1000;
export const PENDING_MAX_ATTEMPTS = 5;
const MAX_ENTRIES = 10_000;

/** Single-instance store (P1). Holds the password hash and TOTP secret in memory only until confirmed. */
export class InMemoryPendingRegistrationStore implements PendingRegistrationStore {
  private readonly entries = new Map<string, PendingRegistration>();

  create(data: NewPendingRegistration, nowMs: number): Promise<string> {
    if (this.entries.size >= MAX_ENTRIES) this.sweep(nowMs);
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    const id = newToken();
    this.entries.set(id, {
      ...data,
      id,
      expiresAt: nowMs + PENDING_TTL_MS,
      failedAttempts: 0,
    });
    return Promise.resolve(id);
  }

  get(id: string, nowMs: number): Promise<PendingRegistration | undefined> {
    const entry = this.entries.get(id);
    if (entry && entry.expiresAt <= nowMs) {
      this.entries.delete(id);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry);
  }

  recordFailure(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.failedAttempts += 1;
      if (entry.failedAttempts >= PENDING_MAX_ATTEMPTS) this.entries.delete(id);
    }
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.entries.delete(id);
    return Promise.resolve();
  }

  private sweep(nowMs: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(id);
    }
  }
}
