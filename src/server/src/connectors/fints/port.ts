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

/** Projection of lib-fints statement `Transaction` (amounts are JS floats, dates local-midnight). */
export interface FinTSTx {
  valueDate: Date;
  entryDate: Date;
  amount: number;
  bookingText?: string;
  purpose?: string;
  remoteBankId?: string;
  remoteAccountNumber?: string;
  remoteName?: string;
  e2eReference?: string;
  mandateReference?: string;
}

export type FinTSTanKind = 'decoupled' | 'code' | 'photo' | 'chiptan-optical';

export interface FinTSTanMethod {
  id: number;
  name: string;
  decoupled: boolean;
  kind: FinTSTanKind;
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
}

export interface FinTSSession {
  synchronize(): Promise<FinTSPortResponse & { bankingInformation?: unknown }>;
  synchronizeWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { bankingInformation?: unknown }>;
  selectTanMethod(id: number): void;
  availableTanMethods(): FinTSTanMethod[];
  /** From the UPD. */
  accounts(): FinTSAccount[];
  getStatements(
    acc: FinTSAccount,
    from?: Date,
    to?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }>;
  getStatementsWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }>;
  getCreditCardStatements(
    acc: FinTSAccount,
    from?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }>;
  getBalance(
    acc: FinTSAccount,
  ): Promise<FinTSPortResponse & { balance?: { value: number; currency: string } }>;
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
  openFromState(p: FinTSBankParams, bankingInformation: unknown, tanMethodId: number): FinTSSession;
}
