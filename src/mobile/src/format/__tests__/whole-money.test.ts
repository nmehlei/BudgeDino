import { formatWholeMoney } from '../whole-money';

describe('formatWholeMoney', () => {
  it('drops the decimals of a two-decimal currency', () => {
    expect(formatWholeMoney(123_456n, 'EUR')).toMatch(/^1\.234\s€$/);
    expect(formatWholeMoney(0n, 'EUR')).toMatch(/^0\s€$/);
    expect(formatWholeMoney(-5_000n, 'EUR')).toMatch(/^-50\s€$/);
  });

  it('keeps zero-decimal currencies as they are', () => {
    expect(formatWholeMoney(1_500n, 'JPY')).toMatch(/^1\.500\s¥$/);
  });
});
