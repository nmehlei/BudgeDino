import { describe, expect, it } from 'vitest';
import { listTransactionsQuery } from '@budgedino/shared';

const id = '123e4567-e89b-42d3-a456-426614174000';

describe('listTransactionsQuery', () => {
  it('trims q and bounds it to 2-64 characters', () => {
    expect(listTransactionsQuery.parse({ q: '  mü  ' }).q).toBe('mü');
    expect(listTransactionsQuery.safeParse({ q: ' a ' }).success).toBe(false);
    expect(listTransactionsQuery.safeParse({ q: 'a'.repeat(65) }).success).toBe(false);
  });

  it('accepts uncategorized true/1 but not together with categoryId', () => {
    expect(listTransactionsQuery.parse({ uncategorized: '1' }).uncategorized).toBe(true);
    expect(listTransactionsQuery.parse({ uncategorized: 'true' }).uncategorized).toBe(true);
    expect(listTransactionsQuery.safeParse({ uncategorized: 'false' }).success).toBe(false);
    expect(listTransactionsQuery.safeParse({ uncategorized: 'true', categoryId: id }).success).toBe(
      false,
    );
  });
});
