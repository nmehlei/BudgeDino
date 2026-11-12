import * as LocalAuthentication from 'expo-local-authentication';

import { authenticateDevice } from '../device-auth';

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));

const level = jest.mocked(LocalAuthentication.getEnrolledLevelAsync);
const authenticate = jest.mocked(LocalAuthentication.authenticateAsync);

beforeEach(() => jest.resetAllMocks());

describe('authenticateDevice', () => {
  it('is unavailable (and never prompts) without any biometric or screen lock', async () => {
    level.mockResolvedValue(0);
    await expect(authenticateDevice('Unlock')).resolves.toBe('unavailable');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('prompts with the device credential fallback enabled', async () => {
    level.mockResolvedValue(1); // PIN only: still authenticable
    authenticate.mockResolvedValue({ success: true });
    await expect(authenticateDevice('Unlock')).resolves.toBe('success');
    expect(authenticate).toHaveBeenCalledWith({
      promptMessage: 'Unlock',
      disableDeviceFallback: false,
    });
  });

  it('reports a cancelled or failed prompt as failed', async () => {
    level.mockResolvedValue(3);
    authenticate.mockResolvedValue({ success: false, error: 'user_cancel' });
    await expect(authenticateDevice('Unlock')).resolves.toBe('failed');
  });

  it('treats a throwing native module as failed (stays locked)', async () => {
    level.mockRejectedValue(new Error('native'));
    await expect(authenticateDevice('Unlock')).resolves.toBe('failed');
  });
});
