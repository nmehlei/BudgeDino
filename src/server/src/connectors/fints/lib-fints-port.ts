import {
  FinTSClient,
  FinTSConfig,
  type AccountBalanceResponse,
  type BankAccount,
  type BankingInformation,
  type ClientResponse,
  type StatementResponse,
  type Transaction,
} from 'lib-fints';
import { accountRef, classifyTanMethod } from './map.js';
import {
  FinTSPortError,
  type FinTSAccount,
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
  return {
    id: m.id,
    name: m.name,
    decoupled,
    kind: classifyTanMethod({ name: m.name, decoupled }),
  };
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
  if (r.tanPhoto) out.tanPhoto = { mimeType: r.tanPhoto.mimeType, data: r.tanPhoto.image };
  return out;
}

function mapTransaction(t: Transaction): FinTSTx {
  const out: FinTSTx = { valueDate: t.valueDate, entryDate: t.entryDate, amount: t.amount };
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
        valueDate: s.valueDate,
        entryDate: s.transactionDate,
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

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw sanitise(e);
  }
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

class LibFintsSession implements FinTSSession {
  constructor(private readonly client: FinTSClient) {}

  private snapshot(): unknown {
    return serialiseBankingInformation(this.client.config.bankingInformation);
  }

  private resolve(acc: FinTSAccount): BankAccount {
    const list = this.client.config.bankingInformation.upd?.bankAccounts ?? [];
    const found = list.find((a) => accountRef(mapAccount(a)) === accountRef(acc));
    if (!found) throw new FinTSPortError('config');
    return found;
  }

  synchronize() {
    return guard(async () => {
      const r = await this.client.synchronize();
      return { ...mapResponse(r), bankingInformation: this.snapshot() };
    });
  }

  synchronizeWithTan(ref: string, tan?: string) {
    return guard(async () => {
      const r = await this.client.synchronizeWithTan(ref, tan);
      return { ...mapResponse(r), bankingInformation: this.snapshot() };
    });
  }

  selectTanMethod(id: number): void {
    sync(() => this.client.selectTanMethod(id));
  }

  availableTanMethods(): FinTSTanMethod[] {
    return sync(() => this.client.config.availableTanMethods.map(mapTan));
  }

  accounts(): FinTSAccount[] {
    return sync(() =>
      (this.client.config.bankingInformation.upd?.bankAccounts ?? []).map(mapAccount),
    );
  }

  private statementsResult(r: StatementResponse) {
    // Our lib-fints patch flags an MT940/CAMT payload that failed to parse (the library would
    // otherwise report success with zero statements: silent data loss).
    if ((r as { parseFailed?: boolean }).parseFailed) throw new FinTSPortError('decode');
    return { ...mapResponse(r), transactions: mapStatements(r.statements) };
  }

  getStatements(acc: FinTSAccount, from?: Date, to?: Date) {
    return guard(async () =>
      this.statementsResult(await this.client.getAccountStatements(this.resolve(acc), from, to)),
    );
  }

  getStatementsWithTan(ref: string, tan?: string) {
    // The pending interaction decides between account and credit card statements.
    return guard(async () =>
      this.statementsResult(await this.client.getAccountStatementsWithTan(ref, tan)),
    );
  }

  getCreditCardStatements(acc: FinTSAccount, from?: Date) {
    return guard(async () =>
      this.statementsResult(await this.client.getCreditCardStatements(this.resolve(acc), from)),
    );
  }

  getCreditCardStatementsWithTan(ref: string, tan?: string) {
    return guard(async () =>
      this.statementsResult(await this.client.getCreditCardStatementsWithTan(ref, tan)),
    );
  }

  getBalance(acc: FinTSAccount) {
    return guard(async () => {
      const r: AccountBalanceResponse = await this.client.getAccountBalance(this.resolve(acc));
      const out: FinTSPortResponse & { balance?: { value: number; currency: string } } =
        mapResponse(r);
      if (r.balance) out.balance = { value: r.balance.balance, currency: r.balance.currency };
      return out;
    });
  }

  bankingInformation(): unknown {
    return sync(() => this.snapshot());
  }
}

export interface LibFintsPortOptions {
  /**
   * Called with the BLZ (no other data) when the BPD stored from an earlier sync names a different
   * URL than the catalog; the catalog URL is used regardless.
   */
  onUrlMismatch?: (blz: string) => void;
}

/** Production {@link FinTSPort} over `lib-fints`. Debug output is never enabled and nothing is logged. */
export class LibFintsPort implements FinTSPort {
  constructor(private readonly options: LibFintsPortOptions = {}) {}

  openFirstTime(p: FinTSBankParams): FinTSSession {
    return configure(() => {
      const config = FinTSConfig.forFirstTimeUse(
        p.productId,
        p.productVersion,
        p.url,
        p.blz,
        p.userId,
        p.pin,
      );
      config.debugEnabled = false;
      return new LibFintsSession(new FinTSClient(config));
    });
  }

  openFromState(
    p: FinTSBankParams,
    bankingInformation: unknown,
    tanMethodId: number,
  ): FinTSSession {
    const stored = bankingInformation as BankingInformation | null;
    // lib-fints reads the endpoint from the stored BPD. Without it there is no usable state.
    if (!stored || typeof stored !== 'object' || !stored.bpd) throw new FinTSPortError('config');
    // Security: the PIN is sent to this URL, and the BPD (bank-announced, stored from a response)
    // must not be able to redirect it, so the operator-controlled catalog URL always wins.
    // Cost: bank-announced endpoint migrations are ignored; the catalog must be kept up to date.
    if (stored.bpd.url !== undefined && stored.bpd.url !== p.url)
      this.options.onUrlMismatch?.(p.blz);
    const info: BankingInformation = { ...stored, bpd: { ...stored.bpd, url: p.url } };
    return configure(() => {
      const config = FinTSConfig.fromBankingInformation(
        p.productId,
        p.productVersion,
        info,
        p.userId,
        p.pin,
        tanMethodId,
      );
      config.debugEnabled = false;
      return new LibFintsSession(new FinTSClient(config));
    });
  }
}
