/**
 * FinTS connector: authentication (fetching is added separately).
 *
 * Auth algorithm (the connector decides, the port only executes):
 *  1. `openFirstTime` + `synchronize()` fetches BPD/UPD. A PIN/lock answer code -> declined; any
 *     other failure (and every FinTSPortError) -> plain `Error('fints_failed')` (mapped to 502).
 *  2. TAN method: `config.tanMethodId` if available, else decoupled > code > photo. chipTAN
 *     (flicker) is never selected (cannot be rendered); only that -> declined.
 *  3. `selectTanMethod` + `synchronize()`; a TAN demand becomes a challenge: decoupled
 *     (`pollAfterMs` 3000), code, or image (PNG only: the shared challenge carries
 *     `imagePngBase64`, so other photo formats are declined).
 *  4. After sync, a 3-day statements probe on the first checking/credit-card account; if the bank
 *     wants a TAN for it, a second challenge is raised so the user's SCA covers account access
 *     (PSD2 90-day exemption for later unattended fetches).
 *  5. Done: state `{ bankingInformation, tanMethodId, systemId }`, consent expires in 90 days.
 *
 * The live bank session sits in the in-process dialog registry; the persisted DialogState only
 * carries the opaque handle and bookkeeping. PIN and user id never leave the port call.
 *
 * Bank answer codes (FinTS 3.0 spec, not defined by lib-fints):
 * - 9910, 9931, 9942, 3938: wrong PIN / user id, or locked access (controller ruling P2-R2).
 * - 9940 (TAN entwertet), 9941 (TAN ungueltig): the TAN was rejected.
 * Bank answer text is never put into errors; only the sanitised `tanChallenge` reaches the user.
 */
import type { Json } from '../types.js';
import {
  ConnectorAuthError,
  InvalidAnswerError,
  type AuthStep,
  type Challenge,
  type ChallengeAnswer,
  type Connector,
  type ConnectorConfig,
  type ConnectorContext,
  type DialogState,
} from '../types.js';
import { FINTS_BANKS } from './banks.js';
import { fintsConfigSchema } from './config.js';
import type { DialogMeta, FinTSDialogRegistry } from './dialogs.js';
import {
  FinTSPortError,
  type FinTSAccount,
  type FinTSBankParams,
  type FinTSPort,
  type FinTSPortResponse,
  type FinTSSession,
  type FinTSTanKind,
} from './port.js';

export interface FinTSConnectorDeps {
  port: FinTSPort;
  dialogs: FinTSDialogRegistry;
  product: { id: string; version: string };
}

const PIN_ERROR_CODES = new Set([9910, 9931, 9942, 3938]);
const TAN_REJECTED_CODES = new Set([9940, 9941]);
const MAX_TAN_ATTEMPTS = 3;
const DECOUPLED_POLL_MS = 3000;
const DIALOG_TTL_MS = 10 * 60_000;
const CONSENT_MS = 90 * 86_400_000;
const PROBE_MS = 3 * 86_400_000;
const MAX_MESSAGE = 200;

type Step = DialogMeta['step'];
type ChallengeKindUsed = 'decoupled' | 'code' | 'image';

interface PersistedDialog {
  handle: string;
  kind: ChallengeKindUsed;
  step: Step;
  attempts: number;
  tanMethodId: number;
}

const failed = (): Error => new Error('fints_failed');

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FinTSPortError) throw failed();
    throw e;
  }
}

function sanitise(text: string | undefined): string {
  if (!text) return '';
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

function checkPinErrors(r: FinTSPortResponse): void {
  if (r.bankAnswers.some((a) => PIN_ERROR_CODES.has(a.code)))
    throw new ConnectorAuthError('declined');
}

const tanRejected = (r: FinTSPortResponse): boolean =>
  r.bankAnswers.some((a) => TAN_REJECTED_CODES.has(a.code));

function pickTanMethod(
  session: FinTSSession,
  wanted: number | undefined,
): { id: number; kind: FinTSTanKind } {
  const methods = session.availableTanMethods();
  const explicit = wanted === undefined ? undefined : methods.find((m) => m.id === wanted);
  if (explicit) {
    if (explicit.kind === 'chiptan-optical')
      throw new ConnectorAuthError('declined', 'no supported TAN method');
    return explicit;
  }
  for (const kind of ['decoupled', 'code', 'photo'] as const) {
    const m = methods.find((x) => x.kind === kind);
    if (m) return m;
  }
  throw new ConnectorAuthError('declined', 'no supported TAN method');
}

function probeAccount(session: FinTSSession): FinTSAccount | undefined {
  return session
    .accounts()
    .find((a) => a.accountType === 'CheckingAccount' || a.accountType === 'CreditCardAccount');
}

function readDialog(dialog: DialogState): PersistedDialog | undefined {
  const { handle, kind, step, attempts, tanMethodId } = dialog;
  if (
    typeof handle !== 'string' ||
    (kind !== 'decoupled' && kind !== 'code' && kind !== 'image') ||
    (step !== 'sync' && step !== 'statements-probe') ||
    typeof attempts !== 'number' ||
    typeof tanMethodId !== 'number'
  )
    return undefined;
  return { handle, kind, step, attempts, tanMethodId };
}

export function createFinTSConnector(deps: FinTSConnectorDeps): Connector {
  const { port, dialogs, product } = deps;

  const toChallenge = (
    methodKind: FinTSTanKind,
    r: FinTSPortResponse,
  ): { challenge: Challenge; kind: ChallengeKindUsed } => {
    const message = sanitise(r.tanChallenge);
    if (methodKind === 'decoupled')
      return {
        kind: 'decoupled',
        challenge: {
          kind: 'decoupled',
          message: message || 'Confirm in your banking app',
          pollAfterMs: DECOUPLED_POLL_MS,
        },
      };
    if (r.tanPhoto) {
      if (r.tanPhoto.mimeType !== 'image/png')
        throw new ConnectorAuthError('declined', 'unsupported photoTAN format');
      return {
        kind: 'image',
        challenge: {
          kind: 'image',
          message: message || 'Scan the image and enter the TAN',
          imagePngBase64: Buffer.from(r.tanPhoto.data).toString('base64'),
        },
      };
    }
    if (methodKind === 'photo') throw failed();
    return {
      kind: 'code',
      challenge: { kind: 'code', message: message || 'Enter the TAN' },
    };
  };

  const raise = (
    session: FinTSSession,
    r: FinTSPortResponse,
    step: Step,
    tanMethod: { id: number; kind: FinTSTanKind },
    attempts: number,
    accountRef: string | undefined,
    ctx: ConnectorContext,
  ): AuthStep => {
    if (!r.tanReference) throw failed();
    const { challenge, kind } = toChallenge(tanMethod.kind, r);
    const meta: DialogMeta = {
      step,
      tanReference: r.tanReference,
      startedAt: ctx.now().toISOString(),
    };
    if (accountRef) meta.accountRef = accountRef;
    const handle = dialogs.put(session, meta);
    const dialog: PersistedDialog = { handle, kind, step, attempts, tanMethodId: tanMethod.id };
    return {
      done: false,
      challenge,
      dialog: dialog as unknown as DialogState,
      expiresAt: new Date(ctx.now().getTime() + DIALOG_TTL_MS),
    };
  };

  const finish = (session: FinTSSession, tanMethodId: number, ctx: ConnectorContext): AuthStep => {
    const info = session.bankingInformation();
    const systemId = (info as { systemId?: unknown } | null)?.systemId;
    return {
      done: true,
      state: {
        bankingInformation: info as Json,
        tanMethodId,
        systemId: typeof systemId === 'string' ? systemId : null,
      },
      consentExpiresAt: new Date(ctx.now().getTime() + CONSENT_MS),
    };
  };

  /** After a successful sync: run the statements probe, else finish. */
  const afterSync = async (
    session: FinTSSession,
    tanMethod: { id: number; kind: FinTSTanKind },
    ctx: ConnectorContext,
  ): Promise<AuthStep> => {
    const acc = probeAccount(session);
    if (!acc) return finish(session, tanMethod.id, ctx);
    const from = new Date(ctx.now().getTime() - PROBE_MS);
    const r = await guard(() =>
      acc.accountType === 'CreditCardAccount'
        ? session.getCreditCardStatements(acc, from)
        : session.getStatements(acc, from, ctx.now()),
    );
    checkPinErrors(r);
    if (r.requiresTan)
      return raise(
        session,
        r,
        'statements-probe',
        tanMethod,
        0,
        acc.iban ?? acc.accountNumber,
        ctx,
      );
    if (!r.success) throw failed();
    return finish(session, tanMethod.id, ctx);
  };

  return {
    type: 'fints',
    experimental: false,
    challengeKinds: ['decoupled', 'code', 'image'],
    configSchema: fintsConfigSchema,
    rateLimit: { maxUnattendedPerDay: null, defaultSchedule: { cron: '0 */4 * * *' } },

    async startAuth(rawConfig: ConnectorConfig, ctx) {
      const cfg = fintsConfigSchema.parse(rawConfig);
      const bank = FINTS_BANKS[cfg.bank];
      const params: FinTSBankParams = {
        productId: product.id,
        productVersion: product.version,
        url: bank.url,
        blz: bank.blz,
        userId: cfg.userId,
        pin: cfg.pin,
      };
      const session = await guard(() => port.openFirstTime(params));
      const first = await guard(() => session.synchronize());
      checkPinErrors(first);
      if (!first.success || first.requiresTan) throw failed();

      const tanMethod = pickTanMethod(session, cfg.tanMethodId);
      session.selectTanMethod(tanMethod.id);
      const r = await guard(() => session.synchronize());
      checkPinErrors(r);
      if (r.requiresTan) return raise(session, r, 'sync', tanMethod, 0, undefined, ctx);
      if (!r.success) throw failed();
      return afterSync(session, tanMethod, ctx);
    },

    async continueAuth(dialog, answer: ChallengeAnswer, ctx) {
      const d = readDialog(dialog);
      if (!d) throw new ConnectorAuthError('timeout');
      // Validate before taking, so a client mistake leaves the live session in place.
      if (
        d.kind === 'decoupled'
          ? answer.kind !== 'decoupled'
          : answer.kind === 'decoupled' || answer.kind === 'redirect'
      )
        throw new InvalidAnswerError();
      const entry = dialogs.take(d.handle);
      if (!entry) throw new ConnectorAuthError('timeout');
      const { session, meta } = entry;
      const tan =
        answer.kind === 'code' || answer.kind === 'image' ? answer.code.trim() : undefined;
      const method = session.availableTanMethods().find((m) => m.id === d.tanMethodId);
      const tanMethod = { id: d.tanMethodId, kind: method?.kind ?? ('code' as FinTSTanKind) };

      const r = await guard(() =>
        d.step === 'sync'
          ? session.synchronizeWithTan(meta.tanReference, tan)
          : session.getStatementsWithTan(meta.tanReference, tan),
      );
      checkPinErrors(r);

      if (r.requiresTan) {
        // Decoupled: still pending (same challenge). Otherwise a follow-up TAN.
        return raise(session, r, d.step, tanMethod, d.attempts, meta.accountRef, ctx);
      }
      if (!r.success) {
        if (!tanRejected(r)) throw failed();
        if (d.kind === 'decoupled') throw new ConnectorAuthError('declined');
        const attempts = d.attempts + 1;
        if (attempts >= MAX_TAN_ATTEMPTS) throw new ConnectorAuthError('too_many_attempts');
        // Re-challenge with a fresh code prompt; the same bank TAN reference stays in use.
        const handle = dialogs.put(session, meta);
        const persisted: PersistedDialog = {
          handle,
          kind: d.kind,
          step: d.step,
          attempts,
          tanMethodId: d.tanMethodId,
        };
        // A rejected photoTAN is re-asked as a plain code prompt (the image is not re-sent).
        const retryChallenge: Challenge = {
          kind: 'code',
          message: 'The TAN was not accepted. Enter it again',
        };
        persisted.kind = 'code';
        return {
          done: false,
          challenge: retryChallenge,
          dialog: persisted as unknown as DialogState,
          expiresAt: new Date(ctx.now().getTime() + DIALOG_TTL_MS),
        };
      }
      if (d.step === 'sync') return afterSync(session, tanMethod, ctx);
      return finish(session, d.tanMethodId, ctx);
    },

    async cancelAuth(dialog) {
      const handle = (dialog as { handle?: unknown }).handle;
      if (typeof handle === 'string') dialogs.drop(handle);
    },

    async listAccounts() {
      throw new Error('fints listAccounts not implemented');
    },

    async fetchTransactions() {
      throw new Error('fints fetchTransactions not implemented');
    },
  };
}
