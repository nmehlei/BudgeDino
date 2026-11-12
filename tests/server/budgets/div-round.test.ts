import { describe, expect, it } from 'vitest';
import { divRound } from '@budgedino/server/budgets/service';

describe('divRound', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(3n, 2n)).toBe(2n);
    expect(divRound(-3n, 2n)).toBe(-2n);
  });

  it('rounds below half toward zero and exact quotients stay exact', () => {
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
    expect(divRound(6n, 3n)).toBe(2n);
    expect(divRound(-6n, 3n)).toBe(-2n);
    expect(divRound(0n, 5n)).toBe(0n);
  });
});
