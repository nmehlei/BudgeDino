import { z } from 'zod';

/** Typed bank challenges the app renders. Dialog state is server-side only and never appears here. */
export const challengeKind = z.enum(['redirect', 'decoupled', 'code', 'image']);
export type ChallengeKind = z.infer<typeof challengeKind>;

export const challenge = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redirect'), url: z.string(), returnUrlScheme: z.string() }),
  z.object({
    kind: z.literal('decoupled'),
    message: z.string(),
    pollAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('code'),
    message: z.string(),
    length: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal('image'), message: z.string(), imagePngBase64: z.string() }),
]);
export type Challenge = z.infer<typeof challenge>;

export const challengeAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redirect'), callbackUrl: z.string() }),
  z.object({ kind: z.literal('decoupled') }),
  z.object({ kind: z.literal('code'), code: z.string() }),
  z.object({ kind: z.literal('image'), code: z.string() }),
]);
export type ChallengeAnswer = z.infer<typeof challengeAnswer>;
