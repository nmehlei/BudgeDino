import { act, render, screen } from '@testing-library/react-native';

import Index from '../../app/(app)/_layout';
import { SignOutRedirect } from '../session/SignOutRedirect';
import { createSessionStore, type PrefsStorage } from '../session/session-store';

const mockRouter = { replace: jest.fn() };
let mockSession = { status: 'loading', serverUrl: null as string | null };

jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useRouter: () => mockRouter,
    Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
    Tabs: Object.assign(() => <Text>tabs</Text>, { Screen: () => null }),
  };
});
jest.mock('../session/useSession', () => {
  const actual =
    jest.requireActual<typeof import('../session/useSession')>('../session/useSession');
  return {
    // The root screen reads the mocked snapshot; SignOutRedirect gets a real store via its prop.
    useSession: (store?: unknown) => (store ? actual.useSession(store as never) : mockSession),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('root redirect', () => {
  it('shows a loading state while the session loads', async () => {
    mockSession = { status: 'loading', serverUrl: null };
    await render(<Index />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  it('sends a signed-out install without server URL to the server screen', async () => {
    mockSession = { status: 'signed_out', serverUrl: null };
    await render(<Index />);
    expect(screen.getByText('redirect:/(auth)/server')).toBeTruthy();
  });

  it('sends a signed-out user with a stored server URL to login', async () => {
    mockSession = { status: 'signed_out', serverUrl: 'https://budget.example.com' };
    await render(<Index />);
    expect(screen.getByText('redirect:/(auth)/login')).toBeTruthy();
  });

  it('shows home when signed in', async () => {
    mockSession = { status: 'signed_in', serverUrl: 'https://budget.example.com' };
    await render(<Index />);
    expect(screen.getByText('tabs')).toBeTruthy();
  });
});

describe('401 sign-out', () => {
  it('lands on login and flags the session as expired', async () => {
    const data = new Map<string, string>([['serverUrl', 'https://budget.example.com']]);
    const prefs: PrefsStorage = {
      getString: (k) => data.get(k),
      set: (k, v) => {
        data.set(k, v);
      },
      remove: (k) => {
        data.delete(k);
      },
    };
    let secret: string | null = null;
    const store = createSessionStore({
      prefs,
      token: {
        get: async () => secret,
        set: async (t) => {
          secret = t;
        },
        remove: async () => {
          secret = null;
        },
      },
    });
    await store.signIn('tok');
    await render(<SignOutRedirect store={store} />);
    expect(mockRouter.replace).not.toHaveBeenCalled();

    await act(async () => {
      await store.expireSession();
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/(auth)/login');
    expect(store.getSnapshot().expired).toBe(true);

    await store.signIn('tok2');
    expect(store.getSnapshot().expired).toBe(false);
  });
});
