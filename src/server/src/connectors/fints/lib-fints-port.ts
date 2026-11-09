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
import type {
  FinTSAccount,
  FinTSBankParams,
  FinTSPort,
  FinTSPortResponse,
  FinTSSession,
  FinTSTanMethod,
  FinTSTx,
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

class LibFintsSession implements FinTSSession {
  constructor(private readonly client: FinTSClient) {}

  private snapshot(): unknown {
    return serialiseBankingInformation(this.client.config.bankingInformation);
  }

  private resolve(acc: FinTSAccount): BankAccount {
    const list = this.client.config.bankingInformation.upd?.bankAccounts ?? [];
    const found = list.find((a) => accountRef(mapAccount(a)) === accountRef(acc));
    if (!found) throw new Error('Account not found in the bank account list');
    return found;
  }

  async synchronize() {
    const r = await this.client.synchronize();
    return { ...mapResponse(r), bankingInformation: this.snapshot() };
  }

  async synchronizeWithTan(ref: string, tan?: string) {
    const r = await this.client.synchronizeWithTan(ref, tan);
    return { ...mapResponse(r), bankingInformation: this.snapshot() };
  }

  selectTanMethod(id: number): void {
    this.client.selectTanMethod(id);
  }

  availableTanMethods(): FinTSTanMethod[] {
    return this.client.config.availableTanMethods.map(mapTan);
  }

  accounts(): FinTSAccount[] {
    return (this.client.config.bankingInformation.upd?.bankAccounts ?? []).map(mapAccount);
  }

  private statementsResult(r: StatementResponse) {
    return { ...mapResponse(r), transactions: mapStatements(r.statements) };
  }

  async getStatements(acc: FinTSAccount, from?: Date, to?: Date) {
    return this.statementsResult(
      await this.client.getAccountStatements(this.resolve(acc), from, to),
    );
  }

  async getStatementsWithTan(ref: string, tan?: string) {
    // The pending interaction decides between account and credit card statements.
    return this.statementsResult(await this.client.getAccountStatementsWithTan(ref, tan));
  }

  async getCreditCardStatements(acc: FinTSAccount, from?: Date) {
    return this.statementsResult(
      await this.client.getCreditCardStatements(this.resolve(acc), from),
    );
  }

  async getBalance(acc: FinTSAccount) {
    const r: AccountBalanceResponse = await this.client.getAccountBalance(this.resolve(acc));
    const out: FinTSPortResponse & { balance?: { value: number; currency: string } } =
      mapResponse(r);
    if (r.balance) out.balance = { value: r.balance.balance, currency: r.balance.currency };
    return out;
  }

  bankingInformation(): unknown {
    return this.snapshot();
  }
}

/** Production {@link FinTSPort} over `lib-fints`. Debug output is never enabled and nothing is logged. */
export class LibFintsPort implements FinTSPort {
  openFirstTime(p: FinTSBankParams): FinTSSession {
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
  }

  openFromState(
    p: FinTSBankParams,
    bankingInformation: unknown,
    tanMethodId: number,
  ): FinTSSession {
    // The stored BPD carries the URL the bank reported at sync time; our catalog is authoritative
    // (banks migrate endpoints), so pin it. lib-fints resolves the URL from the BPD first.
    const stored = bankingInformation as BankingInformation;
    const info: BankingInformation = stored.bpd
      ? { ...stored, bpd: { ...stored.bpd, url: p.url } }
      : stored;
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
  }
}
