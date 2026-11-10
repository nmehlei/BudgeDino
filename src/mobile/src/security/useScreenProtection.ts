import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useEffect } from 'react';

const DEFAULT_KEY = 'budgedino-authenticated';

/**
 * Blocks screenshots and blanks the recents thumbnail (FLAG_SECURE) while mounted. Mount it only
 * under authenticated screens; unmounting (sign-out) lifts the protection for the login screens.
 */
export function useScreenProtection(key: string = DEFAULT_KEY): void {
  useEffect(() => {
    void preventScreenCaptureAsync(key).catch(() => undefined);
    return () => {
      void allowScreenCaptureAsync(key).catch(() => undefined);
    };
  }, [key]);
}
