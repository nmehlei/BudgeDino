import type { ChallengeView } from '@budgedino/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, PixelRatio, StyleSheet, type AppStateStatus } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ApiClientError } from '../../api/errors';
import { challengeStore } from '../challenge-store';
import { ChallengeScreen } from '../ChallengeScreen';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockApi = {
  answerChallenge: jest.fn(),
  getChallenge: jest.fn(),
  cancelChallenge: jest.fn(),
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

const FAR = () => new Date(Date.now() + 10 * 60_000).toISOString();

const decoupled = (over: Partial<Extract<ChallengeView, { kind: 'decoupled' }>> = {}) =>
  ({
    kind: 'decoupled',
    id: 'ch1',
    message: 'Confirm the login in the DKB app',
    pollAfterMs: 3000,
    expiresAt: FAR(),
    ...over,
  }) as ChallengeView;

const codeChallenge = (over: Partial<Extract<ChallengeView, { kind: 'code' }>> = {}) =>
  ({
    kind: 'code',
    id: 'ch1',
    message: 'Enter the TAN',
    expiresAt: FAR(),
    ...over,
  }) as ChallengeView;

let appStateHandler: ((s: AppStateStatus) => void) | null = null;
const setAppState = (s: AppStateStatus) => act(() => appStateHandler?.(s));

async function renderChallenge(view: ChallengeView, connectorId = 'conn1') {
  challengeStore.set({ view, connectorId });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>
        <ChallengeScreen id={view.id} />
      </PaperProvider>
    </QueryClientProvider>,
  );
}

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  challengeStore.clear();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  appStateHandler = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appStateHandler = handler as (s: AppStateStatus) => void;
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('decoupled challenge', () => {
  it('polls at pollAfterMs and shows the message', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'open', challenge: decoupled() });
    await renderChallenge(decoupled({ pollAfterMs: 5000 }));
    expect(screen.getByText('Confirm the login in the DKB app')).toBeTruthy();

    await advance(4900);
    expect(mockApi.answerChallenge).not.toHaveBeenCalled();
    await advance(200);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    expect(mockApi.answerChallenge).toHaveBeenCalledWith('ch1', { kind: 'decoupled' });
    // The reply asked for 3 s next.
    await advance(2800);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(300);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(2);
  });

  it('never polls faster than 2 s, whatever pollAfterMs says', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 0 }));
    await advance(1900);
    expect(mockApi.answerChallenge).not.toHaveBeenCalled();
    await advance(200);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(1800);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(300);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After after a 429', async () => {
    mockApi.answerChallenge
      .mockRejectedValueOnce(new ApiClientError({ kind: 'rate_limited', retryAfterSec: 30 }))
      .mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('challenge-notice')).toBeTruthy();

    await advance(29_000);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(1500);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(2);
  });

  it('pauses in the background and resumes on return', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await setAppState('background');
    await advance(60_000);
    expect(mockApi.answerChallenge).not.toHaveBeenCalled();

    await setAppState('active');
    await advance(10);
    // The schedule is overdue, so it checks right away (the user just came back from the bank app).
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
  });

  it('does not poll before a rate-limit window ends even after resuming', async () => {
    mockApi.answerChallenge
      .mockRejectedValueOnce(new ApiClientError({ kind: 'rate_limited', retryAfterSec: 60 }))
      .mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await advance(2100);
    await setAppState('background');
    await advance(20_000);
    await setAppState('active');
    await advance(10);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(40_000);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(2);
  });

  it('the confirm button checks immediately and completes', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'completed' });
    await renderChallenge(decoupled());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-confirm'));
    });
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('challenge-success')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('challenge-done'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/connections');
  });

  it('shows the expiry when the challenge lapses, and retry reconnects', async () => {
    mockApi.getChallenge.mockResolvedValue({ status: 'expired' });
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ expiresAt: new Date(Date.now() + 8000).toISOString() }));
    await advance(9000);
    expect(mockApi.getChallenge).toHaveBeenCalledWith('ch1');
    expect(screen.getByTestId('challenge-expired')).toBeTruthy();

    mockApi.reconnectConnector.mockResolvedValue({ challenge: decoupled({ id: 'ch2' }) });
    await act(async () => {
      await fireEvent.press(screen.getByText('Try again'));
    });
    expect(mockApi.reconnectConnector).toHaveBeenCalledWith('conn1');
    expect(screen.getByTestId('challenge-decoupled')).toBeTruthy();
  });

  it('shows a lapsed challenge as expired when returning from the background', async () => {
    mockApi.getChallenge.mockResolvedValue({ status: 'expired' });
    await renderChallenge(decoupled({ expiresAt: new Date(Date.now() + 20_000).toISOString() }));
    await setAppState('background');
    jest.setSystemTime(Date.now() + 60_000);
    await setAppState('active');
    await advance(10);
    expect(screen.getByTestId('challenge-expired')).toBeTruthy();
  });

  it('explains a declined request', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'cancelled', reason: 'declined' });
    await renderChallenge(decoupled());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-confirm'));
    });
    expect(screen.getByText('The request was declined in your banking app.')).toBeTruthy();
  });

  it('cancel deletes the challenge and leaves', async () => {
    mockApi.cancelChallenge.mockResolvedValue({ status: 'cancelled' });
    await renderChallenge(decoupled());
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-cancel'));
    });
    expect(mockApi.cancelChallenge).toHaveBeenCalledWith('ch1');
    expect(mockRouter.replace).toHaveBeenCalledWith('/connections');
  });
});

describe('polling hardening', () => {
  it('keeps polling after a 409 challenge_busy', async () => {
    mockApi.answerChallenge
      .mockRejectedValueOnce(new ApiClientError({ kind: 'server', status: 409 }))
      .mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Tap the button to try again/)).toBeNull();
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(2);
  });

  it('cancel is guarded: no poll during the DELETE and a second tap is ignored', async () => {
    let finish: (v: unknown) => void = () => undefined;
    mockApi.cancelChallenge.mockReturnValue(new Promise((r) => (finish = r)));
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-cancel'));
    });
    await advance(10_000);
    expect(mockApi.answerChallenge).not.toHaveBeenCalled();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-cancel'));
    });
    expect(mockApi.cancelChallenge).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ status: 'cancelled' });
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/connections');
  });

  it('a poll that resolves after Cancel was tapped does not re-arm polling', async () => {
    let resolvePoll: (v: unknown) => void = () => undefined;
    mockApi.answerChallenge.mockReturnValueOnce(new Promise((r) => (resolvePoll = r)));
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    mockApi.cancelChallenge.mockReturnValue(new Promise(() => undefined));
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-cancel'));
    });
    await act(async () => {
      resolvePoll({ status: 'open' });
    });
    await advance(10_000);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
  });

  it('two taps on Cancel in the same tick send one DELETE', async () => {
    mockApi.cancelChallenge.mockReturnValue(new Promise(() => undefined));
    await renderChallenge(decoupled());
    const button = screen.getByTestId('challenge-cancel');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    expect(mockApi.cancelChallenge).toHaveBeenCalledTimes(1);
  });

  it('confirm keeps a 2 s floor since the last request', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(500);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-confirm'));
    });
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await advance(1700);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(2);
  });

  it('confirm during an in-flight poll sends no second request', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    mockApi.answerChallenge.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderChallenge(decoupled({ pollAfterMs: 2000 }));
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-confirm'));
    });
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ status: 'open' });
    });
  });

  it('stops polling after unmount', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'open' });
    challengeStore.set({ view: decoupled({ pollAfterMs: 2000 }), connectorId: 'conn1' });
    const r = await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })}
      >
        <PaperProvider>
          <ChallengeScreen id="ch1" />
        </PaperProvider>
      </QueryClientProvider>,
    );
    await advance(2100);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
    await act(async () => r.unmount());
    await advance(30_000);
    expect(mockApi.answerChallenge).toHaveBeenCalledTimes(1);
  });
});

describe('code challenge', () => {
  it('keeps the screen on a 422 and shows "Invalid input"', async () => {
    mockApi.answerChallenge.mockRejectedValue(
      new ApiClientError({ kind: 'validation', issues: [] }),
    );
    await renderChallenge(codeChallenge());
    await fireEvent.changeText(screen.getByTestId('challenge-code'), '123456');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-submit'));
    });
    expect(mockApi.answerChallenge).toHaveBeenCalledWith('ch1', { kind: 'code', code: '123456' });
    expect(screen.getByText('Invalid input')).toBeTruthy();
    expect(screen.getByTestId('challenge-code')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('does not poll and completes on a correct code', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'completed' });
    await renderChallenge(codeChallenge());
    await advance(30_000);
    expect(mockApi.answerChallenge).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByTestId('challenge-code'), '654321');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-submit'));
    });
    expect(screen.getByTestId('challenge-success')).toBeTruthy();
  });
});

describe('image challenge', () => {
  it('renders a data URI with the right mime type and answers with the code', async () => {
    mockApi.answerChallenge.mockResolvedValue({ status: 'completed' });
    await renderChallenge({
      kind: 'image',
      id: 'ch1',
      message: 'Scan the picture',
      imageBase64: 'QUJD',
      mimeType: 'image/jpeg',
      expiresAt: FAR(),
    });
    const image = screen.getByTestId('challenge-image');
    expect(image.props.source).toEqual({ uri: 'data:image/jpeg;base64,QUJD' });
    await fireEvent.changeText(screen.getByTestId('challenge-code'), '111222');
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-submit'));
    });
    expect(mockApi.answerChallenge).toHaveBeenCalledWith('ch1', { kind: 'image', code: '111222' });
  });
});

describe('redirect challenge', () => {
  it('renders an unsupported notice with a cancel action', async () => {
    await renderChallenge({
      kind: 'redirect',
      id: 'ch1',
      url: 'https://bank.example/auth',
      returnUrlScheme: 'budgedino',
      expiresAt: FAR(),
    });
    expect(screen.getByTestId('challenge-unsupported')).toBeTruthy();
  });
});

describe('without a stored challenge', () => {
  it('offers to cancel a still-open challenge', async () => {
    mockApi.getChallenge.mockResolvedValue({ status: 'open' });
    await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })}
      >
        <PaperProvider>
          <ChallengeScreen id="gone" />
        </PaperProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('challenge-orphan')).toBeTruthy();
    mockApi.cancelChallenge.mockResolvedValue({ status: 'cancelled' });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('challenge-cancel-orphan'));
    });
    expect(mockApi.cancelChallenge).toHaveBeenCalledWith('gone');
  });
});

describe('large font', () => {
  it('keeps the TAN input and buttons unclipped at font scale 2', async () => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    await renderChallenge(
      codeChallenge({ message: 'Please enter the TAN that your bank sent you by SMS. '.repeat(4) }),
    );
    // Scrollable, so nothing is cut off when the content outgrows the screen.
    expect(screen.getByTestId('challenge-scroll')).toBeTruthy();
    const input = StyleSheet.flatten(screen.getByTestId('challenge-code').props.style) as Record<
      string,
      unknown
    >;
    expect(input?.['height']).toBeUndefined();
    for (const id of ['challenge-submit', 'challenge-cancel']) {
      const style = StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<
        string,
        unknown
      >;
      expect(style?.['height']).toBeUndefined();
    }
    for (const node of screen.getAllByText(/Please enter the TAN/)) {
      expect(node.props.numberOfLines).toBeUndefined();
    }
    expect(screen.getByText('Submit').props.numberOfLines).toBeUndefined();
  });
});
