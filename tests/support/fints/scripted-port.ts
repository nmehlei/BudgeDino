import type {
  FinTSAccount,
  FinTSBankParams,
  FinTSPort,
  FinTSPortResponse,
  FinTSSession,
  FinTSTanMethod,
  FinTSTx,
} from '@budgedino/server/connectors/fints/port';
import { FinTSPortError } from '@budgedino/server/connectors/fints/port';

export type ScriptedTanKind = 'decoupled' | 'code' | 'photo';

export interface ScriptedScenario {
  /** Default: one decoupled method (id 920). */
  tanMethods?: FinTSTanMethod[];
  /** TAN demanded by the second `synchronize()` (after `selectTanMethod`). Default: false. */
  syncRequiresTan?: ScriptedTanKind | false;
  /** Decoupled: `synchronizeWithTan` reports "still pending" this many times first. */
  decoupledPendingPolls?: number;
  /** Code/photo TAN accepted by the bank. Default `123456`. */
  correctCode?: string;
  /** Text shown for the TAN challenge (bank-supplied). */
  tanChallenge?: string;
  /** Photo sent for the `photo` kind. Default: a tiny PNG. */
  photo?: { mimeType: string; data: Uint8Array };
  /** Statements demand a TAN (of the sync TAN kind, else decoupled) until it was given once. */
  statementsRequireTan?: boolean;
  accounts?: FinTSAccount[];
  transactions?: FinTSTx[];
  creditCardTransactions?: FinTSTx[];
  balance?: { value: number; currency: string };
  /** Fails the first `synchronize()`. */
  failWith?: 'wrong-pin' | 'locked' | 'server-error';
  /**
   * After a rejected TAN the bank ends the dialog: answering the old reference fails (message-level
   * 9800); only a restarted order (fresh reference, `REF-...-n`) works.
   */
  refuseReusedTanReference?: boolean;
  /** Fails every statement/credit-card/balance call (Task 5). */
  statementsFailWith?: 'wrong-pin' | 'server-error' | 'decode';
  /** Statement calls report `bankingInformationUpdated` and switch the snapshot to this value. */
  bankingInformationAfterStatements?: unknown;
  /** `getBalance` throws a network error (statements are unaffected). */
  balanceFails?: boolean;
  /** Snapshot returned by `bankingInformation()`; JSON only. */
  bankingInformation?: unknown;
}

export interface ScriptedCall {
  method: string;
  args: unknown[];
}

export const SCRIPTED_CORRECT_CODE = '123456';
const PNG_1PX = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export const DEFAULT_TAN_METHODS: FinTSTanMethod[] = [
  { id: 920, name: 'DKB App', decoupled: true, kind: 'decoupled' },
];

export const DEFAULT_BANKING_INFORMATION = {
  systemId: 'SYS-SCRIPTED',
  bpd: { url: 'https://fints.example.invalid/fints' },
  upd: { accounts: [] },
};

const BASE: FinTSPortResponse = {
  success: true,
  requiresTan: false,
  bankAnswers: [],
  bankingInformationUpdated: false,
};

/** Deterministic {@link FinTSPort}: scenario-driven, records every call (including arguments). */
export class ScriptedFinTSPort implements FinTSPort {
  readonly calls: ScriptedCall[] = [];
  readonly sessions: ScriptedSession[] = [];

  constructor(readonly scenario: ScriptedScenario = {}) {}

  openFirstTime(p: FinTSBankParams): FinTSSession {
    this.calls.push({ method: 'openFirstTime', args: [p] });
    return this.add(new ScriptedSession(this, false));
  }

  openFromState(
    p: FinTSBankParams,
    bankingInformation: unknown,
    tanMethodId: number,
  ): FinTSSession {
    this.calls.push({ method: 'openFromState', args: [p, bankingInformation, tanMethodId] });
    const s = new ScriptedSession(this, true);
    s.selected = tanMethodId;
    return this.add(s);
  }

  callsOf(method: string): ScriptedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private add(s: ScriptedSession): ScriptedSession {
    this.sessions.push(s);
    return s;
  }
}

class ScriptedSession implements FinTSSession {
  selected: number | undefined;
  private syncTanGiven: boolean;
  private statementsTanGiven = false;
  private syncPending: number;
  private statementsPending: number;
  private snapshotUpdated = false;
  private firstSyncDone = false;
  private rejections = 0;

  constructor(
    private readonly port: ScriptedFinTSPort,
    reopened: boolean,
  ) {
    this.syncTanGiven = reopened;
    this.firstSyncDone = reopened;
    this.syncPending = port.scenario.decoupledPendingPolls ?? 0;
    this.statementsPending = port.scenario.decoupledPendingPolls ?? 0;
  }

  private get sc(): ScriptedScenario {
    return this.port.scenario;
  }

  private rec(method: string, ...args: unknown[]): void {
    this.port.calls.push({ method, args });
  }

  private ref(base: 'REF-SYNC' | 'REF-STMT'): string {
    return this.rejections === 0 ? base : `${base}-${this.rejections}`;
  }

  private tanResponse(kind: ScriptedTanKind, ref: string): FinTSPortResponse {
    const r: FinTSPortResponse = {
      ...BASE,
      success: true,
      requiresTan: true,
      tanReference: ref,
      tanChallenge: this.sc.tanChallenge ?? 'Please confirm in your banking app',
    };
    if (kind === 'photo') r.tanPhoto = this.sc.photo ?? { mimeType: 'image/png', data: PNG_1PX };
    return r;
  }

  private withTan(
    kind: ScriptedTanKind,
    ref: string,
    tan: string | undefined,
    pending: 'sync' | 'statements',
  ): FinTSPortResponse {
    if (kind === 'decoupled') {
      const left = pending === 'sync' ? this.syncPending : this.statementsPending;
      if (left > 0) {
        if (pending === 'sync') this.syncPending--;
        else this.statementsPending--;
        return this.tanResponse(kind, ref);
      }
      return { ...BASE };
    }
    if (
      this.sc.refuseReusedTanReference &&
      ref !== this.ref(pending === 'sync' ? 'REF-SYNC' : 'REF-STMT')
    )
      return { ...BASE, success: false, bankAnswers: [{ code: 9800, text: 'Dialog beendet' }] };
    if (tan === (this.sc.correctCode ?? SCRIPTED_CORRECT_CODE)) return { ...BASE };
    this.rejections++;
    return { ...BASE, success: false, bankAnswers: [{ code: 9941, text: 'TAN ungueltig' }] };
  }

  private syncKind(): ScriptedTanKind | false {
    return this.sc.syncRequiresTan ?? false;
  }

  private statementsKind(): ScriptedTanKind {
    return this.syncKind() || 'decoupled';
  }

  private failure(): FinTSPortResponse | undefined {
    switch (this.sc.failWith) {
      case 'wrong-pin':
        return {
          ...BASE,
          success: false,
          bankAnswers: [{ code: 9931, text: 'Anmeldename oder PIN falsch USER-TEXT-LEAK' }],
        };
      case 'locked':
        return {
          ...BASE,
          success: false,
          bankAnswers: [{ code: 3938, text: 'Zugang gesperrt' }],
        };
      case 'server-error':
        throw new FinTSPortError('http', 500);
      default:
        return undefined;
    }
  }

  private withBankingInfo<T extends FinTSPortResponse>(r: T): T & { bankingInformation: unknown } {
    return { ...r, bankingInformation: this.bankingInformation() };
  }

  async synchronize(): Promise<FinTSPortResponse & { bankingInformation?: unknown }> {
    this.rec('synchronize');
    if (!this.firstSyncDone) {
      this.firstSyncDone = true;
      const f = this.failure();
      if (f) return f;
      return this.withBankingInfo({ ...BASE, bankingInformationUpdated: true });
    }
    const kind = this.syncKind();
    if (kind && !this.syncTanGiven) return this.tanResponse(kind, this.ref('REF-SYNC'));
    return this.withBankingInfo({ ...BASE });
  }

  async synchronizeWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { bankingInformation?: unknown }> {
    this.rec('synchronizeWithTan', ref, tan);
    const kind = this.syncKind() || 'decoupled';
    const r = this.withTan(kind, ref, tan, 'sync');
    if (r.success && !r.requiresTan) this.syncTanGiven = true;
    return this.withBankingInfo(r);
  }

  selectTanMethod(id: number): void {
    this.rec('selectTanMethod', id);
    this.selected = id;
  }

  availableTanMethods(): FinTSTanMethod[] {
    return this.sc.tanMethods ?? DEFAULT_TAN_METHODS;
  }

  accounts(): FinTSAccount[] {
    return this.sc.accounts ?? [];
  }

  private statementGate(): FinTSPortResponse | undefined {
    if (this.sc.statementsFailWith === 'wrong-pin')
      return { ...BASE, success: false, bankAnswers: [{ code: 9931, text: 'PIN falsch' }] };
    if (this.sc.statementsFailWith === 'server-error') throw new FinTSPortError('http', 500);
    if (this.sc.statementsFailWith === 'decode') throw new FinTSPortError('decode');
    if (this.sc.statementsRequireTan && !this.statementsTanGiven)
      return this.tanResponse(this.statementsKind(), this.ref('REF-STMT'));
    return undefined;
  }

  private statementsOk(
    transactions: FinTSTx[] | undefined,
  ): FinTSPortResponse & { transactions: FinTSTx[] } {
    const updated = this.sc.bankingInformationAfterStatements !== undefined;
    if (updated) this.snapshotUpdated = true;
    return { ...BASE, bankingInformationUpdated: updated, transactions: transactions ?? [] };
  }

  async getStatements(
    acc: FinTSAccount,
    from?: Date,
    to?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }> {
    this.rec('getStatements', acc, from, to);
    return this.statementGate() ?? this.statementsOk(this.sc.transactions);
  }

  async getStatementsWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }> {
    this.rec('getStatementsWithTan', ref, tan);
    const r = this.withTan(this.statementsKind(), ref, tan, 'statements');
    if (r.success && !r.requiresTan) {
      this.statementsTanGiven = true;
      return { ...r, transactions: this.sc.transactions ?? [] };
    }
    return r;
  }

  async getCreditCardStatementsWithTan(
    ref: string,
    tan?: string,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }> {
    this.rec('getCreditCardStatementsWithTan', ref, tan);
    const r = this.withTan(this.statementsKind(), ref, tan, 'statements');
    if (r.success && !r.requiresTan) {
      this.statementsTanGiven = true;
      return { ...r, transactions: this.sc.creditCardTransactions ?? [] };
    }
    return r;
  }

  async getCreditCardStatements(
    acc: FinTSAccount,
    from?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }> {
    this.rec('getCreditCardStatements', acc, from);
    return this.statementGate() ?? this.statementsOk(this.sc.creditCardTransactions);
  }

  async getBalance(
    acc: FinTSAccount,
  ): Promise<FinTSPortResponse & { balance?: { value: number; currency: string } }> {
    this.rec('getBalance', acc);
    if (this.sc.balanceFails) throw new FinTSPortError('network');
    const gate = this.statementGate();
    if (gate) return gate;
    return this.sc.balance ? { ...BASE, balance: this.sc.balance } : { ...BASE };
  }

  bankingInformation(): unknown {
    if (this.snapshotUpdated) return this.sc.bankingInformationAfterStatements;
    return this.sc.bankingInformation ?? DEFAULT_BANKING_INFORMATION;
  }
}

export type { ScriptedSession };
