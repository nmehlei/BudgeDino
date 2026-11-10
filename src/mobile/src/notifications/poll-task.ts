import type { NotificationsResponse } from '@budgedino/shared';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { createSessionApiClient, getSessionStore } from '../session/instance';
import type { SessionStore } from '../session/session-store';

export const NOTIFICATION_TASK = 'budgedino-notifications';
export const NOTIFICATION_CHANNEL_ID = 'budget-connections';
export const NOTIFICATION_CHANNEL_NAME = 'Budget & connections';
export const NOTIFICATION_TITLE = 'BudgeDino';
/** expo-background-task minimum (minutes); Android WorkManager does not go below 15. */
export const POLL_INTERVAL_MINUTES = 15;

export type PollResult = 'skipped' | 'empty' | 'delivered' | 'failed';

export type ServerNotification = NotificationsResponse['notifications'][number];

export interface PollApi {
  listNotifications: () => Promise<NotificationsResponse>;
  ackNotifications: (ids: string[]) => Promise<unknown>;
}

export interface PollDeps {
  store: SessionStore;
  /** Builds the API client; throws when no server is configured. */
  createApi: (store: SessionStore) => PollApi;
  /** Shows one local notification. The server id is the identifier, so a re-delivery replaces it. */
  show: (item: ServerNotification) => Promise<void>;
}

export async function ensureNotificationChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
    name: NOTIFICATION_CHANNEL_NAME,
    importance: Notifications.AndroidImportance.DEFAULT,
    // Content stays off the lock screen; only the fact that something happened shows.
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

async function showLocalNotification(item: ServerNotification): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: item.id,
    content: { title: NOTIFICATION_TITLE, ...(item.body ? { body: item.body } : {}) },
    trigger: { channelId: NOTIFICATION_CHANNEL_ID },
  });
}

function defaultDeps(): PollDeps {
  return {
    store: getSessionStore(),
    createApi: (store) => createSessionApiClient(store),
    show: showLocalNotification,
  };
}

let inFlight: Promise<PollResult> | null = null;

/**
 * The one notification poll, shared by the foreground (app becomes active) and the background task.
 * Fetches `GET /notifications`, shows one local notification per item, then acks exactly the items
 * that were shown. While a poll runs, any further call joins it instead of starting a second one, so
 * nothing is shown or acked twice. Never logs notification content; a 401 signs the user out through
 * the API client.
 */
export function pollNotifications(deps?: PollDeps): Promise<PollResult> {
  inFlight ??= runPoll(deps ?? defaultDeps()).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runPoll({ store, createApi, show }: PollDeps): Promise<PollResult> {
  try {
    // The store may not be hydrated in a headless background run; the token read is authoritative.
    if (!store.getSnapshot().serverUrl || !(await store.getToken())) return 'skipped';
    const api = createApi(store);
    const { notifications } = await api.listNotifications();
    if (notifications.length === 0) return 'empty';

    const shown: string[] = [];
    for (const item of notifications) {
      try {
        await show(item);
        shown.push(item.id);
      } catch {
        // Not acked, so the next poll retries it.
      }
    }
    if (shown.length > 0) await api.ackNotifications(shown);
    return shown.length === notifications.length ? 'delivered' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Registers the headless task. Call at module scope of the entry layout (before React renders). */
export function defineNotificationTask(): void {
  TaskManager.defineTask(NOTIFICATION_TASK, async () => {
    const result = await pollNotifications();
    return result === 'failed'
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  });
}

/** Schedules the periodic background poll (idempotent). */
export async function registerNotificationTask(): Promise<void> {
  const status = await BackgroundTask.getStatusAsync();
  if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return;
  if (await TaskManager.isTaskRegisteredAsync(NOTIFICATION_TASK)) return;
  await BackgroundTask.registerTaskAsync(NOTIFICATION_TASK, {
    minimumInterval: POLL_INTERVAL_MINUTES,
  });
}
