import { e2eLockBypass } from '../e2e';

describe('e2eLockBypass', () => {
  it('is on only for the development variant built with BUDGEDINO_E2E=1', () => {
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
