import { z } from 'zod';
import { role } from './common';

export const createInviteRequest = z.object({ role: role.default('member') });
export type CreateInviteRequest = z.infer<typeof createInviteRequest>;

export const createInviteResponse = z.object({
  inviteToken: z.string(),
  expiresAt: z.iso.datetime(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponse>;
