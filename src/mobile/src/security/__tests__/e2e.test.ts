import { e2eLockBypass } from '../e2e';

const globals = globalThis as unknown as { __DEV__: boolean };
const originalDev = globals.__DEV__;
afterEach(() => {
  globals.__DEV__ = originalDev;
});

describe('e2eLockBypass', () => {
  it('is never on in a release bundle (__DEV__ false), whatever the config says', () => {
    globals.__DEV__ = false;
    expect(e2eLockBypass({ allowCleartext: true, e2e: true })).toBe(false);
  });

  it('is on only for the development variant started with BUDGEDINO_E2E=1', () => {
    globals.__DEV__ = true;
    expect(e2eLockBypass({ allowCleartext: true, e2e: true })).toBe(true);
  });

  it('is ignored when the build is not the development variant', () => {
    expect(e2eLockBypass({ allowCleartext: false, e2e: true })).toBe(false);
    expect(e2eLockBypass({ e2e: true })).toBe(false);
  });

  it('is off without the e2e flag or any config', () => {
    expect(e2eLockBypass({ allowCleartext: true })).toBe(false);
    expect(e2eLockBypass({ allowCleartext: true, e2e: 'true' })).toBe(false);
    expect(e2eLockBypass(undefined)).toBe(false);
  });
});
