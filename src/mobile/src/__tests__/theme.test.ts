import { Appearance } from 'react-native';

import { createThemeStore, resolveScheme, type ThemePrefsStorage } from '../theme-store';

function memoryPrefs() {
  const data = new Map<string, string>();
  const prefs: ThemePrefsStorage = {
    getString: (k) => data.get(k),
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
  return { data, prefs };
}

describe('theme preference store', () => {
  let setScheme: jest.SpyInstance;
  beforeEach(() => {
    setScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('defaults to System', () => {
    expect(createThemeStore(memoryPrefs().prefs).getPreference()).toBe('system');
  });

  it('persists the choice and restores it on a fresh store', () => {
    const { prefs, data } = memoryPrefs();
    const first = createThemeStore(prefs);
    first.setPreference('dark');
    expect(data.get('themePreference')).toBe('dark');
    expect(createThemeStore(prefs).getPreference()).toBe('dark');
    first.setPreference('light');
    expect(createThemeStore(prefs).getPreference()).toBe('light');
    first.setPreference('system');
    expect(data.has('themePreference')).toBe(false);
    expect(createThemeStore(prefs).getPreference()).toBe('system');
  });

  it('ignores an invalid stored value', () => {
    const { prefs, data } = memoryPrefs();
    data.set('themePreference', 'neon');
    expect(createThemeStore(prefs).getPreference()).toBe('system');
  });

  it('notifies subscribers and tells native which scheme to use', () => {
    const store = createThemeStore(memoryPrefs().prefs);
    const listener = jest.fn();
    const off = store.subscribe(listener);
    store.setPreference('dark');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(setScheme).toHaveBeenLastCalledWith('dark');
    store.setPreference('light');
    expect(setScheme).toHaveBeenLastCalledWith('light');
    store.setPreference('system');
    expect(setScheme).toHaveBeenLastCalledWith('auto');
    off();
    store.setPreference('dark');
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('resolveScheme', () => {
  it('follows the system for System', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
  });
  it('lets Light and Dark override the system', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });
});
