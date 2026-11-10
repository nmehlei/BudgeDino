import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';
import * as mockScreenCapture from 'expo-screen-capture';
import { PaperProvider } from 'react-native-paper';

import {
  createSessionStore,
  type PrefsStorage,
  type SessionStore,
} from '../../session/session-store';
import { AppLock } from '../AppLock';
import type { DeviceAuthResult } from '../device-auth';
import { useScreenProtection } from '../useScreenProtection';

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(),
  allowScreenCaptureAsync: jest.fn(),
}));
jest.mock('expo-local-authentication', () => ({}));

function makeStore(opts: { signedInHere?: boolean; prefs?: Record<string, string> } = {}) {
  const prefs = new Map<string, string>(Object.entries(opts.prefs ?? {}));
  const prefsStorage: PrefsStorage = {
    getString: (k) => prefs.get(k),
    set: (k, v) => void prefs.set(k, v),
    remove: (k) => void prefs.delete(k),
  };
  const store = createSessionStore({
    prefs: prefsStorage,
    token: { get: async () => 'tok', set: async () => undefined, remove: async () => undefined },
  });
  return { store, prefs, signIn: () => store.signIn('tok') };
}

let appStateHandler: ((s: AppStateStatus) => void) | null = null;
const setAppState = (s: AppStateStatus) => act(() => appStateHandler?.(s));
const flush = () => act(async () => undefined);

async function renderLock(store: SessionStore, authenticate: jest.Mock) {
  await render(
    <PaperProvider>
      <AppLock store={store} authenticate={authenticate}>
        <Text>secret content</Text>
      </AppLock>
    </PaperProvider>,
  );
  await flush();
}

const auth = (...results: DeviceAuthResult[]) => {
  const fn = jest.fn();
  results.forEach((r) => fn.mockResolvedValueOnce(r));
  fn.mockResolvedValue(results[results.length - 1] ?? 'success');
  return fn;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  appStateHandler = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, handler) => {
    appStateHandler = handler as (s: AppStateStatus) => void;
    return { remove: jest.fn() } as never;
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('AppLock', () => {
  it('keeps children hidden until authentication succeeds', async () => {
    let resolve: (r: DeviceAuthResult) => void = () => undefined;
    const authenticate = jest.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    await renderLock(makeStore().store, authenticate);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('app-lock')).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
    await act(async () => resolve('success'));
    expect(screen.getByText('secret content')).toBeTruthy();
    expect(screen.queryByTestId('app-lock')).toBeNull();
  });

  it('stays locked on failure and unlocks via the retry button', async () => {
    const authenticate = auth('failed', 'success');
    await renderLock(makeStore().store, authenticate);
    expect(screen.getByTestId('app-lock')).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('app-lock-unlock'));
    });
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('secret content')).toBeTruthy();
  });

  it('re-locks after more than 60 s in the background', async () => {
    const authenticate = auth('success', 'failed');
    await renderLock(makeStore().store, authenticate);
    expect(screen.getByText('secret content')).toBeTruthy();

    await setAppState('background');
    await act(() => jest.advanceTimersByTimeAsync(61_000));
    await setAppState('active');
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('app-lock')).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
  });

  it('does not re-lock after a short background stay', async () => {
    const authenticate = auth('success');
    await renderLock(makeStore().store, authenticate);
    await setAppState('background');
    await act(() => jest.advanceTimersByTimeAsync(59_000));
    await setAppState('active');
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('secret content')).toBeTruthy();
    expect(screen.queryByTestId('app-lock')).toBeNull();
  });

  it('does not prompt when the lock is disabled', async () => {
    const authenticate = auth('success');
    await renderLock(makeStore({ prefs: { lockDisabled: '1' } }).store, authenticate);
    expect(authenticate).not.toHaveBeenCalled();
    expect(screen.getByText('secret content')).toBeTruthy();
    await setAppState('background');
    await act(() => jest.advanceTimersByTimeAsync(120_000));
    await setAppState('active');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('does not prompt right after a password sign-in in this process', async () => {
    const { store, signIn } = makeStore();
    await signIn();
    const authenticate = auth('success');
    await renderLock(store, authenticate);
    expect(authenticate).not.toHaveBeenCalled();
    expect(screen.getByText('secret content')).toBeTruthy();
  });

  it('lets the user in with a one-time notice when the device has no screen lock', async () => {
    const { store, prefs } = makeStore();
    const authenticate = auth('unavailable');
    await renderLock(store, authenticate);
    expect(screen.getByTestId('app-lock-notice')).toBeTruthy();
    expect(screen.getByText(/needs a screen lock/)).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('app-lock-continue'));
    });
    expect(screen.getByText('secret content')).toBeTruthy();
    expect(prefs.get('lockNoticeSeen')).toBe('1');
  });

  it('shows the no-screen-lock notice only once', async () => {
    const { store } = makeStore({ prefs: { lockNoticeSeen: '1' } });
    await renderLock(store, auth('unavailable'));
    expect(screen.queryByTestId('app-lock-notice')).toBeNull();
    expect(screen.getByText('secret content')).toBeTruthy();
  });
});

describe('useScreenProtection', () => {
  it('prevents capture while mounted and allows it again on unmount', async () => {
    jest.mocked(mockScreenCapture.preventScreenCaptureAsync).mockResolvedValue(undefined);
    jest.mocked(mockScreenCapture.allowScreenCaptureAsync).mockResolvedValue(undefined);
    const { unmount } = await renderHook(() => useScreenProtection());
    expect(mockScreenCapture.preventScreenCaptureAsync).toHaveBeenCalledTimes(1);
    expect(mockScreenCapture.allowScreenCaptureAsync).not.toHaveBeenCalled();
    await unmount();
    expect(mockScreenCapture.allowScreenCaptureAsync).toHaveBeenCalledTimes(1);
  });
});
