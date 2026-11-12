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
  /** Fails every statement/credit-card call (Task 5). `init-failed`: the bank rejected the dialog init. */
  statementsFailWith?: 'wrong-pin' | 'server-error' | 'decode' | 'init-failed' | 'network';
  /** Statement calls fail with this bank answer code (no TAN, `success: false`). */
  statementsAnswerCode?: number;
  /** Account numbers the bank offers no statements for (`canGetStatements` false, calls `unsupported`). */
  noStatementsFor?: string[];
  /** The next N `synchronizeWithTan` calls fail with a network error (transient). */
  pollNetworkFailures?: number;
  /** Decoupled "still pending" status responses carry no tanReference. */
  omitPendingTanReference?: boolean;
  /** TAN medium of the selected method. */
  tanMedia?: { required: boolean; active: string[] };
  /** Statement calls report `bankingInformationUpdated` and switch the snapshot to this value. */
  bankingInformationAfterStatements?: unknown;
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
    tanMediaName?: string,
  ): FinTSSession {
    this.calls.push({
      method: 'openFromState',
      args: [p, bankingInformation, tanMethodId, tanMediaName],
    });
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
  private networkFailures = 0;

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
        const pendingResponse = this.tanResponse(kind, ref);
        if (this.sc.omitPendingTanReference) delete pendingResponse.tanReference;
        return pendingResponse;
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
    if ((this.sc.pollNetworkFailures ?? 0) > this.networkFailures++)
      throw new FinTSPortError('network');
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

  tanMedia(): { required: boolean; active: string[] } {
    return this.sc.tanMedia ?? { required: false, active: [] };
  }

  selectTanMedia(name: string): void {
    this.rec('selectTanMedia', name);
  }

  canGetStatements(acc: FinTSAccount): boolean {
    return !(this.sc.noStatementsFor ?? []).includes(acc.accountNumber);
  }

  private assertSupported(acc: FinTSAccount): void {
    if (!this.canGetStatements(acc)) throw new FinTSPortError('unsupported');
  }

  private flagUpdate<T extends FinTSPortResponse>(r: T): T {
    if (this.sc.bankingInformationAfterStatements === undefined) return r;
    this.snapshotUpdated = true;
    return { ...r, bankingInformationUpdated: true };
  }

  private statementGate(): FinTSPortResponse | undefined {
    const r = this.rawStatementGate();
    return r ? this.flagUpdate(r) : undefined;
  }

  private rawStatementGate(): FinTSPortResponse | undefined {
    if (this.sc.statementsFailWith === 'wrong-pin')
      return { ...BASE, success: false, bankAnswers: [{ code: 9931, text: 'PIN falsch' }] };
    if (this.sc.statementsFailWith === 'server-error') throw new FinTSPortError('http', 500);
    if (this.sc.statementsFailWith === 'decode') throw new FinTSPortError('decode');
    if (this.sc.statementsFailWith === 'network') throw new FinTSPortError('network');
    if (this.sc.statementsFailWith === 'init-failed')
      return {
        ...BASE,
        success: false,
        initFailed: true,
        bankAnswers: [{ code: 9050, text: 'Nachricht enthaelt Fehler' }],
      };
    if (this.sc.statementsAnswerCode !== undefined)
      return {
        ...BASE,
        success: false,
        bankAnswers: [{ code: this.sc.statementsAnswerCode, text: 'ANSWER-TEXT-LEAK' }],
      };
    if (this.sc.statementsRequireTan && !this.statementsTanGiven)
      return this.tanResponse(this.statementsKind(), this.ref('REF-STMT'));
    return undefined;
  }

  private statementsOk(transactions: FinTSTx[] | undefined): FinTSPortResponse & {
    transactions: FinTSTx[];
    balance?: { value: number; currency: string };
  } {
    return {
      ...this.flagUpdate({ ...BASE }),
      transactions: transactions ?? [],
      ...(this.sc.balance ? { balance: this.sc.balance } : {}),
    };
  }

  async getStatements(
    acc: FinTSAccount,
    from?: Date,
    to?: Date,
  ): Promise<FinTSPortResponse & { transactions?: FinTSTx[] }> {
    this.rec('getStatements', acc, from, to);
    this.assertSupported(acc);
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
    this.assertSupported(acc);
    return this.statementGate() ?? this.statementsOk(this.sc.creditCardTransactions);
  }

  bankingInformation(): unknown {
    if (this.snapshotUpdated) return this.sc.bankingInformationAfterStatements;
    return this.sc.bankingInformation ?? DEFAULT_BANKING_INFORMATION;
  }
}

export type { ScriptedSession };
