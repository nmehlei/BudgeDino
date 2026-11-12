import { encryptField } from '@budgedino/server/crypto';
import type { Db } from '@budgedino/server/db/client';
import { newId } from '@budgedino/server/db/ids';
import { connectors } from '@budgedino/server/db/schema';
import type { Keyring } from '@budgedino/server/households/keyring';
import { createAccount } from '@budgedino/server/repositories/accounts';
import { encryptConnectorState } from '@budgedino/server/repositories/connectors';
import type { FakeTx } from '@budgedino/server/connectors/fake/fake-connector';

/** A `fake` connector (already authenticated) with one account, scripted with `transactions`. */
export async function seedFakeConnector(
  db: Db,
  keyring: Keyring,
  householdId: string,
  ownerMemberId: string,
  opts: {
    scenario?: string;
    transactions?: FakeTx[];
    accountRef?: string;
    visibility?: 'household' | 'owner_only';
  } = {},
) {
  const dk = await keyring.forHousehold(householdId);
  const id = newId();
  const accountRef = opts.accountRef ?? 'fake-1';
  await db.insert(connectors).values({
    id,
    householdId,
    ownerMemberId,
    type: 'fake',
    configEnc: encryptField(dk, '{}', { table: 'connectors', column: 'config', rowId: id }),
    stateEnc: encryptConnectorState(dk, id, {
      scenario: opts.scenario ?? 'happy',
      accountRef,
      transactions: (opts.transactions ?? []) as never,
      fetchCount: 0,
    }),
  });
  const accountId = await createAccount(db, dk, {
    connectorId: id,
    ownerMemberId,
    externalRef: accountRef,
    name: 'Fake Checking',
    kind: 'checking',
    currency: 'EUR',
    visibility: opts.visibility ?? 'household',
  });
  return { connectorId: id, accountId };
}
