import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useEffect } from 'react';

import { isE2eLockBypass } from './e2e';

const DEFAULT_KEY = 'budgedino-authenticated';

/**
 * Blocks screenshots and blanks the recents thumbnail (FLAG_SECURE) while mounted. Mount it only
 * under authenticated screens; unmounting (sign-out) lifts the protection for the login screens.
 * The dev-only E2E build (development variant, `__DEV__`, `BUDGEDINO_E2E=1`) skips it, like the app
 * lock, so screenshots of the UI can be reviewed; release and normal dev builds are always protected.
 */
export function useScreenProtection(
  key: string = DEFAULT_KEY,
  /** Test seam; the app uses the running build's switch. */
  e2eBypass: boolean = isE2eLockBypass(),
): void {
  useEffect(() => {
    if (e2eBypass) return;
    void preventScreenCaptureAsync(key).catch(() => undefined);
    return () => {
      void allowScreenCaptureAsync(key).catch(() => undefined);
    };
  }, [key, e2eBypass]);
}
