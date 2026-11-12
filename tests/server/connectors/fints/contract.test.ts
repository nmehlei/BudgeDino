import { describe, expect, it } from 'vitest';
import { createFinTSConnector } from '@budgedino/server/connectors/fints/connector';
import { FinTSDialogRegistry } from '@budgedino/server/connectors/fints/dialogs';
import type { FinTSBankParams, FinTSSession } from '@budgedino/server/connectors/fints/port';
import type { Connector } from '@budgedino/server/connectors/types';
import {
  ScriptedFinTSPort,
  SCRIPTED_CORRECT_CODE,
  type ScriptedScenario,
} from '../../../support/fints/scripted-port';
import {
  authenticate,
  makeCtx,
  runConnectorContract,
  type ConnectorContractScript,
} from '../contract';

const IBAN = 'DE89370400440532013000';
const FAIL_MARKER = 'contract-failing-state';
const config = { bank: 'dkb', userId: 'CONTRACT-USER', pin: 'CONTRACT-PIN' };

/** Scripted bank that, once reopened from a marked snapshot, demands a TAN for statements. */
class ContractPort extends ScriptedFinTSPort {
  override openFromState(
    p: FinTSBankParams,
    bankingInformation: unknown,
    tanMethodId: number,
  ): FinTSSession {
    if ((bankingInformation as { marker?: string } | undefined)?.marker === FAIL_MARKER)
      this.scenario.statementsRequireTan = true;
    return super.openFromState(p, bankingInformation, tanMethodId);
  }
}

function makeConnectorAndPort(scenario: ScriptedScenario): {
  connector: Connector;
  port: ContractPort;
} {
  const port = new ContractPort({
    accounts: [
      {
        iban: IBAN,
        accountNumber: '532013000',
        blz: '12030000',
        accountType: 'CheckingAccount',
        currency: 'EUR',
      },
    ],
    transactions: [
      {
        valueDate: '2026-01-10',
        bookingDate: '2026-01-09',
        amount: -12.5,
        purpose: 'Einkauf',
        remoteName: 'REWE',
      },
    ],
    balance: { value: 100, currency: 'EUR' },
    ...scenario,
  });
  const connector = createFinTSConnector({
    port,
    dialogs: new FinTSDialogRegistry({ now: () => new Date('2026-01-15T12:00:00Z') }),
    product: { id: 'PID', version: '1.0' },
  });
  return { connector, port };
}

const makeConnector = (scenario: ScriptedScenario): Connector =>
  makeConnectorAndPort(scenario).connector;

const answer: ConnectorContractScript['answer'] = (challenge) =>
  challenge.kind === 'decoupled'
    ? { kind: 'decoupled' }
    : { kind: 'code', code: SCRIPTED_CORRECT_CODE };

function scriptFor(scenario: ScriptedScenario): ConnectorContractScript {
  return {
    config,
    answer,
    accountRef: IBAN,
    since: null,
    // The bank snapshot in the state carries the marker, so whichever connector later reopens the
    // state sees statements that demand a TAN.
    failingState: () =>
      authenticate(
        makeConnector({
          ...scenario,
          bankingInformation: { marker: FAIL_MARKER, bpd: {}, upd: { accounts: [] } },
        }),
        config,
        answer,
        makeCtx(),
      ),
  };
}

const scenarios: Array<[string, ScriptedScenario]> = [
  ['decoupled', { decoupledPendingPolls: 1 }],
  [
    'code',
    {
      tanMethods: [{ id: 910, name: 'SMS', decoupled: false, kind: 'code' }],
      syncRequiresTan: 'code',
    },
  ],
  [
    'image',
    {
      tanMethods: [{ id: 911, name: 'Photo', decoupled: false, kind: 'photo' }],
      syncRequiresTan: 'photo',
    },
  ],
];

for (const [kind, scenario] of scenarios)
  runConnectorContract(`fints (${kind})`, () => makeConnector(scenario), scriptFor(scenario));

describe('fints failing state', () => {
  it('fails because statements demand a TAN: needs_attention, and the bank flag was set on reopen', async () => {
    const scenario: ScriptedScenario = { decoupledPendingPolls: 1 };
    const { connector, port } = makeConnectorAndPort({
      ...scenario,
      bankingInformation: { marker: FAIL_MARKER, bpd: {}, upd: { accounts: [] } },
    });
    const state = await authenticate(connector, config, answer, makeCtx());
    expect(port.scenario.statementsRequireTan).toBeUndefined();
    const result = await connector.fetchTransactions(state, IBAN, null, makeCtx(), config);
    expect(port.scenario.statementsRequireTan).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('needs_attention');
  });
});
