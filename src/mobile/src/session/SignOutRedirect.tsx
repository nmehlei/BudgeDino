import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useSession } from './useSession';
import type { SessionStore } from './session-store';

/**
 * Sends the user to login when a signed-in session ends anywhere in the app (a 401 or a manual
 * sign-out). The login screen shows "Session expired" when the session store flagged it.
 * Renders nothing.
 */
export function SignOutRedirect({ store }: { store?: SessionStore }) {
  const router = useRouter();
  const { status, serverUrl } = useSession(store);
  const previous = useRef(status);

  useEffect(() => {
    if (previous.current === 'signed_in' && status === 'signed_out') {
      router.replace(serverUrl ? '/(auth)/login' : '/(auth)/server');
    }
    previous.current = status;
  }, [status, serverUrl, router]);

  return null;
}
