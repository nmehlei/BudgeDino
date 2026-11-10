import { Linking } from 'react-native';

/** The public GitHub repository (AGPL-3.0: the source of every build is published here). */
export const REPO_URL = 'https://github.com/nmehlei/BudgeDino';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
/** How to run your own server (the repository README links the self-hosting docs). */
export const SELF_HOSTING_URL = `${REPO_URL}#readme`;

/** Only plain hex SHAs become links; anything else (e.g. "unknown") has no commit page. */
export function commitUrl(commit: string | null): string | null {
  return commit && /^[0-9a-f]{7,40}$/.test(commit) ? `${REPO_URL}/commit/${commit}` : null;
}

/** Opens a URL in the browser; a device without one simply does nothing. */
export function openExternal(url: string): void {
  Linking.openURL(url).catch(() => undefined);
}
