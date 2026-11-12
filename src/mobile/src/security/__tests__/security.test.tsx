import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';
import * as mockScreenCapture from 'expo-screen-capture';
import { PaperProvider } from 'react-native-paper';

import {
  createSessionStore,
  type PrefsStorage,
  type SessionStore,
} from '../../session/session-store';
import { markSplashFinished } from '../../splash';
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

async function renderLock(
  store: SessionStore,
  authenticate: jest.Mock,
  e2eBypass?: boolean,
  /** `'signal'`: leave it to the real splash module. */
  splashFinished: boolean | 'signal' = true,
) {
  await render(
    <PaperProvider>
      <AppLock
        store={store}
        authenticate={authenticate}
        {...(splashFinished === 'signal' ? {} : { splashFinished })}
        {...(e2eBypass === undefined ? {} : { e2eBypass })}
      >
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

  it('skips the lock on a cold start and after a long background stay in an E2E build', async () => {
    const authenticate = auth('success');
    await renderLock(makeStore().store, authenticate, true);
    expect(authenticate).not.toHaveBeenCalled();
    expect(screen.getByText('secret content')).toBeTruthy();
    await setAppState('background');
    await act(() => jest.advanceTimersByTimeAsync(120_000));
    await setAppState('active');
    expect(authenticate).not.toHaveBeenCalled();
    expect(screen.getByText('secret content')).toBeTruthy();
  });

  it('still locks when the E2E bypass is off', async () => {
    const authenticate = auth('failed');
    await renderLock(makeStore().store, authenticate, false);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('secret content')).toBeNull();
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

describe('AppLock and the animated splash', () => {
  it('shows the lock screen at once but prompts only after the splash finished', async () => {
    const authenticate = auth('success');
    await renderLock(makeStore().store, authenticate, undefined, 'signal');
    // `splashFinished` left to the splash module's signal, which has not fired yet.
    expect(screen.getByTestId('app-lock')).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(authenticate).not.toHaveBeenCalled();
    await act(async () => markSplashFinished());
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('secret content')).toBeTruthy();
  });

  it('prompts at once when the splash was skipped or is already over', async () => {
    // markSplashFinished has fired in the test above (module state), as after a skipped splash.
    const authenticate = auth('failed');
    await renderLock(makeStore().store, authenticate, undefined, 'signal');
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('prompts once the injected signal flips, and only once', async () => {
    const store = makeStore().store;
    const authenticate = auth('failed');
    const tree = (splashFinished: boolean) => (
      <PaperProvider>
        <AppLock store={store} authenticate={authenticate} splashFinished={splashFinished}>
          <Text>secret content</Text>
        </AppLock>
      </PaperProvider>
    );
    const view = await render(tree(false));
    await flush();
    expect(authenticate).not.toHaveBeenCalled();
    await view.rerender(tree(true));
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(1);
    await view.rerender(tree(true));
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('app-lock')).toBeTruthy();
  });

  it('the Unlock button works before the splash finished and the deferred prompt does not repeat', async () => {
    const store = makeStore().store;
    const authenticate = auth('success');
    const tree = (splashFinished: boolean) => (
      <PaperProvider>
        <AppLock store={store} authenticate={authenticate} splashFinished={splashFinished}>
          <Text>secret content</Text>
        </AppLock>
      </PaperProvider>
    );
    const view = await render(tree(false));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('app-lock-unlock'));
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    await view.rerender(tree(true));
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('secret content')).toBeTruthy();
  });
});

describe('AppLock resume cover and edge cases', () => {
  it('covers the content immediately on background, without prompting', async () => {
    const authenticate = auth('success');
    await renderLock(makeStore().store, authenticate);
    await setAppState('background');
    expect(screen.getByTestId('app-lock-cover')).toBeTruthy();
    expect(authenticate).toHaveBeenCalledTimes(1);
    await setAppState('active');
    expect(screen.queryByTestId('app-lock-cover')).toBeNull();
    expect(screen.getByText('secret content')).toBeTruthy();
  });

  it('re-locks when the clock was set back while backgrounded', async () => {
    const authenticate = auth('success', 'failed');
    await renderLock(makeStore().store, authenticate);
    await setAppState('background');
    jest.setSystemTime(Date.now() - 5 * 60_000);
    await setAppState('active');
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('app-lock')).toBeTruthy();
  });

  it('backgrounding during a pending prompt neither relocks nor covers; cancel stays locked', async () => {
    let resolve: (r: DeviceAuthResult) => void = () => undefined;
    const authenticate = jest.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    await renderLock(makeStore().store, authenticate);
    await setAppState('background');
    await act(() => jest.advanceTimersByTimeAsync(120_000));
    await setAppState('active');
    await flush();
    expect(authenticate).toHaveBeenCalledTimes(1);
    await act(async () => resolve('failed'));
    expect(screen.getByTestId('app-lock')).toBeTruthy();
    expect(screen.queryByText('secret content')).toBeNull();
  });

  it('shows the no-screen-lock notice when a relock finds no screen lock', async () => {
    const authenticate = auth('success', 'unavailable');
    await renderLock(makeStore().store, authenticate);
    await setAppState('background');
    await act(() => jest.advanceTimersByTimeAsync(61_000));
    await setAppState('active');
    await flush();
    expect(screen.getByTestId('app-lock-notice')).toBeTruthy();
  });

  it('the lock screen offers Sign out, which revokes the session then wipes', async () => {
    const { store } = makeStore();
    const order: string[] = [];
    const revoke = jest.fn(async () => {
      order.push('revoke');
    });
    store.onSignOut(() => {
      order.push('wipe');
    });
    await render(
      <PaperProvider>
        <AppLock store={store} authenticate={auth('failed')} revoke={revoke}>
          <Text>secret content</Text>
        </AppLock>
      </PaperProvider>,
    );
    await flush();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('app-lock-signout'));
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['revoke', 'wipe']);
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('after sign-out and sign-in a fresh mount starts unlocked; a restored session starts locked', async () => {
    const { store, signIn } = makeStore();
    await store.signOut();
    await signIn();
    const authenticate = auth('success');
    const first = await render(
      <PaperProvider>
        <AppLock store={store} authenticate={authenticate}>
          <Text>secret content</Text>
        </AppLock>
      </PaperProvider>,
    );
    await flush();
    expect(authenticate).not.toHaveBeenCalled();
    expect(screen.getByText('secret content')).toBeTruthy();
    await first.unmount();

    await store.signOut();
    const restored = auth('failed');
    await renderLock(store, restored);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('app-lock')).toBeTruthy();
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
