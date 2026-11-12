import type { SessionInfo } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert, Appearance, Text, type AlertButton } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import {
  createSessionStore,
  type PrefsStorage,
  type SessionStore,
} from '../../session/session-store';
import { useAppTheme } from '../../theme';
import { createThemeStore, setThemeStore } from '../../theme-store';
import { MoreScreen } from '../../more/MoreScreen';
import { AppearanceScreen } from '../AppearanceScreen';
import { DevicesScreen } from '../DevicesScreen';
import { SecurityScreen } from '../SecurityScreen';
import { ServerScreen } from '../ServerScreen';
import { SettingsScreen } from '../SettingsScreen';

const mockRouter = { push: jest.fn() };
const mockApi = { listSessions: jest.fn(), revokeSession: jest.fn() };
let mockStore: SessionStore;
const mockAuth = jest.fn();

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('../../session/instance', () => ({
  getSessionStore: () => mockStore,
  createSessionApiClient: () => mockApi,
}));
jest.mock('../../security/device-auth', () => ({
  authenticateDevice: (m: string) => mockAuth(m) as unknown,
}));
jest.mock('../../notifications/useNotificationPermission', () => ({
  useNotificationPermission: () => ({ status: 'granted', request: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's-current',
  deviceName: 'Pixel 9',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastSeenAt: new Date().toISOString(),
  current: true,
  ...over,
});
const other = session({ id: 's-tablet', deviceName: 'Old tablet', current: false });

let secret: string | null;
let prefsData: Map<string, string>;
const wipeHook = jest.fn();

function makeStore() {
  prefsData = new Map([['serverUrl', 'https://budget.example.test']]);
  secret = 'tok';
  const prefs: PrefsStorage = {
    getString: (k) => prefsData.get(k),
    set: (k, v) => void prefsData.set(k, v),
    remove: (k) => void prefsData.delete(k),
  };
  return createSessionStore({
    prefs,
    token: {
      get: async () => secret,
      set: async (t) => void (secret = t),
      remove: async () => void (secret = null),
    },
  });
}

let queryClient: QueryClient;
async function renderSettings(ui: ReactElement = <SettingsScreen />) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <PaperProvider>{ui}</PaperProvider>
    </QueryClientProvider>,
  );
}

/** Presses the button with the given label of the last Alert. */
async function confirmAlert(label: string) {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] as AlertButton[];
  const button = buttons.find((b) => b.text === label);
  await act(async () => {
    button?.onPress?.();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore = makeStore();
  mockStore.onSignOut(wipeHook);
  mockApi.listSessions.mockResolvedValue({ sessions: [session(), other] });
  mockApi.revokeSession.mockResolvedValue(undefined);
  mockAuth.mockResolvedValue('success');
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('SettingsScreen', () => {
  it('shows the server URL', async () => {
    await renderSettings(<ServerScreen />);
    expect(screen.getByText('https://budget.example.test')).toBeTruthy();
  });

  it('lists the devices, marking this one', async () => {
    await renderSettings(<DevicesScreen />);
    expect(await screen.findByText('Pixel 9 (this device)')).toBeTruthy();
    expect(screen.getByText('Old tablet')).toBeTruthy();
    expect(screen.queryByTestId('settings-revoke-s-current')).toBeNull();
    expect(screen.getByTestId('settings-revoke-s-tablet')).toBeTruthy();
  });

  it('revokes another device after confirmation and reloads the list', async () => {
    await renderSettings(<DevicesScreen />);
    await screen.findByText('Old tablet');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-revoke-s-tablet'));
    });
    expect(mockApi.revokeSession).not.toHaveBeenCalled();
    await confirmAlert('Sign out device');
    await waitFor(() => expect(mockApi.revokeSession).toHaveBeenCalledWith('s-tablet'));
    await waitFor(() => expect(mockApi.listSessions).toHaveBeenCalledTimes(2));
  });

  it('sign-out revokes the current session on the server, then wipes token and caches', async () => {
    await renderSettings();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-signout'));
    });
    expect(mockApi.revokeSession).not.toHaveBeenCalled();
    await confirmAlert('Sign out');
    await waitFor(() => expect(mockStore.getSnapshot().status).toBe('signed_out'));
    expect(mockApi.revokeSession).toHaveBeenCalledTimes(1);
    expect(mockApi.revokeSession).toHaveBeenCalledWith('s-current');
    expect(secret).toBeNull();
    expect(wipeHook).toHaveBeenCalledTimes(1);
    expect(mockStore.getSnapshot().expired).toBe(false);
  });

  it('sign-out still wipes locally when the server cannot be reached', async () => {
    mockApi.revokeSession.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderSettings();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-signout'));
    });
    await confirmAlert('Sign out');
    await waitFor(() => expect(mockStore.getSnapshot().status).toBe('signed_out'));
    expect(secret).toBeNull();
    expect(wipeHook).toHaveBeenCalled();
  });

  it('sign-out works when the devices list never loaded', async () => {
    mockApi.listSessions.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderSettings();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-signout'));
    });
    await confirmAlert('Sign out');
    await waitFor(() => expect(mockStore.getSnapshot().status).toBe('signed_out'));
    expect(mockApi.revokeSession).not.toHaveBeenCalled();
    expect(secret).toBeNull();
  });

  it('turning the lock off needs authentication and is stored in prefs', async () => {
    await renderSettings(<SecurityScreen />);
    await act(async () => {
      await fireEvent(screen.getByTestId('settings-lock'), 'valueChange', false);
    });
    expect(mockAuth).toHaveBeenCalled();
    expect(mockStore.getSnapshot().lockEnabled).toBe(false);
    expect(prefsData.get('lockDisabled')).toBe('1');
    await act(async () => {
      await fireEvent(screen.getByTestId('settings-lock'), 'valueChange', true);
    });
    expect(mockStore.getSnapshot().lockEnabled).toBe(true);
  });

  it('keeps the lock on when authentication fails', async () => {
    mockAuth.mockResolvedValue('failed');
    await renderSettings(<SecurityScreen />);
    await act(async () => {
      await fireEvent(screen.getByTestId('settings-lock'), 'valueChange', false);
    });
    expect(mockStore.getSnapshot().lockEnabled).toBe(true);
  });

  it('links to the settings sub-screens', async () => {
    await renderSettings();
    for (const [id, href] of [
      ['settings-accounts', '/more/settings/accounts'],
      ['settings-appearance', '/more/settings/appearance'],
      ['settings-security', '/more/settings/security'],
      ['settings-devices', '/more/settings/devices'],
      ['settings-server-entry', '/more/settings/server'],
    ] as const) {
      await act(async () => {
        await fireEvent.press(screen.getByTestId(id));
      });
      expect(mockRouter.push).toHaveBeenLastCalledWith(href);
    }
  });
});

describe('Appearance setting', () => {
  function Probe() {
    return <Text testID="theme-probe">{useAppTheme().dark ? 'dark' : 'light'}</Text>;
  }

  it('changes the stored preference and the theme in use immediately', async () => {
    jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('light');
    const prefs = new Map<string, string>();
    const themeStore = createThemeStore({
      getString: (k) => prefs.get(k),
      set: (k, v) => void prefs.set(k, v),
      remove: (k) => void prefs.delete(k),
    });
    setThemeStore(themeStore);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <PaperProvider>
          <Probe />
          <AppearanceScreen />
        </PaperProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('theme-probe').props.children).toBe('light');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-theme-dark'));
    });
    expect(themeStore.getPreference()).toBe('dark');
    expect(prefs.get('themePreference')).toBe('dark');
    expect(screen.getByTestId('theme-probe').props.children).toBe('dark');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-theme-system'));
    });
    expect(themeStore.getPreference()).toBe('system');
    expect(screen.getByTestId('theme-probe').props.children).toBe('light');
    setThemeStore(undefined);
  });
});

describe('More tab navigation', () => {
  it('leads from More to Settings to Appearance', async () => {
    await renderSettings(<MoreScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('more-settings'));
    });
    expect(mockRouter.push).toHaveBeenLastCalledWith('/more/settings');
    screen.unmount();
    await renderSettings(<SettingsScreen />);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('settings-appearance'));
    });
    expect(mockRouter.push).toHaveBeenLastCalledWith('/more/settings/appearance');
  });
});
