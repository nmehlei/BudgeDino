import { and, eq } from 'drizzle-orm';
import {
  decryptString,
  generateDataKey,
  masterBlindIndex,
  unwrapDataKey,
  wrapDataKey,
  type DataKey,
  type MasterKey,
} from '../crypto/index.js';
import type { Db, DbOrTx } from '../db/client.js';
import { householdKeys, members } from '../db/schema.js';
import { emailBlindIndex } from '../repositories/members.js';

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

  /** Server-wide blind index under the current master key (see `masterBlindIndex`). */
  blindIndex(purpose: string, value: string): string {
    return masterBlindIndex(this.master, purpose, value);
  }

  /** Login lookup key for an email address (normalised first). */
  emailIndex(email: string): string {
    return emailBlindIndex(this.master, email);
  }

  /**
   * Generates and stores the first (active) data key for a new household. Pass `executor` to do it
   * inside a transaction.
   */
  async createForHousehold(householdId: string, executor: DbOrTx = this.db): Promise<DataKey> {
    const dk = generateDataKey();
    await executor.insert(householdKeys).values({
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
   * Re-wraps every household key from `oldMaster` to `newMaster` and recomputes the master-derived
   * `members.email_bidx` for every member, all in a single transaction. Any failure (e.g. wrong old
   * master) rolls back and leaves everything untouched. On success this keyring switches to the new
   * master.
   */
  async rotateMaster(oldMaster: MasterKey, newMaster: MasterKey): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.select().from(householdKeys).for('update');
      const activeKeys = new Map<string, DataKey>();
      for (const row of rows) {
        const dk = unwrapDataKey(oldMaster, row.wrappedKey, row.householdId);
        if (row.active) activeKeys.set(row.householdId, dk);
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

      const memberRows = await tx.select().from(members).for('update');
      for (const member of memberRows) {
        const dk = activeKeys.get(member.householdId);
        if (!dk) throw new Error('No active data key for member household');
        const email = decryptString(dk, member.emailEnc, {
          table: 'members',
          column: 'email',
          rowId: member.id,
        });
        await tx
          .update(members)
          .set({ emailBidx: emailBlindIndex(newMaster, email) })
          .where(eq(members.id, member.id));
      }
    });
    this.master = newMaster;
  }
}
