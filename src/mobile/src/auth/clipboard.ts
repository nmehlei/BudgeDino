import * as Clipboard from 'expo-clipboard';

export const CLIPBOARD_CLEAR_MS = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Copies a secret and overwrites the clipboard with '' after about 60 s (best effort). The timer
 * lives at module scope on purpose: it must still fire after the screen was left. Copying again
 * resets it.
 */
export async function copySecretWithWipe(secret: string): Promise<void> {
  await Clipboard.setStringAsync(secret);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void Clipboard.setStringAsync('').catch(() => undefined);
  }, CLIPBOARD_CLEAR_MS);
}
