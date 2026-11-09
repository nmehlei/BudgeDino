import {
  FinTSClient,
  FinTSConfig,
  type BankAccount,
  type BankingInformation,
  type ClientResponse,
  type StatementResponse,
  type Transaction,
} from 'lib-fints';
import { accountRef, classifyTanMethod, toIsoDate } from './map.js';
import {
  FinTSPortError,
  type FinTSAccount,
  type FinTSBalance,
  type FinTSBankParams,
  type FinTSPort,
  type FinTSPortResponse,
  type FinTSSession,
  type FinTSTanMethod,
  type FinTSTx,
} from './port.js';

/** JSON-safe deep copy: Dates become ISO strings; nothing else is altered. */
export function serialiseBankingInformation(info: unknown): unknown {
  return JSON.parse(
    JSON.stringify(info, function (this: Record<string, unknown>, key: string, value: unknown) {
      // JSON.stringify calls toJSON before the replacer, so read the original Date from the holder.
      const original = this[key];
      return original instanceof Date ? original.toISOString() : value;
    }),
  ) as unknown;
}

function mapAccount(a: BankAccount): FinTSAccount {
  const out: FinTSAccount = {
    accountNumber: a.accountNumber,
    blz: a.bank.bankId,
    accountType: a.accountType,
    currency: a.currency,
    holder1: a.holder1,
  };
  if (a.iban) out.iban = a.iban;
  if (a.bic) out.bic = a.bic;
  if (a.subAccountId) out.subAccountId = a.subAccountId;
  if (a.product) out.product = a.product;
  return out;
}

type TanMethod = FinTSConfig['availableTanMethods'][number];

function mapTan(m: TanMethod): FinTSTanMethod {
  const decoupled = m.isDecoupled || m.decoupled !== undefined;
  const out: FinTSTanMethod = {
    id: m.id,
    name: m.name,
    decoupled,
    kind: classifyTanMethod({ name: m.name, decoupled }),
  };
  if (m.decoupled) {
    out.decoupledWait = {
      firstSeconds: m.decoupled.waitingSecondsBeforeFirstStatusRequest,
      betweenSeconds: m.decoupled.waitingSecondsBetweenStatusRequests,
    };
  }
  return out;
}

function mapResponse(r: ClientResponse): FinTSPortResponse {
  const out: FinTSPortResponse = {
    success: r.success,
    requiresTan: r.requiresTan,
    bankAnswers: r.bankAnswers.map((b) => ({ code: b.code, text: b.text })),
    bankingInformationUpdated: r.bankingInformationUpdated,
  };
  if (r.tanReference !== undefined) out.tanReference = r.tanReference;
  if (r.tanChallenge !== undefined) out.tanChallenge = r.tanChallenge;
  if (r.tanChallengeHhdUc !== undefined) out.tanChallengeHhdUc = r.tanChallengeHhdUc;
  if ((r as { initFailed?: boolean }).initFailed) out.initFailed = true;
  if (r.tanPhoto) out.tanPhoto = { mimeType: r.tanPhoto.mimeType, data: r.tanPhoto.image };
  return out;
}

const RAW_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const RAW_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * CAMT: the bank's written calendar day, whatever the offset or time (our patch keeps the raw
 * string). Other sources, or an unparsable raw value: the parser's local-constructor Date.
 */
function day(raw: string | undefined, fallback: Date): string {
  const m = raw ? (RAW_DAY.exec(raw) ?? RAW_COMPACT.exec(raw)) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : toIsoDate(fallback);
}

function mapTransaction(t: Transaction): FinTSTx {
  const raw = t as Transaction & { bookingDateRaw?: string; valueDateRaw?: string };
  const out: FinTSTx = {
    bookingDate: day(raw.bookingDateRaw, t.entryDate),
    valueDate: day(raw.valueDateRaw, t.valueDate),
    amount: t.amount,
  };
  if (t.bookingText) out.bookingText = t.bookingText;
  if (t.purpose) out.purpose = t.purpose;
  if (t.remoteBankId) out.remoteBankId = t.remoteBankId;
  if (t.remoteAccountNumber) out.remoteAccountNumber = t.remoteAccountNumber;
  if (t.remoteName) out.remoteName = t.remoteName;
  if (t.e2eReference) out.e2eReference = t.e2eReference;
  if (t.mandateReference) out.mandateReference = t.mandateReference;
  return out;
}

/** Shape of a lib-fints credit card entry (DKKKU), which the library types as a `Statement`. */
interface CreditCardEntry {
  transactionDate: Date;
  valueDate: Date;
  amount: number;
  purpose?: string;
  remoteName?: string;
  reference?: string;
}

function isCreditCardEntry(e: unknown): e is CreditCardEntry {
  return typeof e === 'object' && e !== null && 'transactionDate' in e && !('transactions' in e);
}

/** Flattens statements; credit card entries (no `transactions`) become one transaction each. */
function mapStatements(statements: readonly unknown[] | undefined): FinTSTx[] {
  const out: FinTSTx[] = [];
  for (const s of statements ?? []) {
    if (isCreditCardEntry(s)) {
      const tx: FinTSTx = {
        bookingDate: toIsoDate(s.transactionDate),
        valueDate: toIsoDate(s.valueDate),
        amount: s.amount,
      };
      if (s.purpose) tx.purpose = s.purpose;
      if (s.remoteName) tx.remoteName = s.remoteName;
      if (s.reference) tx.e2eReference = s.reference;
      out.push(tx);
    } else {
      out.push(...((s as { transactions?: Transaction[] }).transactions ?? []).map(mapTransaction));
    }
  }
  return out;
}

/**
 * Balance without a separate order: the credit card response's `balance`, else the closing
 * balance (MT940 `:62F:` / CAMT CLBD) of the last statement of the window.
 */
function closingBalance(r: StatementResponse): FinTSBalance | undefined {
  const card = (r as { balance?: { balance: number; currency: string } }).balance;
  if (card) return { value: card.balance, currency: card.currency };
  const last = [...(r.statements ?? [])]
    .reverse()
    .find((s) => (s as { closingBalance?: unknown }).closingBalance);
  const b = (last as { closingBalance?: { value: number; currency: string } } | undefined)
    ?.closingBalance;
  return b ? { value: b.value, currency: b.currency } : undefined;
}

/** Maps any lib-fints/fetch failure to a sanitised {@link FinTSPortError}; never copies text from it. */
function sanitise(e: unknown): FinTSPortError {
  if (e instanceof FinTSPortError) return e;
  const msg = e instanceof Error ? e.message : '';
  const http = /^Request failed with status code (\d{3})/.exec(msg);
  if (http) return new FinTSPortError('http', Number(http[1]));
  if (e instanceof TypeError && /fetch failed/i.test(msg)) return new FinTSPortError('network');
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^(E[A-Z]+|UND_ERR.*)$/.test(code)) {
    return new FinTSPortError('network');
  }
  if (/not supported|unsupported|not available|does not support/i.test(msg)) {
    return new FinTSPortError('unsupported');
  }
  if (/decod|pars|unexpected|invalid segment|segment/i.test(msg)) {
    return new FinTSPortError('decode');
  }
  return new FinTSPortError('unknown');
}

function sync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw sanitise(e);
  }
}

/** Constructors validate configuration (URL, product id, TAN method), so any failure is `config`. */
function configure<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new FinTSPortError('config');
  }
}

/** lib-fints `TanMediaRequirement.Required` (the enum is not exported). */
const TAN_MEDIA_REQUIRED = 2;

class LibFintsSession implements FinTSSession {
  readonly #client: FinTSClient;
  readonly #pinnedUrl: string;
  readonly #blz: string;
  readonly #onUrlMismatch: ((blz: string) => void) | undefined;
  #mismatchReported = false;

  constructor(
    client: FinTSClient,
    pinnedUrl: string,
    blz: string,
    onUrlMismatch: ((blz: string) => void) | undefined,
  ) {
    this.#client = client;
    this.#pinnedUrl = pinnedUrl;
    this.#blz = blz;
    this.#onUrlMismatch = onUrlMismatch;
    this.#pin();
  }

  /**
   * Security (P2-R4): lib-fints reads `bpd.url ?? url` and overwrites `bpd.url` from the bank's HIKOM
   * on every sync (and the init of every dialog), so the endpoint the PIN is sent to would follow the
   * bank's announcement. The operator-controlled catalog URL is rewritten into the BPD before and
   * after every bank call, so it is both what the next dialog uses and what the snapshot stores.
   * The mismatch is reported once per session, with the BLZ only.
   */
  #pin(): void {
    const bpd = this.#client.config.bankingInformation.bpd;
    if (!bpd || bpd.url === this.#pinnedUrl) return;
    if (bpd.url !== undefined && !this.#mismatchReported) {
      this.#mismatchReported = true;
      this.#onUrlMismatch?.(this.#blz);
    }
    bpd.url = this.#pinnedUrl;
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    this.#pin();
    try {
      return await fn();
    } catch (e) {
      throw sanitise(e);
    } finally {
      this.#pin();
    }
  }

  private snapshot(): unknown {
    this.#pin();
    return serialiseBankingInformation(this.#client.config.bankingInformation);
  }

  private resolve(acc: FinTSAccount): BankAccount {
    const list = this.#client.config.bankingInformation.upd?.bankAccounts ?? [];
    const found = list.find((a) => accountRef(mapAccount(a)) === accountRef(acc));
    if (!found) throw new FinTSPortError('config');
    return found;
  }

  async synchronize() {
    const r = await this.#call(() => this.#client.synchronize());
    return { ...mapResponse(r), bankingInformation: this.snapshot() };
  }

  async synchronizeWithTan(ref: string, tan?: string) {
    const r = await this.#call(() => this.#client.synchronizeWithTan(ref, tan));
    return { ...mapResponse(r), bankingInformation: this.snapshot() };
  }

  selectTanMethod(id: number): void {
    sync(() => this.#client.selectTanMethod(id));
  }

  availableTanMethods(): FinTSTanMethod[] {
    return sync(() => this.#client.config.availableTanMethods.map(mapTan));
  }

  tanMedia(): { required: boolean; active: string[] } {
    return sync(() => {
      const m = this.#client.config.selectedTanMethod;
      return {
        required: m?.tanMediaRequirement === TAN_MEDIA_REQUIRED,
        active: [...(m?.activeTanMedia ?? [])],
      };
    });
  }

  selectTanMedia(name: string): void {
    sync(() => this.#client.selectTanMedia(name));
  }

  accounts(): FinTSAccount[] {
    return sync(() =>
      (this.#client.config.bankingInformation.upd?.bankAccounts ?? []).map(mapAccount),
    );
  }

  canGetStatements(acc: FinTSAccount): boolean {
    try {
      const a = this.resolve(acc);
      const c = this.#client;
      return a.accountType === 'CreditCardAccount'
        ? c.canGetCreditCardStatements(a) || c.canGetAccountStatements(a)
        : c.canGetAccountStatements(a);
    } catch {
      return false;
    }
  }

  private statementsResult(r: StatementResponse) {
    // Our lib-fints patch flags an MT940/CAMT payload that failed to parse (the library would
    // otherwise report success with zero statements: silent data loss).
    if ((r as { parseFailed?: boolean }).parseFailed) throw new FinTSPortError('decode');
    const out: FinTSPortResponse & { transactions: FinTSTx[]; balance?: FinTSBalance } = {
      ...mapResponse(r),
      transactions: mapStatements(r.statements),
    };
    const balance = closingBalance(r);
    if (balance) out.balance = balance;
    return out;
  }

  getStatements(acc: FinTSAccount, from?: Date, to?: Date) {
    return this.#call(async () =>
      this.statementsResult(await this.#client.getAccountStatements(this.resolve(acc), from, to)),
    );
  }

  getStatementsWithTan(ref: string, tan?: string) {
    // The pending interaction decides between account and credit card statements.
    return this.#call(async () =>
      this.statementsResult(await this.#client.getAccountStatementsWithTan(ref, tan)),
    );
  }

  getCreditCardStatements(acc: FinTSAccount, from?: Date) {
    return this.#call(async () => {
      const a = this.resolve(acc);
      // Banks without HKKKU/DKKKU for this card may still serve it as an account (HKKAZ/HKCAZ).
      if (!this.#client.canGetCreditCardStatements(a) && this.#client.canGetAccountStatements(a))
        return this.statementsResult(await this.#client.getAccountStatements(a, from));
      return this.statementsResult(await this.#client.getCreditCardStatements(a, from));
    });
  }

  getCreditCardStatementsWithTan(ref: string, tan?: string) {
    return this.#call(async () =>
      this.statementsResult(await this.#client.getCreditCardStatementsWithTan(ref, tan)),
    );
  }

  bankingInformation(): unknown {
    return sync(() => this.snapshot());
  }
}

export interface LibFintsPortOptions {
  /**
   * Called once per session with the BLZ (no other data) when the BPD names a different URL than the
   * catalog (stored, or announced by the bank's HIKOM); the catalog URL is used regardless.
   */
  onUrlMismatch?: (blz: string) => void;
  /** Test seam: called with each newly created lib-fints client, to stub its bank calls. */
  onClientCreated?: (client: FinTSClient) => void;
}

/** Production {@link FinTSPort} over `lib-fints`. Debug output is never enabled and nothing is logged. */
export class LibFintsPort implements FinTSPort {
  constructor(private readonly options: LibFintsPortOptions = {}) {}

  private session(config: FinTSConfig, p: FinTSBankParams): FinTSSession {
    config.debugEnabled = false;
    const client = new FinTSClient(config);
    this.options.onClientCreated?.(client);
    return new LibFintsSession(client, p.url, p.blz, this.options.onUrlMismatch);
  }

  openFirstTime(p: FinTSBankParams): FinTSSession {
    return configure(() =>
      this.session(
        FinTSConfig.forFirstTimeUse(p.productId, p.productVersion, p.url, p.blz, p.userId, p.pin),
        p,
      ),
    );
  }

  openFromState(
    p: FinTSBankParams,
    bankingInformation: unknown,
    tanMethodId: number,
    tanMediaName?: string,
  ): FinTSSession {
    const stored = bankingInformation as BankingInformation | null;
    // lib-fints reads the endpoint from the stored BPD. Without it there is no usable state.
    if (!stored || typeof stored !== 'object' || !stored.bpd) throw new FinTSPortError('config');
    // Copy so the caller's snapshot is never mutated; the session pins the catalog URL (P2-R4).
    const info: BankingInformation = { ...stored, bpd: { ...stored.bpd } };
    return configure(() =>
      this.session(
        FinTSConfig.fromBankingInformation(
          p.productId,
          p.productVersion,
          info,
          p.userId,
          p.pin,
          tanMethodId,
          tanMediaName,
        ),
        p,
      ),
    );
  }
}
