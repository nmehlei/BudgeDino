import type { ConnectorInfo } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { AddConnectionScreen } from '../AddConnectionScreen';
import { challengeStore } from '../challenge-store';
import { ConnectionsScreen } from '../ConnectionsScreen';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockApi = {
  listConnectors: jest.fn(),
  listConnectorTypes: jest.fn(),
  createConnector: jest.fn(),
  syncConnector: jest.fn(),
  reconnectConnector: jest.fn(),
};

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
});

describe('ConnectionsScreen', () => {
  it('lists own connectors with actions and others read-only', async () => {
    mockApi.listConnectors.mockResolvedValue({
      connectors: [
        own(),
        own({ id: 'c2', status: 'needs_attention', consentExpiresAt: '2027-01-15T00:00:00.000Z' }),
        other,
      ],
    });
    await renderWithProviders(<ConnectionsScreen />);
    expect(await screen.findByTestId('sync-c1')).toBeTruthy();
    expect(screen.queryByTestId('reconnect-c1')).toBeNull();
    expect(screen.getByTestId('reconnect-c2')).toBeTruthy();
    expect(screen.queryByTestId('sync-c2')).toBeNull();
    expect(screen.getByText('Consent valid until 15.01.2027')).toBeTruthy();
    expect(screen.getByText('Shared by others')).toBeTruthy();
    expect(screen.queryByTestId('sync-c-other')).toBeNull();
    expect(screen.queryByTestId('reconnect-c-other')).toBeNull();
  });

  it('sync now starts a user-present sync', async () => {
    mockApi.listConnectors.mockResolvedValue({ connectors: [own()] });
    mockApi.syncConnector.mockResolvedValue({ runId: 'r1' });
    await renderWithProviders(<ConnectionsScreen />);
    await act(async () => {
      await fireEvent.press(await screen.findByTestId('sync-c1'));
    });
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
    await act(async () => {
      await fireEvent.press(await screen.findByTestId('reconnect-c1'));
    });
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
    await act(async () => {
      await fireEvent.press(await screen.findByTestId('sync-c1'));
    });
    expect(await screen.findByText('Too many requests, try again in 42 s.')).toBeTruthy();
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
      config: { scenario: 'happy' },
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/connections');
  });
});
