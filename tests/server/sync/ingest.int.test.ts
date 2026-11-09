import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { money } from '@budgedino/shared';
import type { FakeTx } from '@budgedino/server/connectors/fake/fake-connector';
import { createFakeConnector } from '@budgedino/server/connectors/fake/fake-connector';
import { createConnectorRegistry } from '@budgedino/server/connectors/registry';
import type { ProviderTransaction } from '@budgedino/server/connectors/types';
import type { DataKey } from '@budgedino/server/crypto';
import { categories, transactions } from '@budgedino/server/db/schema';
import { newId } from '@budgedino/server/db/ids';
import { Keyring } from '@budgedino/server/households/keyring';
import { createLogger } from '@budgedino/server/observability/logger';
import { visibleAccountIds } from '@budgedino/server/access/visibility';
import { listTransactions } from '@budgedino/server/repositories/transactions';
import { ingest } from '@budgedino/server/sync/ingest';
import { runSync, type SyncDeps } from '@budgedino/server/sync/run';
import { createHousehold, createTestMember, randomMasterKey } from '../../support/factories.js';
import { startTestDatabase, type TestDatabase } from '../../support/postgres.js';
import { seedFakeConnector } from '../../support/sync.js';

let database: TestDatabase;
let keyring: Keyring;
let householdId: string;
let memberId: string;
let dk: DataKey;
let accountId: string;
let connectorId: string;
const NOW = new Date('2026-11-09T12:00:00Z');

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);
afterAll(async () => database.stop());

beforeEach(async () => {
  await database.reset();
  keyring = new Keyring(database.db, randomMasterKey());
  householdId = await createHousehold(database.db, keyring);
  dk = await keyring.forHousehold(householdId);
  memberId = await createTestMember(database.db, keyring, householdId, { role: 'member' });
  ({ accountId, connectorId } = await seedFakeConnector(
    database.db,
    keyring,
    householdId,
    memberId,
  ));
});

const tx = (over: Partial<ProviderTransaction> = {}): ProviderTransaction => ({
  providerId: 'p-1',
  status: 'booked',
  bookingDate: '2026-11-05',
  amount: money(-320n, 'EUR'),
  counterparty: 'Corner Bakery',
  counterpartyIban: 'DE02120300000000202051',
  purpose: 'bread',
  ...over,
});

const rows = async () => {
  const visible = await visibleAccountIds(database.db, { memberId, householdId });
  return listTransactions(database.db, dk, visible);
};
const run = (txs: ProviderTransaction[]) => ingest(database.db, dk, accountId, txs, { now: NOW });

describe('ingest dedup', () => {
  it('ingesting the same batch twice creates no duplicates and reports no changes the 2nd time', async () => {
    const batch = [tx(), tx({ providerId: 'p-2', amount: money(-500n, 'EUR') })];
    const first = await run(batch);
    expect(first.inserted).toHaveLength(2);
    const second = await run(batch);
    expect(second.inserted).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(await rows()).toHaveLength(2);
  });

  it('dedupes transactions without providerId by content hash', async () => {
    await run([tx({ providerId: null })]);
    const again = await run([tx({ providerId: null })]);
    expect(again.inserted).toEqual([]);
    expect(await rows()).toHaveLength(1);
    // different purpose => different content => separate row
    await run([tx({ providerId: null, purpose: 'rolls' })]);
    expect(await rows()).toHaveLength(2);
  });

  it('keeps identical content without ids that occurs twice in one batch as two rows (stable on re-ingest)', async () => {
    await run([tx({ providerId: null }), tx({ providerId: null })]);
    expect(await rows()).toHaveLength(2);
    await run([tx({ providerId: null }), tx({ providerId: null })]);
    expect(await rows()).toHaveLength(2);
  });

  it('keeps two genuine identical 3.20 payments with distinct provider ids as two rows', async () => {
    const r = await run([tx({ providerId: 'a' }), tx({ providerId: 'b' })]);
    expect(r.inserted).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
  });

  it('stores amounts and counterparties intact', async () => {
    await run([tx()]);
    const [row] = await rows();
    expect(row).toMatchObject({
      amountMinor: -320n,
      currency: 'EUR',
      counterparty: 'Corner Bakery',
      purpose: 'bread',
      status: 'booked',
    });
  });
});

describe('pending to booked reconciliation', () => {
  async function seedCategory() {
    const id = newId();
    await database.db.insert(categories).values({ id, householdId, name: 'Groceries' });
    return id;
  }

  it('pending 42.00 then booked 48.50 (same payee, 2 days later) is one row, booked, category kept', async () => {
    const pending = await run([
      tx({
        providerId: null,
        status: 'pending',
        bookingDate: '2026-11-03',
        amount: money(-4200n, 'EUR'),
        counterparty: 'Fuel Station',
      }),
    ]);
    const pendingId = pending.inserted[0] ?? '';
    expect(pendingId).not.toBe('');
    const categoryId = await seedCategory();
    await database.db
      .update(transactions)
      .set({ categoryId, categorySource: 'manual' })
      .where(eq(transactions.id, pendingId));

    const booked = await run([
      tx({
        providerId: 'bank-77',
        status: 'booked',
        bookingDate: '2026-11-05',
        amount: money(-4850n, 'EUR'),
        counterparty: ' fuel station ',
      }),
    ]);
    expect(booked.inserted).toEqual([]);
    expect(booked.updated).toEqual([pendingId]);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: pendingId, status: 'booked', amountMinor: -4850n });
    const [raw] = await database.db.select().from(transactions);
    expect(raw?.categoryId).toBe(categoryId);
    expect(raw?.categorySource).toBe('manual');

    // and the booked row is stable from then on
    const again = await run([
      tx({
        providerId: 'bank-77',
        bookingDate: '2026-11-05',
        amount: money(-4850n, 'EUR'),
        counterparty: ' fuel station ',
      }),
    ]);
    expect(again.inserted).toEqual([]);
    expect(again.updated).toEqual([]);
  });

  it.each([
    ['amount differs by more than 25%', { amount: money(-5400n, 'EUR') }],
    ['booked more than 7 days after pending', { bookingDate: '2026-11-11' }],
    ['different counterparty', { counterparty: 'Other Shop' }],
  ])('does not merge when %s', async (_name, over) => {
    await run([
      tx({
        providerId: null,
        status: 'pending',
        bookingDate: '2026-11-03',
        amount: money(-4200n, 'EUR'),
        counterparty: 'Fuel Station',
      }),
    ]);
    await run([
      tx({
        providerId: 'x',
        bookingDate: '2026-11-05',
        amount: money(-4850n, 'EUR'),
        counterparty: 'Fuel Station',
        ...over,
      }),
    ]);
    expect(await rows()).toHaveLength(2);
  });

  it('does not match a pending row of another account', async () => {
    const other = await seedFakeConnector(database.db, keyring, householdId, memberId, {
      accountRef: 'fake-2',
    });
    await ingest(
      database.db,
      dk,
      other.accountId,
      [tx({ providerId: null, status: 'pending', counterparty: 'Fuel Station' })],
      { now: NOW },
    );
    await run([tx({ providerId: 'z', counterparty: 'Fuel Station' })]);
    const all = await database.db.select().from(transactions);
    expect(all).toHaveLength(2);
  });

  it('deletes pending rows older than 14 days that were not seen again, keeps fresh and seen ones', async () => {
    await run([
      tx({ providerId: 'old-unseen', status: 'pending', bookingDate: '2026-10-20' }),
      tx({
        providerId: 'old-seen',
        status: 'pending',
        bookingDate: '2026-10-21',
        counterparty: 'A',
      }),
      tx({ providerId: 'fresh', status: 'pending', bookingDate: '2026-11-08', counterparty: 'B' }),
      tx({
        providerId: 'old-booked',
        status: 'booked',
        bookingDate: '2026-10-01',
        counterparty: 'C',
      }),
    ]);
    // 'old-unseen' and 'fresh' are absent from the later fetch; 'old-seen' is returned again.
    const res = await run([
      tx({
        providerId: 'old-seen',
        status: 'pending',
        bookingDate: '2026-10-21',
        counterparty: 'A',
      }),
    ]);
    expect(res.deleted).toBe(1);
    const left = (await rows()).map((r) => r.bookingDate).sort();
    expect(left).toEqual(['2026-10-01', '2026-10-21', '2026-11-08']);
  });
});

describe('runSync wiring', () => {
  const registry = createConnectorRegistry([createFakeConnector()]);
  const baseTx = (id: string, date: string): FakeTx => ({
    providerId: id,
    status: 'booked',
    bookingDate: date,
    amountMinor: '-100',
    currency: 'EUR',
    counterparty: 'Shop',
  });

  it('calls onIngested once per run with inserted and updated ids, and uses a 7-day overlap cursor', async () => {
    const seeded = await seedFakeConnector(database.db, keyring, householdId, memberId, {
      accountRef: 'fake-9',
      transactions: [baseTx('t1', '2026-11-01'), baseTx('t2', '2026-11-04')],
    });
    const onIngested = vi.fn<SyncDeps['onIngested']>(async () => {});
    const deps: SyncDeps = {
      db: database.db,
      keyring,
      registry,
      logger: createLogger({ level: 'silent' }),
      now: () => NOW,
      onIngested,
    };
    const spy = vi.spyOn(registry.get('fake'), 'fetchTransactions');
    spy.mockClear();
    await runSync(deps, seeded.connectorId, 'user');
    expect(onIngested).toHaveBeenCalledTimes(1);
    const calls = onIngested.mock.calls as unknown as [string, string[]][];
    const [hh, ids] = calls[0] ?? ['', []];
    expect(hh).toBe(householdId);
    expect(ids).toHaveLength(2);
    expect(spy.mock.calls[0]?.[2]).toBeNull();

    await runSync(deps, seeded.connectorId, 'user');
    expect(spy.mock.calls[1]?.[2]?.toISOString().slice(0, 10)).toBe('2026-10-28');
    expect(onIngested).toHaveBeenCalledTimes(2);
    expect(calls[1]?.[1]).toEqual([]);
    spy.mockRestore();
    expect(connectorId).toBeTruthy();
  });
});
