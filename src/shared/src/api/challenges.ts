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

/** A challenge as handed to the app: the typed challenge plus its id and expiry. Never the dialog. */
export const challengeView = z.intersection(
  challenge,
  z.object({ id: z.string(), expiresAt: z.iso.datetime() }),
);
export type ChallengeView = z.infer<typeof challengeView>;

export const challengeIdParams = z.object({ id: z.uuid() });

/** Externally visible challenge state (`answering` reads as `open`). */
export const challengeStatus = z.enum(['open', 'completed', 'cancelled', 'expired']);
export type ChallengeStatus = z.infer<typeof challengeStatus>;

/** `GET`/`DELETE /challenges/:id`: state only, the bank is never called. */
export const challengeStatusResponse = z.object({ status: challengeStatus });
export type ChallengeStatusResponse = z.infer<typeof challengeStatusResponse>;

/** `POST /challenges/:id/answer`. `challenge` is present while the dialog continues (`open`). */
export const challengeAnswerResponse = z.object({
  status: challengeStatus,
  /** Why the challenge ended without success, e.g. `declined`, `too_many_invalid_answers`. */
  reason: z.string().optional(),
  challenge: challengeView.optional(),
});
export type ChallengeAnswerResponse = z.infer<typeof challengeAnswerResponse>;
