import { currencyExponent } from '@budgedino/shared';

describe('@budgedino/shared resolution', () => {
  it('imports money helpers from the workspace source', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
  });
});
