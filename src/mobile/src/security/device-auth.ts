import * as LocalAuthentication from 'expo-local-authentication';

export type DeviceAuthResult = 'success' | 'failed' | 'unavailable';

/**
 * Biometric with the device credential (PIN, pattern, password) as fallback. `unavailable` means the
 * device has neither a biometric nor a screen lock enrolled, so nothing can be asked.
 * (`getEnrolledLevelAsync` rather than `hasHardwareAsync`/`isEnrolledAsync`: those only look at
 * biometrics and would wrongly wave through a PIN-only phone.)
 */
export async function authenticateDevice(promptMessage: string): Promise<DeviceAuthResult> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return 'unavailable';
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
    });
    return res.success ? 'success' : 'failed';
  } catch {
    return 'failed';
  }
}
