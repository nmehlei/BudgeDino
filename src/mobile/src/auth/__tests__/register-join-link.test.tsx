import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import RegisterScreen from '../../../app/(auth)/register';
import { ApiClientError } from '../../api/errors';

let mockParams: Record<string, string | string[] | undefined> = {};
let mockCleartext = false;
const mockSession = {
  status: 'signed_out' as 'signed_out' | 'signed_in',
  serverUrl: null as string | null,
  deviceName: null as string | null,
  setServerUrl: jest.fn(),
  setDeviceName: jest.fn(),
};
const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockApi = { health: jest.fn(), register: jest.fn() };
const mockCreateAuthApi = jest.fn<typeof mockApi, [string]>(() => mockApi);

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../session/useSession', () => ({ useSession: () => mockSession }));
jest.mock('../api', () => ({ createAuthApi: (url: string) => mockCreateAuthApi(url) }));
jest.mock('../config', () => ({ allowCleartext: () => mockCleartext }));
jest.mock('expo-device', () => ({ modelName: 'Pixel 9' }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockCleartext = false;
  mockSession.status = 'signed_out';
  mockSession.serverUrl = null;
  mockApi.health.mockResolvedValue({ ok: true, version: '1' });
  mockApi.register.mockResolvedValue({ totpProvisioningUri: 'otpauth://x', pendingId: 'p' });
});

async function renderScreen() {
  await render(
    <PaperProvider>
      <RegisterScreen />
    </PaperProvider>,
  );
}

const type = (testID: string, text: string) =>
  fireEvent.changeText(screen.getByTestId(testID), text);

async function fillAndSubmit() {
  await type('email', 'a@b.test');
  await type('display-name', 'A');
  await type('password', 'a-long-enough-password');
  await fireEvent.press(screen.getByText('Continue'));
}

describe('register via join link', () => {
  it('prefills the invite and names the host, without touching the stored server on open', async () => {
    mockParams = { server: 'https://budget.example.com/', invite: 'abc' };
    mockSession.serverUrl = 'https://mine.example.org';
    await renderScreen();
    expect(screen.getByTestId('invite-token').props.value).toBe('abc');
    expect(screen.getByText('Joining a household on budget.example.com')).toBeTruthy();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
  });

  it('persists the link server only on a successful submit, after the health check', async () => {
    mockParams = { server: 'https://budget.example.com/', invite: 'abc' };
    await renderScreen();
    await fillAndSubmit();
    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/(auth)/register-totp');
    });
    expect(mockCreateAuthApi).toHaveBeenCalledWith('https://budget.example.com');
    expect(mockCreateAuthApi).not.toHaveBeenCalledWith('https://mine.example.org');
    expect(mockSession.setServerUrl).toHaveBeenCalledWith('https://budget.example.com');
    expect(mockApi.health.mock.invocationCallOrder[0]).toBeLessThan(
      mockSession.setServerUrl.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('stores nothing when the link server fails its health check', async () => {
    mockParams = { server: 'https://budget.example.com', invite: 'abc' };
    mockApi.health.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderScreen();
    await fillAndSubmit();
    await screen.findByText(/Cannot reach the server/);
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
    expect(mockApi.register).not.toHaveBeenCalled();
  });

  it('refuses the link while signed in and leaves the session untouched', async () => {
    mockSession.status = 'signed_in';
    mockSession.serverUrl = 'https://mine.example.org';
    mockParams = { server: 'https://evil.example.com', invite: 'abc' };
    await renderScreen();
    expect(screen.getByText('Sign out first to join another household.')).toBeTruthy();
    expect(screen.queryByText(/Joining a household on/)).toBeNull();
    await fillAndSubmit();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
    expect(mockApi.register).not.toHaveBeenCalled();
    expect(mockCreateAuthApi).not.toHaveBeenCalled();
  });

  it('rejects an http:// server in a release build with the existing message', async () => {
    mockParams = { server: 'http://evil.example.com', invite: 'abc' };
    await renderScreen();
    expect(screen.getByText('The server address must start with https://')).toBeTruthy();
    expect(screen.queryByText(/Joining a household on/)).toBeNull();
    await fillAndSubmit();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
    expect(mockApi.register).not.toHaveBeenCalled();
  });

  it('accepts http:// where cleartext is allowed (development variant)', async () => {
    mockCleartext = true;
    mockParams = { server: 'http://192.168.1.5:8080', invite: 'abc' };
    await renderScreen();
    expect(screen.getByText('Joining a household on 192.168.1.5:8080')).toBeTruthy();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
  });

  it('without a link keeps the stored server and shows no banner', async () => {
    mockSession.serverUrl = 'https://mine.example.org';
    await renderScreen();
    expect(screen.queryByText(/Joining a household on/)).toBeNull();
    expect(screen.getByTestId('invite-token').props.value).toBe('');
    await type('invite-token', 'typed');
    await fillAndSubmit();
    await waitFor(() => {
      expect(mockApi.register).toHaveBeenCalled();
    });
    expect(mockApi.health).not.toHaveBeenCalled();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
  });
});
