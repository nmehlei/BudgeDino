import { DEFAULT_CATEGORIES } from '../categorization/defaults.js';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { categories, households } from '../db/schema.js';
import { createInvite } from './invites.js';
import type { Keyring } from './keyring.js';

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export interface BootstrapResult {
  householdId: string;
  /** One-time admin invite token. */
  inviteToken: string;
  inviteExpiresAt: Date;
}

/**
 * Creates a household with its data key, the default categories and a one-time admin invite, all in
 * one transaction.
 */
export async function bootstrapHousehold(
  deps: { db: Db; keyring: Keyring },
  input: { name: string; timezone: string; now?: Date },
): Promise<BootstrapResult> {
  if (!isValidTimezone(input.timezone)) throw new Error('Unknown timezone');
  const now = input.now ?? new Date();
  return deps.db.transaction(async (tx) => {
    const householdId = newId();
    await tx
      .insert(households)
      .values({ id: householdId, name: input.name, timezone: input.timezone });
    await deps.keyring.createForHousehold(householdId, tx);
    await tx.insert(categories).values(
      DEFAULT_CATEGORIES.map((c) => ({
        householdId,
        name: c.name,
        isIncome: c.isIncome ?? false,
        isTransfer: c.isTransfer ?? false,
      })),
    );
    const invite = await createInvite(tx, { householdId, role: 'admin', now });
    return { householdId, inviteToken: invite.token, inviteExpiresAt: invite.expiresAt };
  });
}
