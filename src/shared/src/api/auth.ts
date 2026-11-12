import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound protects the server from hashing huge inputs. */
export const PASSWORD_MAX_LENGTH = 256;

const totpCode = z.string().regex(/^\d{6}$/, 'must be 6 digits');

export const registerRequest = z.object({
  inviteToken: z.string().min(1).max(200),
  email: z.email().max(254),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(100),
  deviceName: z.string().trim().min(1).max(100),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const registerResponse = z.object({
  totpProvisioningUri: z.string(),
  pendingId: z.string(),
});
export type RegisterResponse = z.infer<typeof registerResponse>;

export const registerConfirmRequest = z.object({
  pendingId: z.string().min(1).max(200),
  totpCode,
});
export type RegisterConfirmRequest = z.infer<typeof registerConfirmRequest>;

export const sessionResponse = z.object({ sessionToken: z.string() });
export type SessionResponse = z.infer<typeof sessionResponse>;

/**
 * Deliberately lenient: every credential problem (missing/malformed TOTP code, wrong password,
 * unknown email) must surface as the same 401, never as a distinguishable 400.
 */
export const loginRequest = z.object({
  email: z.string().max(254),
  password: z.string().max(PASSWORD_MAX_LENGTH),
  totpCode: z.string().max(32).optional(),
  deviceName: z.string().trim().min(1).max(100),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const sessionInfo = z.object({
  id: z.string(),
  deviceName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;

export const sessionListResponse = z.object({ sessions: z.array(sessionInfo) });
export type SessionListResponse = z.infer<typeof sessionListResponse>;

export const sessionIdParams = z.object({ id: z.uuid() });
