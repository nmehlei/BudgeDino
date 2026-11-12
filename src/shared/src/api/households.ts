import { z } from 'zod';
import { role } from './common';

export const createInviteRequest = z.object({ role: role.default('member') });
export type CreateInviteRequest = z.infer<typeof createInviteRequest>;

export const createInviteResponse = z.object({
  inviteToken: z.string(),
  expiresAt: z.iso.datetime(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponse>;

export const householdMember = z.object({
  id: z.uuid(),
  displayName: z.string(),
  role,
  joinedAt: z.iso.datetime(),
  isSelf: z.boolean(),
  disabled: z.boolean(),
  email: z.string().optional().describe('Only present when the caller is an admin.'),
});
export type HouseholdMember = z.infer<typeof householdMember>;

export const membersResponse = z.object({ members: z.array(householdMember) });
export type MembersResponse = z.infer<typeof membersResponse>;

export const pendingInvite = z.object({
  id: z.uuid(),
  role,
  expiresAt: z.iso.datetime(),
});
export type PendingInvite = z.infer<typeof pendingInvite>;

export const invitesResponse = z.object({ invites: z.array(pendingInvite) });
export type InvitesResponse = z.infer<typeof invitesResponse>;

export const inviteIdParams = z.object({ id: z.uuid() });
