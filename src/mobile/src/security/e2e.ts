import Constants from 'expo-constants';

/**
 * Dev-only E2E switch: true only in a `__DEV__` JS bundle of the development variant
 * (`allowCleartext`) started with `BUDGEDINO_E2E=1` (`extra.e2e`, read from the Metro env). A release
 * bundle is never `__DEV__`, so release builds ignore `extra.e2e` even if it were set.
 */
export function e2eLockBypass(extra: Record<string, unknown> | undefined): boolean {
  return __DEV__ && extra?.['allowCleartext'] === true && extra['e2e'] === true;
}

/** The switch for the running build. */
export function isE2eLockBypass(): boolean {
  return e2eLockBypass(Constants.expoConfig?.extra);
}
