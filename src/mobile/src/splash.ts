import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

/** Never keep the native splash longer than this, whatever happens during start-up. */
export const SPLASH_MAX_MS = 5000;

let hidden = false;

/** Called once at module load of the root layout: the native splash stays until the app is ready. */
export function keepSplashUntilReady(): void {
  try {
    SplashScreen.setOptions({ duration: 250, fade: true });
  } catch {
    // a native module without options: the default animation is fine
  }
  SplashScreen.preventAutoHideAsync().catch(() => undefined);
  setTimeout(hideSplash, SPLASH_MAX_MS);
}

export function hideSplash(): void {
  if (hidden) return;
  hidden = true;
  SplashScreen.hideAsync().catch(() => undefined);
}

/** Hides the splash the first time `ready` is true (cache opened and session hydrated). */
export function useHideSplashWhen(ready: boolean): void {
  useEffect(() => {
    if (ready) hideSplash();
  }, [ready]);
}
