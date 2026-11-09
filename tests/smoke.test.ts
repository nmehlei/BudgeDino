import { describe, expect, it } from 'vitest';
import { VERSION } from '@budgedino/shared';

describe('workspace smoke test', () => {
  it('exposes a non-empty VERSION from @budgedino/shared', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
