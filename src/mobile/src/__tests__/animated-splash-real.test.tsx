import { act, configure, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Appearance, StyleSheet } from 'react-native';

// The overlay is deliberately hidden from accessibility; query it anyway.
configure({ defaultIncludeHiddenElements: true });

const mockSplash = {
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  hideAsync: jest.fn(() => Promise.resolve()),
  setOptions: jest.fn(),
};
jest.mock('expo-splash-screen', () => mockSplash);
// The in-app preference override: the hook reports light, the device itself is dark.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => 'light',
}));

describe('AnimatedSplash with the real splash module', () => {
  beforeAll(() => {
    jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('dark');
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.useFakeTimers();
  });
  afterAll(() => jest.useRealTimers());

  it('uses the device scheme (not the override), then plays after hideSplash and unmounts', async () => {
    // Required after the spy so the module-load capture sees the device scheme.
    /* eslint-disable @typescript-eslint/no-require-imports -- order matters */
    const { AnimatedSplash } = require('../AnimatedSplash') as typeof import('../AnimatedSplash');
    const { hideSplash } = require('../splash') as typeof import('../splash');
    /* eslint-enable @typescript-eslint/no-require-imports */

    await render(<AnimatedSplash />);
    const overlay = screen.getByTestId('animated-splash');
    expect(StyleSheet.flatten(overlay.props.style).backgroundColor).toBe('#0E1311');

    await act(async () => {
      hideSplash();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1300);
    });
    expect(mockSplash.hideAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('animated-splash')).not.toBeNull();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(400);
    });
    expect(screen.queryByTestId('animated-splash')).toBeNull();
  });
});
