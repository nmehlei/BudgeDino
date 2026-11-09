import { and, eq } from 'drizzle-orm';
import {
  generateDataKey,
  unwrapDataKey,
  wrapDataKey,
  type DataKey,
  type MasterKey,
} from '../crypto/index.js';
import type { Db } from '../db/client.js';
import { householdKeys } from '../db/schema.js';

/**
 * Per-household key ring. Unwrapped data keys are cached in memory for the lifetime of the process;
 * the master key is never persisted.
 */
export class Keyring {
  private master: MasterKey;
  private readonly cache = new Map<string, Promise<DataKey>>();

  constructor(
    private readonly db: Db,
    master: MasterKey,
  ) {
    this.master = master;
  }

  get masterKeyId(): string {
    return this.master.id;
  }

  /** Generates and stores the first (active) data key for a new household. */
  async createForHousehold(householdId: string): Promise<DataKey> {
    const dk = generateDataKey();
    await this.db.insert(householdKeys).values({
      householdId,
      version: 1,
      wrappedKey: wrapDataKey(this.master, dk, householdId),
      masterKeyId: this.master.id,
      active: true,
    });
    this.cache.set(householdId, Promise.resolve(dk));
    return dk;
  }

  /** Returns the household's active data key (cached; unwrapped on first use). */
  forHousehold(householdId: string): Promise<DataKey> {
    const cached = this.cache.get(householdId);
    if (cached) return cached;
    const pending = this.load(householdId);
    this.cache.set(householdId, pending);
    pending.catch(() => {
      // do not cache failures
      if (this.cache.get(householdId) === pending) this.cache.delete(householdId);
    });
    return pending;
  }

  private async load(householdId: string): Promise<DataKey> {
    const [row] = await this.db
      .select()
      .from(householdKeys)
      .where(and(eq(householdKeys.householdId, householdId), eq(householdKeys.active, true)));
    if (!row) throw new Error('No active data key for household');
    return unwrapDataKey(this.master, row.wrappedKey, householdId);
  }

  /**
   * Re-wraps every household key from `oldMaster` to `newMaster` in a single transaction. Any failure
   * (e.g. wrong old master) rolls back and leaves all keys untouched. On success this keyring switches
   * to the new master.
   */
  async rotateMaster(oldMaster: MasterKey, newMaster: MasterKey): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(householdKeys).for('update');
      for (const row of rows) {
        const dk = unwrapDataKey(oldMaster, row.wrappedKey, row.householdId);
        await tx
          .update(householdKeys)
          .set({
            wrappedKey: wrapDataKey(newMaster, dk, row.householdId),
            masterKeyId: newMaster.id,
          })
          .where(
            and(
              eq(householdKeys.householdId, row.householdId),
              eq(householdKeys.version, row.version),
            ),
          );
      }
    });
    this.master = newMaster;
  }
}
