/**
 * Error with an HTTP status and a stable machine-readable code. The message is client-facing: it must
 * never contain request data or details that distinguish e.g. "unknown email" from "wrong password".
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized', 'Authentication required');
export const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'Invalid credentials');
export const forbidden = () => new HttpError(403, 'forbidden', 'Not allowed');
export const inviteInvalid = () =>
  new HttpError(410, 'invite_invalid', 'This invitation is invalid, expired or already used');
