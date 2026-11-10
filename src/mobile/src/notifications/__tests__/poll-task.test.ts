import type { NotificationsResponse } from '@budgedino/shared';
import * as mockNotifications from 'expo-notifications';
import * as mockBackgroundTask from 'expo-background-task';
import * as mockTaskManager from 'expo-task-manager';

import { createApiClient } from '../../api/client';
import {
  createSessionStore,
  type PrefsStorage,
  type TokenStorage,
} from '../../session/session-store';
import {
  clearNotificationState,
  defineNotificationTask,
  NOTIFICATION_TASK,
  pollNotifications,
  registerNotificationTask,
  type PollApi,
  type PollDeps,
} from '../poll-task';

let mockDefaultStore: unknown;
let mockDefaultApi: unknown;
jest.mock('../../session/instance', () => ({
  getSessionStore: () => mockDefaultStore,
  createSessionApiClient: () => mockDefaultApi,
}));
jest.mock('react-native-mmkv', () => ({ createMMKV: jest.fn(), deleteMMKV: jest.fn() }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-notifications', () => ({ dismissAllNotificationsAsync: jest.fn() }));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(),
}));
jest.mock('expo-background-task', () => ({
  getStatusAsync: jest.fn(),
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
}));

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const item = (id: string, body: string | null = 'Budget Food is at 90 %') => ({
  id,
  kind: 'budget',
  body,
  createdAt: '2026-11-09T10:00:00.000Z',
});

function setup(signedIn = true) {
  const prefs = new Map<string, string>([['serverUrl', 'https://budget.example.test']]);
  let secret: string | null = signedIn ? 'tok' : null;
  const prefsStorage: PrefsStorage = {
    getString: (k) => prefs.get(k),
    set: (k, v) => void prefs.set(k, v),
    remove: (k) => void prefs.delete(k),
  };
  const token: TokenStorage = {
    get: async () => secret,
    set: async (t) => void (secret = t),
    remove: async () => void (secret = null),
  };
  const store = createSessionStore({ prefs: prefsStorage, token });
  return { store, readSecret: () => secret };
}

function deps(store: PollDeps['store'], api: Partial<PollApi>, show = jest.fn()) {
  const full: PollApi = {
    listNotifications: jest.fn(),
    ackNotifications: jest.fn().mockResolvedValue({ acked: 0 }),
    ...api,
  };
  show.mockResolvedValue(undefined);
  return { deps: { store, createApi: () => full, show } satisfies PollDeps, api: full, show };
}

const page = (...items: ReturnType<typeof item>[]): NotificationsResponse => ({
  notifications: items,
  nextCursor: null,
});

beforeEach(() => jest.clearAllMocks());

describe('pollNotifications', () => {
  it('shows one notification per item and acks exactly those ids', async () => {
    const { store } = setup();
    const d = deps(store, {
      listNotifications: jest.fn().mockResolvedValue(page(item(ID1), item(ID2))),
    });
    await expect(pollNotifications(d.deps)).resolves.toBe('delivered');
    expect(d.show).toHaveBeenCalledTimes(2);
    expect(d.show).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: ID1 }));
    expect(d.api.ackNotifications).toHaveBeenCalledTimes(1);
    expect(d.api.ackNotifications).toHaveBeenCalledWith([ID1, ID2]);
  });

  it('acks only what was shown; a failed one is retried next poll', async () => {
    const { store } = setup();
    const show = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const d = deps(store, {
      listNotifications: jest.fn().mockResolvedValue(page(item(ID1), item(ID2))),
    });
    d.deps.show = show;
    await expect(pollNotifications(d.deps)).resolves.toBe('failed');
    expect(d.api.ackNotifications).toHaveBeenCalledWith([ID2]);
  });

  it('does not ack when nothing arrived', async () => {
    const { store } = setup();
    const d = deps(store, { listNotifications: jest.fn().mockResolvedValue(page()) });
    await expect(pollNotifications(d.deps)).resolves.toBe('empty');
    expect(d.show).not.toHaveBeenCalled();
    expect(d.api.ackNotifications).not.toHaveBeenCalled();
  });

  it('is a no-op when signed out', async () => {
    const { store } = setup(false);
    const d = deps(store, { listNotifications: jest.fn() });
    await expect(pollNotifications(d.deps)).resolves.toBe('skipped');
    expect(d.api.listNotifications).not.toHaveBeenCalled();
  });

  it('signed out: unregisters the background task (best effort)', async () => {
    const { store } = setup(false);
    jest.mocked(mockBackgroundTask.unregisterTaskAsync).mockRejectedValue(new Error('x'));
    const d = deps(store, { listNotifications: jest.fn() });
    await expect(pollNotifications(d.deps)).resolves.toBe('skipped');
    expect(mockBackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(NOTIFICATION_TASK);
  });

  it('is a no-op without a server URL', async () => {
    const { store } = setup();
    const noServer = createSessionStore({
      prefs: { getString: () => undefined, set: jest.fn(), remove: jest.fn() },
      token: { get: async () => 'tok', set: jest.fn(), remove: jest.fn() },
    });
    const d = deps(noServer, { listNotifications: jest.fn() });
    await expect(pollNotifications(d.deps)).resolves.toBe('skipped');
    expect(store).toBeDefined();
  });

  it('a 401 inside the poll signs out and wipes the token', async () => {
    const { store, readSecret } = setup();
    const wipe = jest.fn();
    store.onSignOut(wipe);
    const fetchImpl = jest
      .fn()
      .mockResolvedValue({ status: 401, ok: false, headers: new Headers() });
    const client = createApiClient({
      baseUrl: 'https://budget.example.test',
      getToken: store.getToken,
      onUnauthorized: () => store.expireSession(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const show = jest.fn();
    await expect(pollNotifications({ store, createApi: () => client, show })).resolves.toBe(
      'failed',
    );
    expect(readSecret()).toBeNull();
    expect(store.getSnapshot().status).toBe('signed_out');
    expect(store.getSnapshot().expired).toBe(true);
    expect(wipe).toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it('a foreground and a background poll at once share one run (no double show or ack)', async () => {
    const { store } = setup();
    let release: (v: NotificationsResponse) => void = () => undefined;
    const d = deps(store, {
      listNotifications: jest.fn().mockReturnValue(new Promise((r) => (release = r))),
    });
    const first = pollNotifications(d.deps);
    const second = pollNotifications(d.deps);
    await Promise.resolve();
    release(page(item(ID1)));
    await expect(Promise.all([first, second])).resolves.toEqual(['delivered', 'delivered']);
    expect(d.api.listNotifications).toHaveBeenCalledTimes(1);
    expect(d.show).toHaveBeenCalledTimes(1);
    expect(d.api.ackNotifications).toHaveBeenCalledTimes(1);

    // The flag is released afterwards.
    d.api.listNotifications = jest.fn().mockResolvedValue(page());
    await expect(pollNotifications(d.deps)).resolves.toBe('empty');
  });
});

describe('background task wiring', () => {
  it('defines the task under its name and maps the poll result to Success/Failed', async () => {
    defineNotificationTask();
    expect(mockTaskManager.defineTask).toHaveBeenCalledWith(
      NOTIFICATION_TASK,
      expect.any(Function),
    );
    expect(NOTIFICATION_TASK).toBe('budgedino-notifications');
    const run = jest.mocked(mockTaskManager.defineTask).mock.calls[0]?.[1] as () => Promise<number>;
    const { store } = setup();
    mockDefaultStore = store;
    mockDefaultApi = {
      listNotifications: jest.fn().mockResolvedValue(page()),
      ackNotifications: jest.fn(),
    };
    await expect(run()).resolves.toBe(mockBackgroundTask.BackgroundTaskResult.Success);
    mockDefaultApi = { listNotifications: jest.fn().mockRejectedValue(new Error('x')) };
    await expect(run()).resolves.toBe(mockBackgroundTask.BackgroundTaskResult.Failed);
  });

  it('importing the define-task entry module defines the task', () => {
    jest.isolateModules(() => {
      jest.requireActual('../define-task');
    });
    expect(mockTaskManager.defineTask).toHaveBeenCalledWith(
      NOTIFICATION_TASK,
      expect.any(Function),
    );
  });

  it('sign-out cleanup unregisters the task and dismisses notifications, tolerating failures', async () => {
    jest.mocked(mockBackgroundTask.unregisterTaskAsync).mockRejectedValue(new Error('x'));
    jest.mocked(mockNotifications.dismissAllNotificationsAsync).mockResolvedValue(undefined);
    await expect(clearNotificationState()).resolves.toBeUndefined();
    expect(mockBackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(NOTIFICATION_TASK);
    expect(mockNotifications.dismissAllNotificationsAsync).toHaveBeenCalled();
  });

  it('registers with a 15 minute interval, once', async () => {
    jest.mocked(mockBackgroundTask.getStatusAsync).mockResolvedValue(2 as never);
    jest
      .mocked(mockTaskManager.isTaskRegisteredAsync)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await registerNotificationTask();
    await registerNotificationTask();
    expect(jest.mocked(mockBackgroundTask.registerTaskAsync)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(mockBackgroundTask.registerTaskAsync)).toHaveBeenCalledWith(
      NOTIFICATION_TASK,
      {
        minimumInterval: 15,
      },
    );
  });

  it('does not register when background tasks are restricted', async () => {
    jest.mocked(mockBackgroundTask.getStatusAsync).mockResolvedValue(1 as never);
    await registerNotificationTask();
    expect(jest.mocked(mockBackgroundTask.registerTaskAsync)).not.toHaveBeenCalled();
  });
});
