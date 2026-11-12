import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { commitUrl, ISSUES_URL, LICENSE_URL, REPO_URL } from '../../links';
import { AboutScreen } from '../AboutScreen';
import { buildInfoFrom, type BuildInfo } from '../build-info';

const mockHealth = jest.fn();
let mockServerUrl: string | null = 'https://budget.example.com';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('../../auth/api', () => ({ createAuthApi: () => ({ health: mockHealth }) }));
jest.mock('../../session/useSession', () => ({
  useSession: () => ({ serverUrl: mockServerUrl }),
}));
jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<object>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const build: BuildInfo = { version: '0.1.2-feat-x.92', versionCode: 94, commit: '13e6798' };

async function renderAbout(info: BuildInfo = build) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <PaperProvider>
        <AboutScreen build={info} />
      </PaperProvider>
    </QueryClientProvider>,
  );
}

describe('buildInfoFrom', () => {
  it('reads version, versionCode and commit from the Expo config', () => {
    expect(
      buildInfoFrom({
        version: '1.2.3',
        android: { versionCode: 7 },
        extra: { commit: 'abc1234' },
      }),
    ).toEqual({ version: '1.2.3', versionCode: 7, commit: 'abc1234' });
  });

  it('degrades to unknown / null without a config', () => {
    expect(buildInfoFrom(null)).toEqual({ version: 'unknown', versionCode: null, commit: null });
    expect(buildInfoFrom({ extra: { commit: 'unknown' } }).commit).toBeNull();
  });
});

describe('commitUrl', () => {
  it('links hex SHAs only', () => {
    expect(commitUrl('13e6798')).toBe(`${REPO_URL}/commit/13e6798`);
    expect(commitUrl('../evil')).toBeNull();
    expect(commitUrl(null)).toBeNull();
  });
});

describe('AboutScreen', () => {
  let openURL: jest.SpyInstance;
  beforeEach(() => {
    mockServerUrl = 'https://budget.example.com';
    mockHealth.mockReset();
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  });
  afterEach(() => openURL.mockRestore());

  it('shows app version, build, commit and the server version', async () => {
    mockHealth.mockResolvedValue({ ok: true, version: '0.1.2' });
    await renderAbout();
    expect(screen.getByText('0.1.2-feat-x.92')).toBeTruthy();
    expect(screen.getByText('94')).toBeTruthy();
    expect(screen.getByText('13e6798')).toBeTruthy();
    expect(await screen.findByText('0.1.2')).toBeTruthy();
  });

  it('says when the server cannot be reached', async () => {
    mockHealth.mockRejectedValue(new Error('network'));
    await renderAbout();
    expect(await screen.findByText('Unreachable')).toBeTruthy();
  });

  it('opens GitHub pages for source, issues, license and the commit', async () => {
    mockHealth.mockResolvedValue({ ok: true, version: '0.1.2' });
    await renderAbout();
    await fireEvent.press(screen.getByTestId('about-source'));
    await fireEvent.press(screen.getByTestId('about-issues'));
    await fireEvent.press(screen.getByTestId('about-license'));
    await fireEvent.press(screen.getByTestId('about-commit'));
    expect(openURL.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      REPO_URL,
      ISSUES_URL,
      LICENSE_URL,
      `${REPO_URL}/commit/13e6798`,
    ]);
  });

  it('hides build and commit rows when unknown', async () => {
    mockServerUrl = null;
    await renderAbout({ version: 'unknown', versionCode: null, commit: null });
    expect(screen.queryByTestId('about-build')).toBeNull();
    expect(screen.queryByTestId('about-commit')).toBeNull();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(mockHealth).not.toHaveBeenCalled();
  });
});
