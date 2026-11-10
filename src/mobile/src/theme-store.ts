import { Appearance } from 'react-native';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Subset of the MMKV `budgedino-prefs` store (same shape the session store uses). */
export interface ThemePrefsStorage {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

const THEME_KEY = 'themePreference';

function isPreference(v: string | undefined): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** system follows the OS scheme (anything but 'dark' counts as light). */
export function resolveScheme(
  preference: ThemePreference,
  system: string | null | undefined,
): ResolvedScheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return system === 'dark' ? 'dark' : 'light';
}

/**
 * Tells native (keyboard, dialogs, system UI) which scheme the app wants. RN 0.88 takes `'auto'`
 * (alias `'unspecified'`) to go back to following the system.
 */
export function applyNativeScheme(preference: ThemePreference): void {
  try {
    Appearance.setColorScheme(preference === 'system' ? 'auto' : preference);
  } catch {
    // native module unavailable (tests); the JS theme still follows the preference
  }
}

/** Small external store for the appearance preference; persisted in the non-secret prefs. */
export function createThemeStore(prefs?: ThemePrefsStorage) {
  let preference: ThemePreference = 'system';
  try {
    const stored = prefs?.getString(THEME_KEY);
    if (isPreference(stored)) preference = stored;
  } catch {
    // unreadable prefs: default to System
  }
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPreference: (): ThemePreference => preference,
    /** Pushes the stored preference to native; call once at app start. */
    applyNative: () => {
      applyNativeScheme(preference);
    },
    setPreference(next: ThemePreference) {
      preference = next;
      try {
        if (next === 'system') prefs?.remove(THEME_KEY);
        else prefs?.set(THEME_KEY, next);
      } catch {
        // keep the in-memory choice for this process
      }
      applyNativeScheme(next);
      listeners.forEach((l) => {
        l();
      });
    },
  };
}

export type ThemeStore = ReturnType<typeof createThemeStore>;

let instance: ThemeStore | undefined;

/** The app-wide store, on the same MMKV file as the lock preference. Memory-only if MMKV is unavailable. */
export function getThemeStore(): ThemeStore {
  if (!instance) {
    let prefs: ThemePrefsStorage | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: keeps native code out of module load
      const { createMMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
      prefs = createMMKV({ id: 'budgedino-prefs' }) as ThemePrefsStorage | undefined;
    } catch {
      prefs = undefined;
    }
    instance = createThemeStore(prefs);
    instance.applyNative();
  }
  return instance;
}

/** Test seam. */
export function setThemeStore(store: ThemeStore | undefined): void {
  instance = store;
}
