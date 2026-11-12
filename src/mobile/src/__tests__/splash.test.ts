const mockSplash = {
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  hideAsync: jest.fn(() => Promise.resolve()),
  setOptions: jest.fn(),
};
jest.mock('expo-splash-screen', () => mockSplash);

describe('splash', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    Object.values(mockSplash).forEach((f) => f.mockClear());
  });
  afterEach(() => jest.useRealTimers());

  it('keeps the splash, then hides it exactly once', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module state per test
      const splash = require('../splash') as typeof import('../splash');
      splash.keepSplashUntilReady();
      expect(mockSplash.preventAutoHideAsync).toHaveBeenCalledTimes(1);
      splash.hideSplash();
      splash.hideSplash();
      jest.advanceTimersByTime(splash.SPLASH_MAX_MS);
      expect(mockSplash.hideAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('hides after the safety timeout when start-up never finishes', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module state per test
      const splash = require('../splash') as typeof import('../splash');
      splash.keepSplashUntilReady();
      jest.advanceTimersByTime(splash.SPLASH_MAX_MS - 1);
      expect(mockSplash.hideAsync).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mockSplash.hideAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('reports "splash finished" once marked (idempotent)', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module state per test
      const splash = require('../splash') as typeof import('../splash');
      expect(splash.isSplashFinished()).toBe(false);
      splash.markSplashFinished();
      splash.markSplashFinished();
      expect(splash.isSplashFinished()).toBe(true);
    });
  });
});
