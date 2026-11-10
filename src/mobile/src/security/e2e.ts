import Constants from 'expo-constants';

/**
 * Dev-only E2E switch: true only when the build is the development variant (`allowCleartext`, the same
 * flag that permits cleartext HTTP) AND it was prebuilt with `BUDGEDINO_E2E=1` (`extra.e2e`). Release
 * builds are never the development variant, so they ignore `extra.e2e` even if it were set.
 */
export function e2eLockBypass(extra: Record<string, unknown> | undefined): boolean {
  return extra?.['allowCleartext'] === true && extra['e2e'] === true;
}

/** The switch for the running build. */
export function isE2eLockBypass(): boolean {
  return e2eLockBypass(Constants.expoConfig?.extra);
}
