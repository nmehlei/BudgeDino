/**
 * FinTS connector: authentication (fetching is added separately).
 *
 * Auth algorithm (the connector decides, the port only executes):
 *  1. `openFirstTime` + `synchronize()` fetches BPD/UPD. A PIN/lock answer code -> declined; any
 *     other failure (and every FinTSPortError) -> plain `Error('fints_failed')` (mapped to 502).
 *  2. TAN method: `config.tanMethodId` if available, else decoupled > code > photo. chipTAN
 *     (flicker) is never selected (cannot be rendered); only that -> declined.
 *  3. `selectTanMethod` + `synchronize()`; a TAN demand becomes a challenge: decoupled
 *     (`pollAfterMs` from the BPD, clamped 2-10 s, default 3 s), code, or image (photoTAN methods
 *     only; PNG or JPEG with its mime type, other photo formats are declined).
 *  4. After sync a required TAN medium is selected (the single active one, else the first), then a
 *     3-day statements probe on the first checking account with statement support (else the first
 *     such credit card; none: no probe); if the bank wants a TAN for it, a second challenge is raised
 *     so the user's SCA covers account access (PSD2 90-day exemption for later unattended fetches).
 *  5. Done: state `{ bankingInformation, tanMethodId, tanMediaName?, systemId }`, consent expires in
 *     90 days. A transient failure while answering (network, 5xx, decode) restores the session under
 *     the same handle so the client can retry; terminal outcomes drop it.
 *     Credentials are never in the state; `listAccounts`/`fetchTransactions` get the decrypted
 *     config as their last argument (controller ruling P2-R7).
 *
 * Fetching (unattended, never throws for bank-side problems, never leaves a dialog open):
 * - `from = since ?? today - 89 days`, clamped to the 89-day SCA-exempt window; `today` is the
 *   Europe/Berlin calendar date of `ctx.now()` (the bank's calendar).
 * - TAN demanded, PIN error, any answer in 9930-9942 / 3938 or a rejected dialog init (lockout
 *   protection) -> `needs_attention`; a statements call the bank does not support -> empty success;
 *   any other port error -> `temporary`; a state
 *   that cannot be opened (corrupt BPD, missing/invalid config or state, unknown account) ->
 *   `needs_attention`.
 * - Exactly one bank order per fetch: the balance is the closing balance of the statement response
 *   (no separate balance order that could trigger a TAN push; controller ruling P2-R8).
 * - Dates sent to the bank are UTC-midnight Dates of the Berlin calendar date, because lib-fints
 *   encodes dates with `toISOString()`.
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
import { fintsConfigSchema, type FinTSConnectionConfig } from './config.js';
import type { DialogMeta, FinTSDialogEntry, FinTSDialogRegistry } from './dialogs.js';
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
/** Fetch: any answer in 9930-9942 (user/PIN/lock family) or 3938 must stop scheduled runs. */
const isAccessCode = (code: number): boolean =>
  PIN_ERROR_CODES.has(code) || (code >= 9930 && code <= 9942);
const TAN_REJECTED_CODES = new Set([9940, 9941]);
const MAX_TAN_ATTEMPTS = 3;
const DECOUPLED_POLL_DEFAULT_MS = 3000;
const DECOUPLED_POLL_MIN_S = 2;
const DECOUPLED_POLL_MAX_S = 10;
const DIALOG_TTL_MS = 10 * 60_000;
const CONSENT_MS = 90 * 86_400_000;
const PROBE_DAYS = 3;
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

interface StoredState {
  bankingInformation: unknown;
  tanMethodId: number;
  tanMediaName?: string;
}

/** A chosen TAN method with what the challenge needs from the bank's parameters. */
interface TanSel {
  id: number;
  kind: FinTSTanKind;
  decoupledWait?: { firstSeconds: number; betweenSeconds: number };
}

/** Reads what the done state carries; undefined when unusable. */
function readState(state: ConnectorState): StoredState | undefined {
  const { bankingInformation, tanMethodId, tanMediaName } = state;
  if (typeof tanMethodId !== 'number' || typeof bankingInformation !== 'object') return undefined;
  if (bankingInformation === null) return undefined;
  if (tanMediaName !== undefined && (typeof tanMediaName !== 'string' || !tanMediaName))
    return undefined;
  return { bankingInformation, tanMethodId, ...(tanMediaName ? { tanMediaName } : {}) };
}

/**
 * The Date lib-fints must receive for a calendar date: its `Dat` element encodes with
 * `toISOString()` (UTC), so UTC midnight, independent of the host time zone.
 */
const wireDate = (d: Temporal.PlainDate): Date => new Date(Date.UTC(d.year, d.month - 1, d.day));

const bankDate = (instant: Date): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO(BANK_TIME_ZONE)
    .toPlainDate();

/**
 * The generic bank failure (mapped to 502). `terminal` failures end the dialog; the others (network,
 * 5xx, decode) leave an open challenge usable so the client can retry the same handle.
 */
class FailedError extends Error {
  constructor(readonly terminal: boolean) {
    super('fints_failed');
    this.name = 'FailedError';
  }
}

const failed = (): Error => new FailedError(true);

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FinTSPortError) throw new FailedError(e.category === 'config');
    throw e;
  }
}

/** Decoupled poll interval from the bank's hint, clamped to 2-10 s; 3 s when the bank gave none. */
function pollMs(sel: TanSel, poll: 'first' | 'between'): number {
  const secs =
    poll === 'first' ? sel.decoupledWait?.firstSeconds : sel.decoupledWait?.betweenSeconds;
  if (!secs || !Number.isFinite(secs) || secs <= 0) return DECOUPLED_POLL_DEFAULT_MS;
  return Math.min(DECOUPLED_POLL_MAX_S, Math.max(DECOUPLED_POLL_MIN_S, secs)) * 1000;
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

function pickTanMethod(session: FinTSSession, wanted: number | undefined): TanSel {
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

/** First checking account with statement support, else the first such credit card; else none. */
function probeAccount(session: FinTSSession): FinTSAccount | undefined {
  const accounts = session.accounts();
  return (
    accounts.find((a) => a.accountType === 'CheckingAccount' && session.canGetStatements(a)) ??
    accounts.find((a) => a.accountType === 'CreditCardAccount' && session.canGetStatements(a))
  );
}

/**
 * Selects the TAN medium when the selected method requires one: the single active medium, or (several
 * active, none chosen by the user yet) the first. Known limitation: with several media the user
 * cannot choose; a later plan can add that choice. Returns the name to store, if any.
 */
function chooseTanMedia(session: FinTSSession): string | undefined {
  const media = session.tanMedia();
  const name = media.required ? media.active[0] : undefined;
  if (name === undefined) return undefined;
  session.selectTanMedia(name);
  return name;
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
    sel: TanSel,
    r: FinTSPortResponse,
    poll: 'first' | 'between',
  ): { challenge: Challenge; kind: ChallengeKindUsed } => {
    const methodKind = sel.kind;
    const message = sanitise(r.tanChallenge);
    if (methodKind === 'decoupled')
      return {
        kind: 'decoupled',
        challenge: {
          kind: 'decoupled',
          message: message || 'Confirm in your banking app',
          pollAfterMs: pollMs(sel, poll),
        },
      };
    if (methodKind === 'photo' && r.tanPhoto) {
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
    tanMethod: TanSel,
    attempts: number,
    extra: Pick<DialogMeta, 'accountRef' | 'probe'>,
    ctx: ConnectorContext,
    opts: { poll?: 'first' | 'between'; fallbackRef?: string } = {},
  ): AuthStep => {
    // A decoupled status response may omit the reference; the pending one stays valid.
    const tanReference = r.tanReference ?? opts.fallbackRef;
    if (!tanReference) throw failed();
    const { challenge, kind } = toChallenge(tanMethod, r, opts.poll ?? 'first');
    const meta: DialogMeta = {
      step,
      tanReference,
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

  const finish = async (
    session: FinTSSession,
    tanMethodId: number,
    ctx: ConnectorContext,
  ): Promise<AuthStep> => {
    const tanMediaName = await guard(() => chooseTanMedia(session));
    const info = session.bankingInformation();
    const systemId = (info as { systemId?: unknown } | null)?.systemId;
    return {
      done: true,
      state: {
        bankingInformation: info as Json,
        tanMethodId,
        ...(tanMediaName ? { tanMediaName } : {}),
        systemId: typeof systemId === 'string' ? systemId : null,
      },
      consentExpiresAt: new Date(ctx.now().getTime() + CONSENT_MS),
    };
  };

  const accountKey = (a: FinTSAccount): string => a.iban ?? a.accountNumber;

  const runProbe = (session: FinTSSession, acc: FinTSAccount, ctx: ConnectorContext) => {
    const today = bankDate(ctx.now());
    const from = wireDate(today.subtract({ days: PROBE_DAYS }));
    return guard(() =>
      acc.accountType === 'CreditCardAccount'
        ? session.getCreditCardStatements(acc, from)
        : session.getStatements(acc, from, wireDate(today)),
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
    tanMethod: TanSel,
    attempts: number,
    ctx: ConnectorContext,
  ): Promise<AuthStep> | AuthStep => {
    checkPinErrors(r);
    if (r.requiresTan)
      return raise(session, r, 'statements-probe', tanMethod, attempts, probeExtra(acc), ctx);
    if (!r.success) throw failed();
    return finish(session, tanMethod.id, ctx);
  };

  /** After a successful sync: run the statements probe, else finish. */
  const afterSync = async (
    session: FinTSSession,
    tanMethod: TanSel,
    ctx: ConnectorContext,
  ): Promise<AuthStep> => {
    // The medium must be selected before any further order (it goes into every HKTAN).
    await guard(() => chooseTanMedia(session));
    const acc = probeAccount(session);
    if (!acc) return finish(session, tanMethod.id, ctx);
    return probeOutcome(session, acc, await runProbe(session, acc, ctx), tanMethod, 0, ctx);
  };

  const openStored = (stored: StoredState, cfg: FinTSConnectionConfig): FinTSSession => {
    const bank = FINTS_BANKS[cfg.bank];
    return port.openFromState(
      {
        productId: product.id,
        productVersion: product.version,
        url: bank.url,
        blz: bank.blz,
        userId: cfg.userId,
        pin: cfg.pin,
      },
      stored.bankingInformation,
      stored.tanMethodId,
      stored.tanMediaName,
    );
  };

  const resume = async (
    d: PersistedDialog,
    entry: FinTSDialogEntry,
    tan: string | undefined,
    ctx: ConnectorContext,
    progress: { accepted: boolean },
  ): Promise<AuthStep> => {
    const { session, meta } = entry;
    const method = session.availableTanMethods().find((m) => m.id === d.tanMethodId);
    const tanMethod: TanSel = {
      id: d.tanMethodId,
      kind: method?.kind ?? 'code',
      ...(method?.decoupledWait ? { decoupledWait: method.decoupledWait } : {}),
    };

    const r = await guard(() => {
      if (d.step === 'sync') return session.synchronizeWithTan(meta.tanReference, tan);
      return meta.probe === 'credit-card'
        ? session.getCreditCardStatementsWithTan(meta.tanReference, tan)
        : session.getStatementsWithTan(meta.tanReference, tan);
    });
    progress.accepted = true;
    checkPinErrors(r);

    const extra: Pick<DialogMeta, 'accountRef' | 'probe'> = {};
    if (meta.accountRef) extra.accountRef = meta.accountRef;
    if (meta.probe) extra.probe = meta.probe;
    if (r.requiresTan) {
      // Decoupled: still pending (same challenge). Otherwise a follow-up TAN.
      const pendingPoll = d.kind === 'decoupled';
      return raise(session, r, d.step, tanMethod, d.attempts, extra, ctx, {
        poll: pendingPoll ? 'between' : 'first',
        ...(pendingPoll ? { fallbackRef: meta.tanReference } : {}),
      });
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
      await guard(() => session.selectTanMethod(tanMethod.id));
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
      const tan =
        answer.kind === 'code' || answer.kind === 'image' ? answer.code.trim() : undefined;
      if (tan === '') throw new InvalidAnswerError();
      const entry = dialogs.take(d.handle);
      if (!entry) throw new ConnectorAuthError('timeout');
      const progress = { accepted: false };
      try {
        return await resume(d, entry, tan, ctx, progress);
      } catch (e) {
        // Terminal outcomes (declined, too many attempts, bank logic failure) end the dialog. A
        // transient failure of the continuation call itself (network, 5xx, decode) keeps the
        // session under the same handle, so the client's retry reaches it. Once the bank accepted
        // the TAN its reference is used up: a later failure (probe, TAN medium) ends the dialog.
        const terminal =
          e instanceof ConnectorAuthError ||
          e instanceof InvalidAnswerError ||
          (e instanceof FailedError && e.terminal);
        if (!terminal && !progress.accepted) dialogs.restore(d.handle, entry);
        throw e;
      }
    },

    async cancelAuth(dialog) {
      const handle = (dialog as { handle?: unknown }).handle;
      if (typeof handle === 'string') dialogs.drop(handle);
    },

    async listAccounts(state, _ctx, rawConfig): Promise<ProviderAccount[]> {
      const stored = readState(state);
      const cfg = fintsConfigSchema.safeParse(rawConfig);
      if (!stored || !cfg.success) throw failed();
      return guard(() => {
        const session = openStored(stored, cfg.data);
        // Accounts the bank offers no statements for cannot be synced; depots stay (net worth later).
        return session
          .accounts()
          .filter((a) => a.accountType === 'SecuritiesAccount' || session.canGetStatements(a))
          .map(mapAccount);
      });
    },

    async fetchTransactions(state, ref, since, ctx, rawConfig): Promise<FetchResult> {
      const stored = readState(state);
      const cfg = fintsConfigSchema.safeParse(rawConfig);
      if (!stored || !cfg.success) return { ok: false, reason: 'needs_attention' };
      // Set when a response reported that the bank data (BPD/UPD) changed; returned on every path.
      let fresh: ConnectorState | undefined;
      const fail = (reason: 'needs_attention' | 'temporary'): FetchResult => ({
        ok: false,
        reason,
        ...(fresh ? { state: fresh } : {}),
      });
      try {
        const session = openStored(stored, cfg.data);
        const acc = session.accounts().find((a) => accountRef(a) === ref);
        if (!acc) return fail('needs_attention');
        if (acc.accountType === 'SecuritiesAccount') return { ok: true, transactions: [] };

        const today = bankDate(ctx.now());
        const earliest = today.subtract({ days: MAX_LOOKBACK_DAYS });
        let from = since ? bankDate(since) : earliest;
        if (Temporal.PlainDate.compare(from, earliest) < 0) from = earliest;
        if (Temporal.PlainDate.compare(from, today) > 0) from = today;
        const r =
          acc.accountType === 'CreditCardAccount'
            ? await session.getCreditCardStatements(acc, wireDate(from))
            : await session.getStatements(acc, wireDate(from), wireDate(today));
        if (r.bankingInformationUpdated)
          fresh = { ...state, bankingInformation: session.bankingInformation() as Json };
        // A rejected dialog init (the order never ran) or an access/lock answer (9930-9942, 3938)
        // would be retried by every scheduled run and risks locking the account: stop and wait.
        if (r.initFailed || r.bankAnswers.some((a) => isAccessCode(a.code)))
          return fail('needs_attention');
        // PSD2 SCA renewal: never an interactive dialog from here; the user renews via re-auth.
        if (r.requiresTan) return fail('needs_attention');
        if (!r.success) return fail('temporary');

        const currency = acc.currency ?? 'EUR';
        const out: FetchResult = {
          ok: true,
          transactions: (r.transactions ?? []).map((t) => mapTx(t, currency)),
        };
        if (r.balance)
          out.balance = money(toMinor(r.balance.value, r.balance.currency), r.balance.currency);
        if (fresh) out.state = fresh;
        return out;
      } catch (e) {
        if (e instanceof FinTSPortError) {
          // The bank offers no statements for this account: nothing to sync, not an error.
          if (e.category === 'unsupported')
            return { ok: true, transactions: [], ...(fresh ? { state: fresh } : {}) };
          return fail(e.category === 'config' ? 'needs_attention' : 'temporary');
        }
        throw e;
      }
    },
  };
}
