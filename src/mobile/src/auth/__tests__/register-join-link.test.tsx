import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import RegisterScreen from '../../../app/(auth)/register';

let mockParams: Record<string, string | string[] | undefined> = {};
let mockCleartext = false;
const mockSession = {
  serverUrl: null as string | null,
  deviceName: null as string | null,
  setServerUrl: jest.fn(),
  setDeviceName: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../session/useSession', () => ({ useSession: () => mockSession }));
jest.mock('../api', () => ({ createAuthApi: () => ({}) }));
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
});

async function renderScreen() {
  await render(
    <PaperProvider>
      <RegisterScreen />
    </PaperProvider>,
  );
}

describe('register via join link', () => {
  it('prefills the invite, stores the normalized server and names the host', async () => {
    mockParams = { server: 'https://budget.example.com/', invite: 'abc' };
    await renderScreen();
    expect(screen.getByTestId('invite-token').props.value).toBe('abc');
    await waitFor(() => {
      expect(mockSession.setServerUrl).toHaveBeenCalledWith('https://budget.example.com');
    });
    expect(screen.getByText('Joining a household on budget.example.com')).toBeTruthy();
  });

  it('rejects an http:// server in a release build with the existing message', async () => {
    mockParams = { server: 'http://evil.example.com', invite: 'abc' };
    await renderScreen();
    expect(screen.getByText('The server address must start with https://')).toBeTruthy();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
    expect(screen.queryByText(/Joining a household on/)).toBeNull();
  });

  it('accepts http:// where cleartext is allowed (development variant)', async () => {
    mockCleartext = true;
    mockParams = { server: 'http://192.168.1.5:8080', invite: 'abc' };
    await renderScreen();
    await waitFor(() => {
      expect(mockSession.setServerUrl).toHaveBeenCalledWith('http://192.168.1.5:8080');
    });
    expect(screen.getByText('Joining a household on 192.168.1.5:8080')).toBeTruthy();
  });

  it('shows no join banner and stores nothing without a link', async () => {
    await renderScreen();
    expect(screen.queryByText(/Joining a household on/)).toBeNull();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId('invite-token').props.value).toBe('');
    await fireEvent.changeText(screen.getByTestId('invite-token'), 'typed');
    expect(screen.getByTestId('invite-token').props.value).toBe('typed');
  });
});
