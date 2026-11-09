/**
 * FinTS connector: authentication (fetching is added separately).
 *
 * Auth algorithm (the connector decides, the port only executes):
 *  1. `openFirstTime` + `synchronize()` fetches BPD/UPD. A PIN/lock answer code -> declined; any
 *     other failure (and every FinTSPortError) -> plain `Error('fints_failed')` (mapped to 502).
 *  2. TAN method: `config.tanMethodId` if available, else decoupled > code > photo. chipTAN
 *     (flicker) is never selected (cannot be rendered); only that -> declined.
 *  3. `selectTanMethod` + `synchronize()`; a TAN demand becomes a challenge: decoupled
 *     (`pollAfterMs` 3000), code, or image (PNG or JPEG with its
 *     mime type; other photo formats are declined).
 *  4. After sync, a 3-day statements probe on the first checking/credit-card account; if the bank
 *     wants a TAN for it, a second challenge is raised so the user's SCA covers account access
 *     (PSD2 90-day exemption for later unattended fetches).
 *  5. Done: state `{ bankingInformation, tanMethodId, systemId, credentials }`, consent expires in
 *     90 days. The connector interface hands only `state` to `listAccounts`/`fetchTransactions`
 *     (no config), so the credentials (bank, user id, PIN) travel in the state, which is stored
 *     encrypted like the config.
 *
 * Fetching (unattended, never throws for bank-side problems, never leaves a dialog open):
 * - `from = since ?? today - 89 days`, clamped to the 89-day SCA-exempt window; `today` is the
 *   Europe/Berlin calendar date of `ctx.now()` (the bank's calendar).
 * - TAN demanded or PIN error -> `needs_attention`; any other port error -> `temporary`; a state
 *   that cannot be opened (corrupt BPD, missing credentials, unknown account) -> `needs_attention`.
 * - Parse failures (flagged by our lib-fints patch, surfaced as a port `decode` error) are
 *   `temporary`, never an empty success.
 *
 * The live bank session sits in the in-process dialog registry; the persisted DialogState only
 * carries the opaque handle and bookkeeping. PIN and user id never leave the port call.
 *
 * Bank answer codes (FinTS 3.0 spec, not defined by lib-fints):
 * - 9910, 9931, 9942, 3938: wrong PIN / user id, or locked access (controller ruling P2-R2).
 * - 9940 (TAN entwertet), 9941 (TAN ungueltig): the TAN was rejected.
 * Bank answer text is never put into errors; only the sanitised `tanChallenge` reaches the user.
 */
import { Temporal } from 'temporal-polyfill';
import { money } from '@budgedino/shared';
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
  type FetchResult,
  type ProviderAccount,
  type ConnectorState,
} from '../types.js';
import { FINTS_BANKS } from './banks.js';
import { fintsConfigSchema } from './config.js';
import type { DialogMeta, FinTSDialogRegistry } from './dialogs.js';
import { accountRef, mapAccount, mapTx, toMinor } from './map.js';
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
const BANK_TIME_ZONE = 'Europe/Berlin';
/** Longest unattended look-back: stays inside the PSD2 90-day SCA exemption. */
const MAX_LOOKBACK_DAYS = 89;

type Step = DialogMeta['step'];
type ChallengeKindUsed = 'decoupled' | 'code' | 'image';

interface PersistedDialog {
  handle: string;
  kind: ChallengeKindUsed;
  step: Step;
  attempts: number;
  tanMethodId: number;
}

interface Credentials {
  bank: keyof typeof FINTS_BANKS;
  userId: string;
  pin: string;
}

type StoredState = { bankingInformation: unknown; tanMethodId: number; credentials: Credentials };

/** Reads and validates what the done state carries; undefined when unusable. */
function readState(state: ConnectorState): StoredState | undefined {
  const { bankingInformation, tanMethodId, credentials } = state;
  if (typeof tanMethodId !== 'number' || bankingInformation === undefined) return undefined;
  if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials))
    return undefined;
  const { bank, userId, pin } = credentials;
  if (typeof bank !== 'string' || !Object.hasOwn(FINTS_BANKS, bank)) return undefined;
  if (typeof userId !== 'string' || typeof pin !== 'string') return undefined;
  return {
    bankingInformation,
    tanMethodId,
    credentials: { bank: bank as Credentials['bank'], userId, pin },
  };
}

/** A JS Date at host-local midnight of a calendar date (lib-fints reads dates with local getters). */
const localMidnight = (d: Temporal.PlainDate): Date => new Date(d.year, d.month - 1, d.day);

const bankDate = (instant: Date): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(BANK_TIME_ZONE)
    .toPlainDate();

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
  /** Credentials of live auth sessions (in-process only), so the done state can carry them. */
  const sessionCredentials = new WeakMap<FinTSSession, Credentials>();

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
      const mime = r.tanPhoto.mimeType;
      if (mime !== 'image/png' && mime !== 'image/jpeg')
        throw new ConnectorAuthError('declined', 'unsupported photoTAN format');
      return {
        kind: 'image',
        challenge: {
          kind: 'image',
          message: message || 'Scan the image and enter the TAN',
          imageBase64: Buffer.from(r.tanPhoto.data).toString('base64'),
          mimeType: mime,
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
    extra: Pick<DialogMeta, 'accountRef' | 'probe'>,
    ctx: ConnectorContext,
  ): AuthStep => {
    if (!r.tanReference) throw failed();
    const { challenge, kind } = toChallenge(tanMethod.kind, r);
    const meta: DialogMeta = {
      step,
      tanReference: r.tanReference,
      startedAt: ctx.now().toISOString(),
    };
    if (extra.accountRef) meta.accountRef = extra.accountRef;
    if (extra.probe) meta.probe = extra.probe;
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
    const credentials = sessionCredentials.get(session);
    if (!credentials) throw failed();
    return {
      done: true,
      state: {
        bankingInformation: info as Json,
        tanMethodId,
        systemId: typeof systemId === 'string' ? systemId : null,
        credentials: { ...credentials },
      },
      consentExpiresAt: new Date(ctx.now().getTime() + CONSENT_MS),
    };
  };

  const accountKey = (a: FinTSAccount): string => a.iban ?? a.accountNumber;

  const runProbe = (session: FinTSSession, acc: FinTSAccount, ctx: ConnectorContext) => {
    const from = new Date(ctx.now().getTime() - PROBE_MS);
    return guard(() =>
      acc.accountType === 'CreditCardAccount'
        ? session.getCreditCardStatements(acc, from)
        : session.getStatements(acc, from, ctx.now()),
    );
  };

  const probeExtra = (acc: FinTSAccount): Pick<DialogMeta, 'accountRef' | 'probe'> => ({
    accountRef: accountKey(acc),
    probe: acc.accountType === 'CreditCardAccount' ? 'credit-card' : 'statements',
  });

  /** Handles a probe response: challenge, finish, or failure. */
  const probeOutcome = (
    session: FinTSSession,
    acc: FinTSAccount,
    r: FinTSPortResponse,
    tanMethod: { id: number; kind: FinTSTanKind },
    attempts: number,
    ctx: ConnectorContext,
  ): AuthStep => {
    checkPinErrors(r);
    if (r.requiresTan)
      return raise(session, r, 'statements-probe', tanMethod, attempts, probeExtra(acc), ctx);
    if (!r.success) throw failed();
    return finish(session, tanMethod.id, ctx);
  };

  /** After a successful sync: run the statements probe, else finish. */
  const afterSync = async (
    session: FinTSSession,
    tanMethod: { id: number; kind: FinTSTanKind },
    ctx: ConnectorContext,
  ): Promise<AuthStep> => {
    const acc = probeAccount(session);
    if (!acc) return finish(session, tanMethod.id, ctx);
    return probeOutcome(session, acc, await runProbe(session, acc, ctx), tanMethod, 0, ctx);
  };

  const openStored = (stored: StoredState): FinTSSession => {
    const bank = FINTS_BANKS[stored.credentials.bank];
    return port.openFromState(
      {
        productId: product.id,
        productVersion: product.version,
        url: bank.url,
        blz: bank.blz,
        userId: stored.credentials.userId,
        pin: stored.credentials.pin,
      },
      stored.bankingInformation,
      stored.tanMethodId,
    );
  };

  /** Best effort: any failure (including a TAN demand) just means no balance this time. */
  const fetchBalance = async (session: FinTSSession, acc: FinTSAccount) => {
    try {
      const b = await session.getBalance(acc);
      if (!b.success || b.requiresTan || !b.balance) return undefined;
      return money(toMinor(b.balance.value, b.balance.currency), b.balance.currency);
    } catch {
      return undefined;
    }
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
      sessionCredentials.set(session, { bank: cfg.bank, userId: cfg.userId, pin: cfg.pin });
      const first = await guard(() => session.synchronize());
      checkPinErrors(first);
      if (!first.success || first.requiresTan) throw failed();

      const tanMethod = pickTanMethod(session, cfg.tanMethodId);
      session.selectTanMethod(tanMethod.id);
      const r = await guard(() => session.synchronize());
      checkPinErrors(r);
      if (r.requiresTan) return raise(session, r, 'sync', tanMethod, 0, {}, ctx);
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

      const r = await guard(() => {
        if (d.step === 'sync') return session.synchronizeWithTan(meta.tanReference, tan);
        return meta.probe === 'credit-card'
          ? session.getCreditCardStatementsWithTan(meta.tanReference, tan)
          : session.getStatementsWithTan(meta.tanReference, tan);
      });
      checkPinErrors(r);

      const extra: Pick<DialogMeta, 'accountRef' | 'probe'> = {};
      if (meta.accountRef) extra.accountRef = meta.accountRef;
      if (meta.probe) extra.probe = meta.probe;
      if (r.requiresTan) {
        // Decoupled: still pending (same challenge). Otherwise a follow-up TAN.
        return raise(session, r, d.step, tanMethod, d.attempts, extra, ctx);
      }
      if (!r.success) {
        if (!tanRejected(r)) throw failed();
        if (d.kind === 'decoupled') throw new ConnectorAuthError('declined');
        const attempts = d.attempts + 1;
        if (attempts >= MAX_TAN_ATTEMPTS) throw new ConnectorAuthError('too_many_attempts');
        // The bank may have ended the dialog on a wrong TAN, so never retry the same reference:
        // restart the order on the session for a fresh reference (and a fresh photo).
        if (d.step === 'sync') {
          const again = await guard(() => session.synchronize());
          checkPinErrors(again);
          if (again.requiresTan) return raise(session, again, 'sync', tanMethod, attempts, {}, ctx);
          if (!again.success) throw failed();
          return afterSync(session, tanMethod, ctx);
        }
        const acc = session.accounts().find((a) => accountKey(a) === meta.accountRef);
        if (!acc) throw failed();
        return probeOutcome(
          session,
          acc,
          await runProbe(session, acc, ctx),
          tanMethod,
          attempts,
          ctx,
        );
      }
      if (d.step === 'sync') return afterSync(session, tanMethod, ctx);
      return finish(session, d.tanMethodId, ctx);
    },

    async cancelAuth(dialog) {
      const handle = (dialog as { handle?: unknown }).handle;
      if (typeof handle === 'string') dialogs.drop(handle);
    },

    async listAccounts(state): Promise<ProviderAccount[]> {
      const stored = readState(state);
      if (!stored) throw failed();
      return guard(() => openStored(stored).accounts().map(mapAccount));
    },

    async fetchTransactions(state, ref, since, ctx): Promise<FetchResult> {
      const stored = readState(state);
      if (!stored) return { ok: false, reason: 'needs_attention', state };
      const fail = (reason: 'needs_attention' | 'temporary'): FetchResult => ({
        ok: false,
        reason,
        state,
      });
      try {
        const session = openStored(stored);
        const acc = session.accounts().find((a) => accountRef(a) === ref);
        if (!acc) return fail('needs_attention');
        if (acc.accountType === 'SecuritiesAccount') return { ok: true, transactions: [], state };

        const today = bankDate(ctx.now());
        const earliest = today.subtract({ days: MAX_LOOKBACK_DAYS });
        let from = since ? bankDate(since) : earliest;
        if (Temporal.PlainDate.compare(from, earliest) < 0) from = earliest;
        if (Temporal.PlainDate.compare(from, today) > 0) from = today;
        const fromDate = localMidnight(from);
        const r =
          acc.accountType === 'CreditCardAccount'
            ? await session.getCreditCardStatements(acc, fromDate)
            : await session.getStatements(acc, fromDate, localMidnight(today));
        if (r.bankAnswers.some((a) => PIN_ERROR_CODES.has(a.code))) return fail('needs_attention');
        // PSD2 SCA renewal: never an interactive dialog from here; the user renews via re-auth.
        if (r.requiresTan) return fail('needs_attention');
        if (!r.success) return fail('temporary');

        const currency = acc.currency ?? 'EUR';
        const transactions = (r.transactions ?? []).map((t) => mapTx(t, currency));
        const balance = await fetchBalance(session, acc);
        const next: ConnectorState = r.bankingInformationUpdated
          ? { ...state, bankingInformation: session.bankingInformation() as Json }
          : state;
        const out: FetchResult = { ok: true, transactions, state: next };
        if (balance) out.balance = balance;
        return out;
      } catch (e) {
        if (e instanceof FinTSPortError)
          return fail(e.category === 'config' ? 'needs_attention' : 'temporary');
        throw e;
      }
    },
  };
}
