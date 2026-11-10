import { render, screen } from '@testing-library/react-native';

import Home from '../../app/(app)/_layout';
import { AppProviders } from '../providers';

jest.mock('react-native-mmkv', () => {
  const make = () => {
    const data = new Map<string, string>();
    return {
      getString: (k: string) => data.get(k),
      set: (k: string, v: string) => data.set(k, v),
      remove: (k: string) => data.delete(k),
      clearAll: () => data.clear(),
    };
  };
  return { createMMKV: jest.fn(make), deleteMMKV: jest.fn() };
});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
}));
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ...jest.requireActual<object>('./support/router-theme'),
    Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
    Tabs: Object.assign(() => null, { Screen: () => null }),
  };
});
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));

describe('app shell', () => {
  it('routes a fresh install (no server, no token) to the server screen once the cache is open', async () => {
    await render(
      <AppProviders>
        <Home />
      </AppProviders>,
    );
    expect(await screen.findByText('redirect:/(auth)/server')).toBeTruthy();
  });
});
