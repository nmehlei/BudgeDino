import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import LoginScreen from '../../../app/(auth)/login';
import RegisterScreen from '../../../app/(auth)/register';
import RegisterTotpScreen from '../../../app/(auth)/register-totp';
import ServerScreen from '../../../app/(auth)/server';
import { ApiClientError } from '../../api/errors';
import { pendingRegistration } from '../pending-registration';

const mockListeners: Record<string, (() => void) | undefined> = {};
const mockNavigation = {
  addListener: (event: string, cb: () => void) => {
    mockListeners[event] = cb;
    return () => {
      mockListeners[event] = undefined;
    };
  },
};
const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockSession = {
  status: 'signed_out' as const,
  serverUrl: 'https://budget.example.com' as string | null,
  deviceName: null as string | null,
  expired: false,
  setServerUrl: jest.fn(),
  setDeviceName: jest.fn(),
  signIn: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  dismissExpiredNotice: jest.fn(),
};
const mockApi = {
  health: jest.fn(),
  register: jest.fn(),
  registerConfirm: jest.fn(),
  login: jest.fn(),
};
let mockCleartext = false;
const mockSetString = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useNavigation: () => mockNavigation,
}));
jest.mock('../../session/useSession', () => ({ useSession: () => mockSession }));
jest.mock('../api', () => ({ createAuthApi: () => mockApi }));
jest.mock('../config', () => ({ allowCleartext: () => mockCleartext }));
jest.mock('expo-device', () => ({ modelName: 'Pixel 9' }));
jest.mock('expo-clipboard', () => ({ setStringAsync: (s: string) => mockSetString(s) }));
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

const URI = 'otpauth://totp/BudgeDino:a%40b.test?secret=JBSWY3DPEHPK3PXP&issuer=BudgeDino';

async function renderScreen(ui: React.ReactElement) {
  await render(<PaperProvider>{ui}</PaperProvider>);
}

const type = (testID: string, text: string) =>
  fireEvent.changeText(screen.getByTestId(testID), text);

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.serverUrl = 'https://budget.example.com';
  mockSession.expired = false;
  mockSession.deviceName = null;
  mockCleartext = false;
  pendingRegistration.clear();
});

describe('server screen', () => {
  it('rejects http:// in the production variant without calling the server', async () => {
    await renderScreen(<ServerScreen />);
    await type('server-url', 'http://192.168.1.5:3000');
    await fireEvent.press(screen.getByText('Check'));
    expect(screen.getByText('The server address must start with https://')).toBeTruthy();
    expect(mockApi.health).not.toHaveBeenCalled();
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
  });

  it('checks the health endpoint, stores the normalised URL and offers to continue', async () => {
    mockApi.health.mockResolvedValue({ ok: true, version: '1.2.3' });
    await renderScreen(<ServerScreen />);
    await type('server-url', 'https://budget.example.com/');
    await fireEvent.press(screen.getByText('Check'));
    await waitFor(() => {
      expect(screen.getByText('Connected (server 1.2.3).')).toBeTruthy();
    });
    expect(mockSession.setServerUrl).toHaveBeenCalledWith('https://budget.example.com');
    await fireEvent.press(screen.getByText('Sign in'));
    expect(mockRouter.push).toHaveBeenCalledWith('/(auth)/login');
  });

  it('allows http:// in the development variant', async () => {
    mockCleartext = true;
    mockApi.health.mockResolvedValue({ ok: true, version: '1.0.0' });
    await renderScreen(<ServerScreen />);
    await type('server-url', 'http://192.168.1.5:3000');
    await fireEvent.press(screen.getByText('Check'));
    await waitFor(() => {
      expect(mockSession.setServerUrl).toHaveBeenCalledWith('http://192.168.1.5:3000');
    });
  });

  it('shows an error and stores nothing when the server is unreachable', async () => {
    mockApi.health.mockRejectedValue(new ApiClientError({ kind: 'network' }));
    await renderScreen(<ServerScreen />);
    await type('server-url', 'https://nope.example.com');
    await fireEvent.press(screen.getByText('Check'));
    await waitFor(() => {
      expect(screen.getByText(/Cannot reach the server/)).toBeTruthy();
    });
    expect(mockSession.setServerUrl).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('registers with the invite, shows QR and secret, confirms with the TOTP code and stores the token', async () => {
    mockApi.register.mockResolvedValue({ totpProvisioningUri: URI, pendingId: 'p-1' });
    mockApi.registerConfirm.mockResolvedValue({ sessionToken: 'session-token' });

    await renderScreen(<RegisterScreen />);
    expect(screen.getByTestId('device-name').props.value).toBe('Pixel 9');
    await type('invite-token', 'invite-abc');
    await type('email', 'a@b.test');
    await type('display-name', 'Alex');
    await type('password', 'short');
    expect(screen.getByTestId('password-hint')).toBeTruthy();
    await type('password', 'correct horse battery');
    await fireEvent.press(screen.getByText('Continue'));
    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/(auth)/register-totp');
    });
    expect(screen.getByTestId('password').props.value).toBe('');
    expect(mockApi.register).toHaveBeenCalledWith({
      inviteToken: 'invite-abc',
      email: 'a@b.test',
      displayName: 'Alex',
      password: 'correct horse battery',
      deviceName: 'Pixel 9',
    });

    // The TOTP screen reads the hand-over.
    await screen.unmount();
    await renderScreen(<RegisterTotpScreen />);
    expect(screen.getByTestId('qr').props.children).toBe(URI);
    expect(screen.getByTestId('totp-secret').props.children).toBe('JBSWY3DPEHPK3PXP');
    await fireEvent.press(screen.getByText('Copy secret'));
    expect(mockSetString).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP');

    await type('totp-input', '12a345');
    expect(screen.getByTestId('totp-input').props.value).toBe('12345');
    await type('totp-input', '123456');
    await fireEvent.press(screen.getByText('Confirm'));
    await waitFor(() => {
      expect(mockSession.signIn).toHaveBeenCalledWith('session-token');
    });
    expect(mockApi.registerConfirm).toHaveBeenCalledWith({ pendingId: 'p-1', totpCode: '123456' });
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect(pendingRegistration.get()).toBeNull();
  });

  it('keeps Continue disabled for a password under 12 characters', async () => {
    await renderScreen(<RegisterScreen />);
    await type('invite-token', 'i');
    await type('email', 'a@b.test');
    await type('display-name', 'A');
    await type('password', 'eleven-char');
    await fireEvent.press(screen.getByText('Continue'));
    expect(mockApi.register).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  it('signs in and goes home', async () => {
    mockApi.login.mockResolvedValue({ sessionToken: 'tok' });
    await renderScreen(<LoginScreen />);
    await type('email', 'a@b.test');
    await type('password', 'whatever-password');
    await type('totp-input', '123456');
    await fireEvent.press(screen.getAllByText('Sign in').at(-1) as never);
    await waitFor(() => {
      expect(mockSession.signIn).toHaveBeenCalledWith('tok');
    });
    expect(mockApi.login).toHaveBeenCalledWith({
      email: 'a@b.test',
      password: 'whatever-password',
      totpCode: '123456',
      deviceName: 'Pixel 9',
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect(screen.getByTestId('password').props.value).toBe('');
  });

  it('shows only a generic message on 401', async () => {
    mockApi.login.mockRejectedValue(new ApiClientError({ kind: 'unauthorized' }));
    await renderScreen(<LoginScreen />);
    await type('email', 'a@b.test');
    await type('password', 'whatever-password');
    await type('totp-input', '123456');
    await fireEvent.press(screen.getAllByText('Sign in').at(-1) as never);
    await waitFor(() => {
      expect(screen.getByText('Login failed')).toBeTruthy();
    });
    expect(mockSession.signIn).not.toHaveBeenCalled();
  });

  it('shows the retry time on 429', async () => {
    mockApi.login.mockRejectedValue(
      new ApiClientError({ kind: 'rate_limited', retryAfterSec: 600 }),
    );
    await renderScreen(<LoginScreen />);
    await type('email', 'a@b.test');
    await type('password', 'whatever-password');
    await type('totp-input', '123456');
    await fireEvent.press(screen.getAllByText('Sign in').at(-1) as never);
    await waitFor(() => {
      expect(screen.getByText('Too many attempts, try again in 10 minutes')).toBeTruthy();
    });
  });

  it('only accepts six digits in the code field and blocks submit until complete', async () => {
    await renderScreen(<LoginScreen />);
    await type('email', 'a@b.test');
    await type('password', 'whatever-password');
    await type('totp-input', '12ab34cd567');
    expect(screen.getByTestId('totp-input').props.value).toBe('123456');
    expect(screen.getByTestId('totp-input').props.maxLength).toBe(6);
    await type('totp-input', '12345');
    await fireEvent.press(screen.getAllByText('Sign in').at(-1) as never);
    expect(mockApi.login).not.toHaveBeenCalled();
  });

  it('explains an expired session', async () => {
    mockSession.expired = true;
    await renderScreen(<LoginScreen />);
    expect(screen.getByText('Session expired, please sign in again')).toBeTruthy();
    expect(mockSession.dismissExpiredNotice).toHaveBeenCalledTimes(1);
  });
});

describe('200 % font scale', () => {
  it('keeps the TOTP field and the buttons usable: scrollable, no fixed sizes', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    mockApi.login.mockResolvedValue({ sessionToken: 'tok' });
    await renderScreen(<LoginScreen />);

    expect(screen.getByTestId('auth-scroll')).toBeTruthy();
    const totp = screen.getByTestId('totp-input');
    const style = StyleSheet.flatten(totp.props.style) as Record<string, unknown>;
    // Height is left to Paper, which derives it from the measured (font-scaled) label.
    expect(style['width']).toBeUndefined();
    expect(totp.props.allowFontScaling).not.toBe(false);

    await type('email', 'a@b.test');
    await type('password', 'whatever-password');
    await type('totp-input', '123456');
    expect(screen.getByTestId('totp-input').props.value).toBe('123456');
    await fireEvent.press(screen.getAllByText('Sign in').at(-1) as never);
    await waitFor(() => {
      expect(mockSession.signIn).toHaveBeenCalled();
    });
    jest.restoreAllMocks();
  });
});

describe('TOTP secret hygiene', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('drops the provisioning URI when the screen is left, and registering again works', async () => {
    pendingRegistration.set({ pendingId: 'p-1', totpProvisioningUri: URI });
    await renderScreen(<RegisterTotpScreen />);
    expect(screen.getByTestId('qr')).toBeTruthy(); // still rendered while on screen
    mockListeners['beforeRemove']?.();
    expect(pendingRegistration.get()).toBeNull();

    await screen.unmount();
    mockApi.register.mockResolvedValue({ totpProvisioningUri: URI, pendingId: 'p-2' });
    await renderScreen(<RegisterScreen />);
    await type('invite-token', 'i');
    await type('email', 'a@b.test');
    await type('display-name', 'A');
    await type('password', 'correct horse battery');
    await fireEvent.press(screen.getByText('Continue'));
    await waitFor(() => {
      expect(pendingRegistration.get()?.pendingId).toBe('p-2');
    });
  });

  it('overwrites the clipboard about 60 s after copying, even after leaving the screen', async () => {
    pendingRegistration.set({ pendingId: 'p-1', totpProvisioningUri: URI });
    await renderScreen(<RegisterTotpScreen />);
    await fireEvent.press(screen.getByText('Copy secret'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/clipboard is cleared/)).toBeTruthy();
    expect(mockSetString).not.toHaveBeenCalledWith('');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mockSetString).toHaveBeenLastCalledWith('');

    mockSetString.mockClear();
    await fireEvent.press(screen.getByText('Copied'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await screen.unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mockSetString).toHaveBeenLastCalledWith('');
  });
});
