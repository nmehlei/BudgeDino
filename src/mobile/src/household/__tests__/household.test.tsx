import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { HouseholdScreen } from '../HouseholdScreen';
import { buildJoinLink } from '../join-link';

jest.setTimeout(20_000);

const SERVER = 'https://budget.example.com';
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockApi = {
  listMembers: jest.fn(),
  listInvites: jest.fn(),
  createInvite: jest.fn(),
  revokeInvite: jest.fn(),
};

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('../../session/useSession', () => ({ useSession: () => ({ serverUrl: SERVER }) }));
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: ({ value }: { value: string }) => <Text testID="qr">{value}</Text>,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const members = (role: 'admin' | 'member') => ({
  members: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Nora',
      role,
      joinedAt: '2026-01-01T00:00:00.000Z',
      isSelf: true,
      disabled: false,
      email: 'nora@example.com',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      displayName: 'Ben',
      role: 'member',
      joinedAt: '2026-02-01T00:00:00.000Z',
      isSelf: false,
      disabled: false,
    },
  ],
});
const invite = { id: 'i1', role: 'member', expiresAt: '2026-11-20T10:30:00.000Z' };

const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

async function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>
        <HouseholdScreen />
      </PaperProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.listMembers.mockResolvedValue(members('admin'));
  mockApi.listInvites.mockResolvedValue({ invites: [invite] });
});

describe('buildJoinLink', () => {
  it('URL-encodes both values', () => {
    expect(buildJoinLink('https://b.example.com:8443/api', 'a+b/c d')).toBe(
      'budgedino://register?server=https%3A%2F%2Fb.example.com%3A8443%2Fapi&invite=a%2Bb%2Fc%20d',
    );
  });
});

describe('HouseholdScreen', () => {
  it('lists members with role and a You marker', async () => {
    await renderScreen();
    expect(await screen.findByText('Nora')).toBeTruthy();
    expect(screen.getByText('Admin · You · nora@example.com')).toBeTruthy();
    expect(screen.getByText('Ben')).toBeTruthy();
    expect(screen.getByText('Member')).toBeTruthy();
  });

  it('shows members only to a member: no invite action, no invites request', async () => {
    mockApi.listMembers.mockResolvedValue(members('member'));
    await renderScreen();
    expect(await screen.findByText('Ben')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('invite-someone')).toBeNull();
    });
    expect(screen.queryByTestId('pending-invites')).toBeNull();
    expect(mockApi.listInvites).not.toHaveBeenCalled();
  });

  it('shows an error with Retry when the members lookup fails, not a silent member view', async () => {
    mockApi.listMembers.mockRejectedValueOnce(new ApiClientError({ kind: 'network' }));
    await renderScreen();
    expect(await screen.findByTestId('household-error')).toBeTruthy();
    expect(screen.queryByTestId('invite-someone')).toBeNull();
    await fireEvent.press(screen.getByText('Retry'));
    expect(await screen.findByText('Ben')).toBeTruthy();
    expect(screen.getByTestId('invite-someone')).toBeTruthy();
  });

  it('creates an invite with the chosen role, shows the QR and shares the link', async () => {
    mockApi.createInvite.mockResolvedValue({
      inviteToken: 'tok en',
      expiresAt: '2026-11-20T10:30:00.000Z',
    });
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('invite-someone'));
    await fireEvent.press(await screen.findByText('Admin'));
    await fireEvent.press(screen.getByTestId('invite-create'));

    const link = buildJoinLink(SERVER, 'tok en');
    expect((await screen.findByTestId('qr')).props.children).toBe(link);
    expect(mockApi.createInvite).toHaveBeenCalledWith({ role: 'admin' });

    await fireEvent.press(screen.getByTestId('invite-share'));
    expect(share).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(share.mock.calls[0]?.[0])).toContain(link);
  });

  it('forgets the token when the sheet closes and refreshes the pending list', async () => {
    mockApi.createInvite.mockResolvedValue({
      inviteToken: 'secret-token',
      expiresAt: '2026-11-20T10:30:00.000Z',
    });
    const client = await renderScreen();
    await fireEvent.press(await screen.findByTestId('invite-someone'));
    await fireEvent.press(screen.getByTestId('invite-create'));
    await screen.findByTestId('qr');
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('secret-token');
    expect(client.getMutationCache().getAll()).toHaveLength(0);

    mockApi.listInvites.mockClear();
    await fireEvent.press(screen.getByTestId('invite-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('qr')).toBeNull();
    });
    await waitFor(() => {
      expect(mockApi.listInvites).toHaveBeenCalled();
    });

    await fireEvent.press(screen.getByTestId('invite-someone'));
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByTestId('invite-create')).toBeTruthy();
  });

  it('lists pending invites with expiry and revokes one', async () => {
    mockApi.revokeInvite.mockResolvedValue(undefined);
    await renderScreen();
    expect(await screen.findByTestId('pending-invite-i1')).toBeTruthy();
    expect(screen.getByText(/Expires 20\.11\./)).toBeTruthy();

    mockApi.listInvites.mockResolvedValue({ invites: [] });
    await fireEvent.press(screen.getByTestId('revoke-invite-i1'));
    await waitFor(() => {
      expect(mockApi.revokeInvite).toHaveBeenCalledWith('i1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('pending-invite-i1')).toBeNull();
    });
  });

  it('says so and refetches when the invite was already used (409)', async () => {
    mockApi.revokeInvite.mockRejectedValue(new ApiClientError({ kind: 'server', status: 409 }));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('revoke-invite-i1'));
    expect(await screen.findByText('This invite was already used')).toBeTruthy();
    await waitFor(() => {
      expect(mockApi.listInvites).toHaveBeenCalledTimes(2);
    });
  });
});
