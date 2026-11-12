import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useSyncExternalStore } from 'react';

/** Never keep the native splash longer than this, whatever happens during start-up. */
export const SPLASH_MAX_MS = 5000;

let hidden = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once the native splash has been told to hide (the in-app overlay then takes over). */
export function useSplashHidden(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => hidden,
  );
}

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
  listeners.forEach((l) => l());
  SplashScreen.hideAsync().catch(() => undefined);
}

/** Hides the splash the first time `ready` is true (cache opened and session hydrated). */
export function useHideSplashWhen(ready: boolean): void {
  useEffect(() => {
    if (ready) hideSplash();
  }, [ready]);
}
