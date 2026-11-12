import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';

import { ensureNotificationChannel } from './poll-task';

export type NotificationPermission = 'unknown' | 'granted' | 'denied' | 'undetermined';

function fromResponse(res: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (res.granted) return 'granted';
  return res.canAskAgain ? 'undetermined' : 'denied';
}

/**
 * The POST_NOTIFICATIONS permission (Android 13+). `request()` creates the channel first, which
 * Android requires before it shows the permission prompt.
 */
export function useNotificationPermission() {
  const [status, setStatus] = useState<NotificationPermission>('unknown');

  useEffect(() => {
    let cancelled = false;
    Notifications.getPermissionsAsync().then(
      (res) => {
        if (!cancelled) setStatus(fromResponse(res));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const request = useCallback(async () => {
    try {
      await ensureNotificationChannel();
      setStatus(fromResponse(await Notifications.requestPermissionsAsync()));
    } catch {
      // Leave the status as it was; the Settings row stays available.
    }
  }, []);

  return { status, request };
}
