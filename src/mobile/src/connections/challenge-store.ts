import type { ChallengeView } from '@budgedino/shared';

export interface ChallengeEntry {
  view: ChallengeView;
  /** Used by "Try again" to start a fresh reconnect. */
  connectorId: string;
}

/**
 * In-memory hand-off of a challenge from the screen that started it to the challenge screen. The API
 * never returns the challenge payload again (the status endpoint has state only), and the payload can
 * hold a photoTAN image, so it deliberately lives outside the (persisted) query cache.
 */
const entries = new Map<string, ChallengeEntry>();

export const challengeStore = {
  set(entry: ChallengeEntry): void {
    entries.set(entry.view.id, entry);
  },
  get(id: string): ChallengeEntry | undefined {
    return entries.get(id);
  },
  delete(id: string): void {
    entries.delete(id);
  },
  clear(): void {
    entries.clear();
  },
};
