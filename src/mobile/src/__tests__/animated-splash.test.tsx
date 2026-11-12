import { act, configure, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';

import { AnimatedSplash, SPLASH_FADE_MS, resetAnimatedSplashForTests } from '../AnimatedSplash';

// The overlay is deliberately hidden from accessibility; query it anyway.
configure({ defaultIncludeHiddenElements: true });

let mockHidden = false;
const mockListeners = new Set<() => void>();
jest.mock('../splash', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted mock factory
  const { useSyncExternalStore } = require('react') as typeof import('react');
  return {
    isSplashHidden: () => mockHidden,
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
    resetAnimatedSplashForTests();
    jest.useFakeTimers();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders over the app, never blocks it, is hidden from accessibility, and unmounts after its animation', async () => {
    await render(<App />);
    expect(screen.getByText('app content')).toBeTruthy();
    const overlay = screen.getByTestId('animated-splash');
    expect(overlay.props.pointerEvents).toBe('none');
    expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(overlay.props.accessibilityElementsHidden).toBe(true);
    expect(overlay.props.accessible).toBeUndefined();
    expect(overlay.props.accessibilityLabel).toBeUndefined();

    await hideNative();
    await flush(1300);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();
    expect(screen.getByText('app content')).toBeTruthy();

    await flush(300);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
    expect(screen.getByText('app content')).toBeTruthy();
  });

  it('shows the coins at rest from the first frame (no coinless flash)', async () => {
    await render(<App />);
    const overlay = screen.getByTestId('animated-splash');
    expect(StyleSheet.flatten(overlay.props.style).opacity).toBe(1);
    const coinViews = [0, 1, 2, 3].map((i) => screen.getByTestId(`splash-coin-${i}`));
    for (const v of coinViews) {
      const style = StyleSheet.flatten(v.props.style) as {
        opacity?: number;
        transform: Record<string, number>[];
      };
      expect(style.opacity ?? 1).toBe(1);
      expect(style.transform).toEqual(expect.arrayContaining([{ translateY: 0 }, { scale: 1 }]));
    }
  });

  it('waits for the native splash to hide before playing', async () => {
    await render(<App />);
    await flush(10_000);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();
  });

  it('renders nothing when mounted after the splash already hid', async () => {
    mockHidden = true;
    await render(<App />);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
    expect(screen.getByText('app content')).toBeTruthy();
  });

  it('with reduce motion skips the animation and only fades out', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<App />);
    await hideNative();
    await flush(SPLASH_FADE_MS + 100);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
  });

  it('plays normally when the reduce-motion check never answers', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => {}));
    await render(<App />);
    await hideNative();
    await flush(1000);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();
    await flush(1000);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
  });

  it('failsafe removes the overlay when the animation never finishes', async () => {
    jest.spyOn(Animated, 'sequence').mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);
    await render(<App />);
    await hideNative();
    await flush(2000);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();
    await flush(700);
    expect(screen.queryByTestId('animated-splash')).toBeNull();
  });

  it('unmounting mid-animation is clean', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = await render(<App />);
    await hideNative();
    await flush(400);
    await view.unmount();
    await flush(5000);
    expect(errors).not.toHaveBeenCalled();
  });
});
