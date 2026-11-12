/**
 * The link an invite is shared as. The register screen prefills the server and token from it. Both values are
 * URL-encoded. The token is a secret: never log or persist the result.
 */
export function buildJoinLink(serverUrl: string, token: string): string {
  return `budgedino://register?server=${encodeURIComponent(serverUrl)}&invite=${encodeURIComponent(token)}`;
}
