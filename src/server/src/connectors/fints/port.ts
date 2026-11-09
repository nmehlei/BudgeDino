/**
 * The only surface the FinTS connector uses from `lib-fints`. Types here are plain projections of
 * the library's types (no library import), so the connector and its tests never depend on it.
 */

export type FinTSAccountType =
  | 'CheckingAccount'
  | 'SavingsAccount'
  | 'FixedDepositAccount'
  | 'SecuritiesAccount'
  | 'LoanMortgageAccount'
  | 'CreditCardAccount'
  | 'InvestmentCompanyFund'
  | 'HomeSavingsContract'
  | 'InsurancePolicy'
  | 'Miscellaneous';

/** Projection of lib-fints `BankAccount`. */
export interface FinTSAccount {
  iban?: string;
  bic?: string;
  accountNumber: string;
  subAccountId?: string;
  blz: string;
  accountType: FinTSAccountType;
  currency?: string;
  holder1?: string;
  product?: string;
}

/**
 * Projection of lib-fints statement `Transaction` (amounts are JS floats). Dates are the bank's
 * calendar days as `YYYY-MM-DD`, decided per source by the port (never guessed from a Date).
 */
export interface FinTSTx {
  bookingDate: string;
  valueDate?: string;
  amount: number;
  bookingText?: string;
  purpose?: string;
  remoteBankId?: string;
  remoteAccountNumber?: string;
  remoteName?: string;
  e2eReference?: string;
  mandateReference?: string;
}

/** Closing balance from the statement response (signed float, like amounts). */
export interface FinTSBalance {
  value: number;
  currency: string;
}

export type FinTSTanKind = 'decoupled' | 'code' | 'photo' | 'chiptan-optical';

export interface FinTSTanMethod {
  id: number;
  name: string;
  decoupled: boolean;
  kind: FinTSTanKind;
  /** Decoupled methods: the bank's polling hints (BPD), in seconds. */
  decoupledWait?: { firstSeconds: number; betweenSeconds: number };
}

export interface FinTSPortResponse {
  success: boolean;
  requiresTan: boolean;
  tanReference?: string;
  tanChallenge?: string;
  tanPhoto?: { mimeType: string; data: Uint8Array };
  /** Raw HHD UC challenge; present for chipTAN (flicker) challenges. */
  tanChallengeHhdUc?: string;
  bankAnswers: { code: number; text: string }[];
  bankingInformationUpdated: boolean;
  /**
   * The dialog initialisation did not complete (rejected, or it demanded a TAN); the order never
   * ran. lib-fints then returns the init response as the order's result.
   */
  initFailed?: boolean;
}

export interface FinTSSession {
  synchronize(): Promise<FinTSPortResponse & { bankingInformation?: unknown }>;
  synchronizeWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { bankingInformation?: unknown }>;
  selectTanMethod(id: number): void;
  availableTanMethods(): FinTSTanMethod[];
  /** The selected method's TAN medium needs: whether one is required and the active media names. */
  tanMedia(): { required: boolean; active: string[] };
  selectTanMedia(name: string): void;
  /** From the UPD. */
  accounts(): FinTSAccount[];
  /** Whether the bank offers statements (account or credit card path) for this account. */
  canGetStatements(acc: FinTSAccount): boolean;
  getStatements(
    acc: FinTSAccount,
    from?: Date,
    to?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[]; balance?: FinTSBalance }>;
  getStatementsWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[]; balance?: FinTSBalance }>;
  getCreditCardStatementsWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[]; balance?: FinTSBalance }>;
  getCreditCardStatements(
    acc: FinTSAccount,
    from?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[]; balance?: FinTSBalance }>;
  /** JSON-serialisable snapshot for ConnectorState. */
  bankingInformation(): unknown;
}

export type FinTSBankParams = {
  productId: string;
  productVersion: string;
  url: string;
  blz: string;
  userId: string;
  pin: string;
};

export interface FinTSPort {
  openFirstTime(p: FinTSBankParams): FinTSSession;
  openFromState(
    p: FinTSBankParams,
    bankingInformation: unknown,
    tanMethodId: number,
    tanMediaName?: string,
  ): FinTSSession;
}

export type FinTSPortErrorCategory =
  'http' | 'network' | 'decode' | 'unsupported' | 'config' | 'unknown';

/**
 * The only error the port surfaces. lib-fints errors embed bank response bodies, account numbers
 * and IBANs, so the message is fixed per category and the original error is neither kept as `cause`
 * nor otherwise referenced.
 */
export class FinTSPortError extends Error {
  constructor(
    readonly category: FinTSPortErrorCategory,
    readonly status?: number,
  ) {
    super(`FinTS ${category} error`);
    this.name = 'FinTSPortError';
  }
}
