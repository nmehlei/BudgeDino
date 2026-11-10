import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { getSessionStore } from '../session/instance';
import {
  clearNotificationState,
  ensureNotificationChannel,
  pollNotifications,
  registerNotificationTask,
} from './poll-task';
import { useNotificationPermission } from './useNotificationPermission';

/**
 * Renders nothing. While the user is signed in: asks for the notification permission once, sets up the
 * channel and the periodic background task, and polls on mount and whenever the app returns to the
 * foreground (through the same guarded function the background task uses).
 */
export function NotificationPoller() {
  const { status, request } = useNotificationPermission();

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: () =>
        Promise.resolve({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
    });
    void ensureNotificationChannel().catch(() => undefined);
    void registerNotificationTask().catch(() => undefined);
    void pollNotifications();
    const offSignOut = getSessionStore().onSignOut(() => clearNotificationState());
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void pollNotifications();
    });
    return () => {
      sub.remove();
      offSignOut();
    };
  }, []);

  useEffect(() => {
    if (status === 'undetermined') void request();
  }, [status, request]);

  return null;
}
