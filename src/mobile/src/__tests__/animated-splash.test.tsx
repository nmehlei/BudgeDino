import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Text, View } from 'react-native';

import { AnimatedSplash, SPLASH_FADE_MS } from '../AnimatedSplash';

let mockHidden = false;
const mockListeners = new Set<() => void>();
jest.mock('../splash', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted mock factory
  const { useSyncExternalStore } = require('react') as typeof import('react');
  return {
    useSplashHidden: () =>
      useSyncExternalStore(
        (l: () => void) => {
          mockListeners.add(l);
          return () => mockListeners.delete(l);
        },
        () => mockHidden,
      ),
  };
});
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => 'light',
}));

async function hideNative(): Promise<void> {
  mockHidden = true;
  await act(async () => mockListeners.forEach((l) => l()));
}

function App() {
  return (
    <View>
      <AnimatedSplash />
      <Text>app content</Text>
    </View>
  );
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('AnimatedSplash', () => {
  beforeEach(() => {
    mockHidden = false;
    jest.useFakeTimers();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders over the app, never blocks it, and unmounts after its animation', async () => {
    await render(<App />);
    expect(screen.getByText('app content')).toBeTruthy();
    const overlay = screen.getByTestId('animated-splash');
    expect(overlay.props.pointerEvents).toBe('none');
    expect(screen.getByLabelText('BudgeDino')).toBeTruthy();

    await hideNative();
    await flush(600);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();
    expect(screen.getByText('app content')).toBeTruthy();

    await flush(3000);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
    expect(screen.getByText('app content')).toBeTruthy();
  });

  it('waits for the native splash to hide before playing', async () => {
    await render(<App />);
    await flush(10_000);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();
  });

  it('with reduce motion skips the animation and only fades out', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<App />);
    await hideNative();
    await flush(SPLASH_FADE_MS + 100);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
  });
});
