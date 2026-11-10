import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useEffect } from 'react';

const KEY = 'budgedino-authenticated';

/**
 * Blocks screenshots and blanks the recents thumbnail (FLAG_SECURE) while mounted. Mount it only
 * under authenticated screens; unmounting (sign-out) lifts the protection for the login screens.
 */
export function useScreenProtection(): void {
  useEffect(() => {
    void preventScreenCaptureAsync(KEY).catch(() => undefined);
    return () => {
      void allowScreenCaptureAsync(KEY).catch(() => undefined);
    };
  }, []);
}
