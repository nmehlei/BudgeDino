import type { ConnectorInfo } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Appearance, PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { darkTheme, lightTheme } from '../../theme';
import { createThemeStore, setThemeStore } from '../../theme-store';
import { AddConnectionScreen } from '../AddConnectionScreen';
import { BankAvatar } from '../BankAvatar';
import { bankBrand, bankName } from '../banks';
import { challengeStore } from '../challenge-store';
import { ConnectionsScreen } from '../ConnectionsScreen';

// Paper's menus and dialogs render through a Portal asynchronously; allow for a loaded CI machine.
jest.setTimeout(20_000);

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockApi = {
  listConnectors: jest.fn(),
  listConnectorTypes: jest.fn(),
  createConnector: jest.fn(),
  syncConnector: jest.fn(),
  reconnectConnector: jest.fn(),
  renameConnector: jest.fn(),
  deleteConnector: jest.fn(),
  bankIconSource: jest.fn(),
};

// Paper's Menu mounts its items through a Portal after asynchronous native measuring, which is flaky under jest.
// This stand-in keeps the same contract (anchor always shown, items only while `visible`).
jest.mock('react-native-paper', () => {
  const actual = jest.requireActual<typeof import('react-native-paper')>('react-native-paper');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Menu = Object.assign(
    ({
      visible,
      anchor,
      children,
    }: {
      visible: boolean;
      anchor: React.ReactNode;
      children: React.ReactNode;
    }) => (
      <View>
        {anchor}
        {visible ? children : null}
      </View>
    ),
    { Item: actual.Menu.Item },
  );
  return { ...actual, Menu };
});
jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const own = (over: Partial<Extract<ConnectorInfo, { isOwner: true }>> = {}): ConnectorInfo => ({
  id: 'c1',
  type: 'fints',
  status: 'ok',
  isOwner: true,
  bank: 'dkb',
  displayName: null,
  experimental: false,
  lastSuccessAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastErrorCode: null,
  consentExpiresAt: null,
  ...over,
});
const other: ConnectorInfo = {
  id: 'c-other',
  type: 'fints',
  status: 'ok',
  isOwner: false,
  bank: 'dkb',
  lastSuccessAt: null,
};

const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

async function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>{ui}</PaperProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  challengeStore.clear();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listConnectorTypes.mockResolvedValue({ types: ['fints'] });
  mockApi.bankIconSource.mockResolvedValue(null);
});

const ICON = {
  uri: 'https://budget.example.test/api/v1/banks/dkb/icon',
  headers: { authorization: 'Bearer t' },
};

async function openMenu(id: string) {
  await fireEvent.press(await screen.findByTestId(`menu-${id}`));
  await screen.findByTestId(`rename-${id}`);
}

async function pressAct(testID: string) {
  await fireEvent.press(await screen.findByTestId(testID, {}, { timeout: 4000 }));
}

describe('ConnectionsScreen list', () => {
  it('lists own connectors first and others read-only, with title, status, last sync and consent', async () => {
    mockApi.listConnectors.mockResolvedValue({
      connectors: [
        own({ displayName: 'Anna private' }),
        own({
          id: 'c2',
          bank: 'comdirect',
          status: 'needs_attention',
          consentExpiresAt: '2027-01-15T00:00:00.000Z',
        }),
        own({ id: 'c3', bank: 'fake', type: 'fake' }),
        other,
      ],
    });
    await renderWithProviders(<ConnectionsScreen />);
    expect(await screen.findByText('Anna private')).toBeTruthy();
    expect(screen.getByText('Comdirect')).toBeTruthy();
    expect(screen.getByText('Demo bank')).toBeTruthy();
    expect(screen.getAllByText(/Connected · Last sync 5 min ago/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Needs attention · Last sync 5 min ago/)).toBeTruthy();
    expect(screen.getByText(/Consent valid until 15\.01\.2027/)).toBeTruthy();
    expect(screen.getByText('Shared by others')).toBeTruthy();
    expect(screen.getByText(/Shared by another member/)).toBeTruthy();
    // the other member's row shows the bank and a status, but has no menu
    expect(screen.getByTestId('connector-c-other')).toBeTruthy();
    expect(screen.getByTestId('connector-status-c-other')).toBeTruthy();
    expect(screen.queryByTestId('menu-c-other')).toBeNull();
    expect(screen.getByTestId('menu-c1')).toBeTruthy();
    expect(screen.getByLabelText('Needs attention')).toBeTruthy();
  });

  it('shows an empty hint', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [] });
    await renderWithProviders(<ConnectionsScreen />);
    expect(await screen.findByText('No bank connected yet.')).toBeTruthy();
  });

  it('refetches on pull-to-refresh', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own()] });
    await renderWithProviders(<ConnectionsScreen />);
    await screen.findByTestId('connector-c1');
    mockApi.listConnectors.mockClear();
    await act(async () => {
      (
        screen.getByTestId('connections-scroll').props.refreshControl as {
          props: { onRefresh: () => void };
        }
      ).props.onRefresh();
    });
    expect(mockApi.listConnectors).toHaveBeenCalledTimes(1);
  });

  // Structural proxy only: jest cannot lay text out, so this checks that nothing truncates and that the
  // screen scrolls. Real layout needs a device.
  it('stays usable at font scale 2: scrollable rows that wrap, no truncation', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    mockApi.listConnectors.mockResolvedValue({
      connectors: [own({ displayName: 'A very long connection name that has to wrap' })],
    });
    await renderWithProviders(<ConnectionsScreen />);
    const title = await screen.findByText(/A very long connection name/);
    expect(title.props.numberOfLines).toBe(0);
    expect(screen.getByText(/Connected · Last sync/).props.numberOfLines).toBe(0);
    expect(screen.getByTestId('connections-scroll')).toBeTruthy();
    jest.restoreAllMocks();
  });
});

describe('bank avatar fallback chain', () => {
  it('uses the server icon with the auth header', async () => {
    mockApi.bankIconSource.mockResolvedValue(ICON);
    await renderWithProviders(<BankAvatar bank="dkb" />);
    const image = await screen.findByTestId('bank-avatar-image-dkb');
    expect(image.props.source).toEqual(ICON);
    expect(mockApi.bankIconSource).toHaveBeenCalledWith('dkb');
    expect(screen.queryByTestId('bank-avatar-monogram-dkb')).toBeNull();
  });

  it('falls back to a brand-coloured monogram when the image fails to load', async () => {
    mockApi.bankIconSource.mockResolvedValue(ICON);
    await renderWithProviders(<BankAvatar bank="comdirect" />);
    await screen.findByTestId('bank-avatar-image-comdirect');
    await act(async () => {
      fireEvent(screen.getByTestId('bank-avatar-image-comdirect'), 'error');
    });
    expect(screen.queryByTestId('bank-avatar-image-comdirect')).toBeNull();
    const monogram = screen.getByTestId('bank-avatar-monogram-comdirect');
    expect(screen.getByText('CD')).toBeTruthy();
    expect(JSON.stringify(monogram.props.style)).toContain('#FFD500');
  });

  it('falls back to the monogram when there is no icon source or the request fails', async () => {
    mockApi.bankIconSource.mockResolvedValue(null);
    await renderWithProviders(<BankAvatar bank="dkb" />);
    expect(await screen.findByText('DKB')).toBeTruthy();
    expect(screen.queryByTestId('bank-avatar-image-dkb')).toBeNull();

    mockApi.bankIconSource.mockRejectedValue(new Error('boom'));
    await renderWithProviders(<BankAvatar bank="fake" />);
    expect(await screen.findByTestId('bank-avatar-monogram-fake')).toBeTruthy();
    expect(screen.getByText('DB')).toBeTruthy();
  });

  it('uses the generic bank icon when there is no name to take initials from', async () => {
    mockApi.bankIconSource.mockResolvedValue(null);
    await renderWithProviders(<BankAvatar bank="-" />);
    expect(await screen.findByTestId('bank-avatar-icon--')).toBeTruthy();
  });

  it('names banks and derives initials for banks the app does not know', () => {
    expect(bankBrand('mybank').initials).toBe('MY');
    expect(bankName('dkb')).toBe('DKB');
    expect(bankName('fake')).toBe('Demo bank');
    expect(bankName('fints')).toBe('Bank (FinTS)');
    expect(bankName('constructor')).toBe('constructor');
  });
});

describe('connection menu', () => {
  const offered = async (status: ConnectorInfo['status']) => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own({ status })] });
    await renderWithProviders(<ConnectionsScreen />);
    await openMenu('c1');
    return {
      sync: screen.queryByTestId('sync-c1') !== null,
      reconnect: screen.queryByTestId('reconnect-c1') !== null,
      rename: screen.queryByTestId('rename-c1') !== null,
      delete: screen.queryByTestId('delete-c1') !== null,
    };
  };

  it('ok: sync, rename, delete', async () => {
    expect(await offered('ok')).toEqual({
      sync: true,
      reconnect: false,
      rename: true,
      delete: true,
    });
  });
  it('needs_attention: reconnect, rename, delete', async () => {
    expect(await offered('needs_attention')).toEqual({
      sync: false,
      reconnect: true,
      rename: true,
      delete: true,
    });
  });
  it('error: sync, reconnect, rename, delete', async () => {
    expect(await offered('error')).toEqual({
      sync: true,
      reconnect: true,
      rename: true,
      delete: true,
    });
  });
  it('disabled: only rename and delete', async () => {
    expect(await offered('disabled')).toEqual({
      sync: false,
      reconnect: false,
      rename: true,
      delete: true,
    });
  });

  it('sync now starts a user-present sync', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own()] });
    mockApi.syncConnector.mockResolvedValue({ runId: 'r1' });
    await renderWithProviders(<ConnectionsScreen />);
    await openMenu('c1');
    await pressAct('sync-c1');
    expect(mockApi.syncConnector).toHaveBeenCalledWith('c1');
    expect(await screen.findByText('Sync started')).toBeTruthy();
  });

  it('reconnect opens the returned challenge', async () => {
    mockApi.listConnectors.mockResolvedValue({
      connectors: [own({ status: 'needs_attention' })],
    });
    mockApi.reconnectConnector.mockResolvedValue({
      challenge: {
        kind: 'decoupled',
        id: 'ch9',
        message: 'm',
        pollAfterMs: 3000,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await renderWithProviders(<ConnectionsScreen />);
    await openMenu('c1');
    await pressAct('reconnect-c1');
    expect(mockApi.reconnectConnector).toHaveBeenCalledWith('c1');
    expect(mockRouter.push).toHaveBeenCalledWith('/connections/challenge/ch9');
    expect(challengeStore.get('ch9')?.connectorId).toBe('c1');
  });

  it('shows the rate limit when a sync is refused', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own()] });
    mockApi.syncConnector.mockRejectedValue(
      new ApiClientError({ kind: 'rate_limited', retryAfterSec: 42 }),
    );
    await renderWithProviders(<ConnectionsScreen />);
    await openMenu('c1');
    await pressAct('sync-c1');
    expect(await screen.findByText('Too many requests, try again in 42 s.')).toBeTruthy();
  });
});

describe('rename dialog', () => {
  it('is prefilled and sends the trimmed name, then refetches', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own({ displayName: 'Old' })] });
    mockApi.renameConnector.mockResolvedValue(own({ displayName: 'New name' }));
    const client = await renderWithProviders(<ConnectionsScreen />);
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await openMenu('c1');
    await pressAct('rename-c1');
    const input = await screen.findByTestId('rename-input');
    expect(input.props.value).toBe('Old');
    expect(input.props.maxLength).toBe(60);
    await fireEvent.changeText(input, '  New name ');
    await pressAct('rename-save');
    expect(mockApi.renameConnector).toHaveBeenCalledWith('c1', 'New name');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['connectors'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home'] });
    expect(screen.queryByTestId('rename-dialog')).toBeNull();
  });

  it('an empty name clears it, cancel sends nothing, failures show a message', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own({ displayName: 'Old' })] });
    mockApi.renameConnector.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderWithProviders(<ConnectionsScreen />);
    await openMenu('c1');
    await pressAct('rename-c1');
    await pressAct('rename-cancel');
    expect(mockApi.renameConnector).not.toHaveBeenCalled();

    await openMenu('c1');
    await pressAct('rename-c1');
    await fireEvent.changeText(await screen.findByTestId('rename-input'), '   ');
    await pressAct('rename-save');
    expect(mockApi.renameConnector).toHaveBeenCalledWith('c1', null);
    expect(await screen.findByText('No connection. Try again when you are online.')).toBeTruthy();
  });
});

describe('delete dialog', () => {
  async function openDelete() {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own({ displayName: 'Anna DKB' })] });
    mockApi.deleteConnector.mockResolvedValue(undefined);
    const client = await renderWithProviders(<ConnectionsScreen />);
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await openMenu('c1');
    await pressAct('delete-c1');
    return invalidate;
  }
  const refreshed = (invalidate: jest.SpyInstance) =>
    invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

  it('keep: sends mode keep right away and refreshes everything that shows the data', async () => {
    const invalidate = await openDelete();
    expect(await screen.findByText('Remove connection, keep history')).toBeTruthy();
    expect(screen.getByText('Delete connection and all its data')).toBeTruthy();
    await pressAct('delete-keep');
    expect(mockApi.deleteConnector).toHaveBeenCalledWith('c1', 'keep');
    expect(screen.queryByTestId('delete-dialog')).toBeNull();
    for (const key of [
      '["connectors"]',
      '["home"]',
      '["transactions"]',
      '["accounts"]',
      '["net-worth"]',
    ]) {
      expect(refreshed(invalidate)).toContain(key);
    }
  });

  it('ignores a dismiss (backdrop, back) while the removal is running', async () => {
    let finish!: () => void;
    mockApi.listConnectors.mockResolvedValue({ connectors: [own({ displayName: 'Anna DKB' })] });
    mockApi.deleteConnector.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    await renderWithProviders(<ConnectionsScreen />);
    await openMenu('c1');
    await pressAct('delete-c1');
    await pressAct('delete-keep');
    expect(mockApi.deleteConnector).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('Close modal'));
    expect(screen.getByTestId('delete-dialog')).toBeTruthy();
    await act(async () => {
      finish();
    });
    expect(screen.queryByTestId('delete-dialog')).toBeNull();
  });

  it('purge: asks a second confirmation before sending mode purge', async () => {
    const invalidate = await openDelete();
    await pressAct('delete-purge');
    expect(mockApi.deleteConnector).not.toHaveBeenCalled();
    expect(await screen.findByTestId('purge-dialog')).toBeTruthy();
    expect(screen.getByText(/permanently deletes Anna DKB/)).toBeTruthy();
    await pressAct('purge-confirm');
    expect(mockApi.deleteConnector).toHaveBeenCalledTimes(1);
    expect(mockApi.deleteConnector).toHaveBeenCalledWith('c1', 'purge');
    expect(refreshed(invalidate)).toContain('["transactions"]');
    expect(screen.queryByTestId('purge-dialog')).toBeNull();
  });

  it('cancelling at either step sends nothing', async () => {
    await openDelete();
    await pressAct('delete-cancel');
    expect(screen.queryByTestId('delete-dialog')).toBeNull();
    await openMenu('c1');
    await pressAct('delete-c1');
    await pressAct('delete-purge');
    await pressAct('purge-cancel');
    expect(mockApi.deleteConnector).not.toHaveBeenCalled();
    expect(screen.queryByTestId('purge-dialog')).toBeNull();
  });

  it('uses the error colours for the destructive choices', async () => {
    await openDelete();
    const purge = await screen.findByTestId('delete-purge');
    const label = within(purge).getByText('Delete connection and all its data');
    expect((StyleSheet.flatten(label.props.style) as { color: string }).color).toBe(
      lightTheme.colors.error,
    );
    await pressAct('delete-purge');
    const confirm = within(await screen.findByTestId('purge-confirm')).getByText(
      'Delete everything',
    );
    expect((StyleSheet.flatten(confirm.props.style) as { color: string }).color).toBe(
      lightTheme.colors.onError,
    );
  });

  it('shows a message when the removal fails and still refetches', async () => {
    const invalidate = await openDelete();
    mockApi.deleteConnector.mockRejectedValue(new ApiClientError({ kind: 'server', status: 404 }));
    await pressAct('delete-keep');
    expect(await screen.findByText('This connection no longer exists.')).toBeTruthy();
    expect(refreshed(invalidate)).toContain('["connectors"]');
  });
});

describe('Add bank FAB', () => {
  it('navigates to the add screen and is the only add entry', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own()] });
    await renderWithProviders(<ConnectionsScreen />);
    await screen.findByTestId('connector-c1');
    expect(screen.getAllByTestId('add-bank')).toHaveLength(1);
    expect(screen.getByText('Add bank')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('add-bank'));
    expect(mockRouter.push).toHaveBeenCalledWith('/connections/add');
  });
});

describe('dark mode', () => {
  afterEach(() => {
    setThemeStore(undefined);
  });

  it('colours the list texts from the dark theme only', async () => {
    jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
    const store = createThemeStore();
    store.setPreference('dark');
    setThemeStore(store);
    mockApi.listConnectors.mockResolvedValue({
      connectors: [own({ displayName: 'Anna' }), other],
    });
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <PaperProvider theme={darkTheme}>
          <ConnectionsScreen />
        </PaperProvider>
      </QueryClientProvider>,
    );
    const title = await screen.findByText('Anna');
    const allowed = [
      darkTheme.colors.onSurface,
      darkTheme.colors.onSurfaceVariant,
      darkTheme.colors.error,
    ];
    for (const text of [
      title,
      screen.getByText(/Connected · Last sync/),
      screen.getByText('Connections'),
    ]) {
      const color = (StyleSheet.flatten(text.props.style) as { color?: string }).color;
      expect(allowed).toContain(color);
    }
  });
});

describe('AddConnectionScreen', () => {
  const challenge = {
    kind: 'decoupled',
    id: 'ch1',
    message: 'm',
    pollAfterMs: 3000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it('sends the credentials once, wipes the fields and never keeps them', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    mockApi.createConnector.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const client = await renderWithProviders(<AddConnectionScreen />);
    await fireEvent.changeText(screen.getByTestId('userid-input'), ' user1 ');
    await fireEvent.changeText(screen.getByTestId('pin-input'), 's3cret');
    expect(screen.getByTestId('pin-input').props.secureTextEntry).toBe(true);
    expect(screen.getByTestId('pin-input').props.autoComplete).toBe('off');
    expect(screen.getByTestId('pin-input').props.autoCorrect).toBe(false);

    await act(async () => {
      await fireEvent.press(screen.getByTestId('connect-submit'));
    });
    expect(mockApi.createConnector).toHaveBeenCalledTimes(1);
    expect(mockApi.createConnector).toHaveBeenCalledWith({
      type: 'fints',
      config: { bank: 'dkb', userId: 'user1', pin: 's3cret' },
    });
    // Request still in flight: the fields are already empty.
    expect(screen.getByTestId('pin-input').props.value).toBe('');
    expect(screen.getByTestId('userid-input').props.value).toBe('');

    await act(async () => {
      resolve({ connectorId: 'c1', challenge });
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/connections/challenge/ch1');
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('s3cret');
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });

  it('wipes the credentials even when the request fails', async () => {
    mockApi.createConnector.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderWithProviders(<AddConnectionScreen />);
    await fireEvent.changeText(screen.getByTestId('userid-input'), 'user1');
    await fireEvent.changeText(screen.getByTestId('pin-input'), 's3cret');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('connect-submit'));
    });
    expect(screen.getByTestId('pin-input').props.value).toBe('');
    expect(await screen.findByText('No connection. Try again when you are online.')).toBeTruthy();
  });

  it('the private switch sends accountDefaults and comdirect is selectable', async () => {
    mockApi.createConnector.mockResolvedValue({ connectorId: 'c1', challenge });
    await renderWithProviders(<AddConnectionScreen />);
    await fireEvent.press(screen.getByTestId('bank-comdirect'));
    await fireEvent.changeText(screen.getByTestId('userid-input'), 'u');
    await fireEvent.changeText(screen.getByTestId('pin-input'), 'p');
    await fireEvent(screen.getByTestId('private-switch'), 'valueChange', true);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('connect-submit'));
    });
    expect(mockApi.createConnector).toHaveBeenCalledWith({
      type: 'fints',
      config: { bank: 'comdirect', userId: 'u', pin: 'p' },
      accountDefaults: { visibility: 'owner_only' },
    });
  });

  it('shows the demo bank only when the server enables fake', async () => {
    await renderWithProviders(<AddConnectionScreen />);
    expect(screen.queryByTestId('bank-demo')).toBeNull();
  });

  it('connects the demo bank without credentials', async () => {
    mockApi.listConnectorTypes.mockResolvedValue({ types: ['fints', 'fake'] });
    mockApi.createConnector.mockResolvedValue({ connectorId: 'c1' });
    await renderWithProviders(<AddConnectionScreen />);
    await fireEvent.press(await screen.findByTestId('bank-demo'));
    expect(screen.queryByTestId('pin-input')).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('connect-submit'));
    });
    expect(mockApi.createConnector).toHaveBeenCalledWith({
      type: 'fake',
      config: { scenario: 'decoupled' },
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/connections');
  });
});
