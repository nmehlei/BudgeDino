import { describe, expect, it } from 'vitest';
import { LibFintsPort } from '@budgedino/server/connectors/fints/lib-fints-port';
import { mapTx } from '@budgedino/server/connectors/fints/map';
import { TEST_ZONES, libFintsDist, withTimeZone } from '../../../support/fints/lib-fints-dist';

/**
 * Decode side of the date handling: real lib-fints parser output goes through the real port
 * mapping (LibFintsPort) and mapTx; every case must yield the bank's written calendar day on any
 * host zone. MT940 and credit card dates are built with local constructors (read with local
 * getters); CAMT dates are read from the raw strings kept by our lib-fints patch.
 */
const MT940 = [
  ':20:STARTUMS',
  ':25:12030000/532013000',
  ':28C:0',
  ':60F:C261031EUR1000,00',
  ':61:2611031102D12,50NMSCNONREF',
  ':86:177?00Kartenzahlung?20Coffee?32Cafe',
  ':62F:C261103EUR987,50',
  '',
].join('\r\n');

const camtDoc = (bookingDay: string, valueDay = bookingDay) =>
  `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt><GrpHdr><MsgId>1</MsgId><CreDtTm>2026-11-04T10:00:00</CreDtTm></GrpHdr><Rpt><Id>1</Id><CreDtTm>2026-11-04T10:00:00</CreDtTm><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-02</Dt></Dt></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">987.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-03</Dt></Dt></Bal><Ntry><Amt Ccy="EUR">12.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${bookingDay}</Dt></BookgDt><ValDt><Dt>${valueDay}</Dt></ValDt><BkTxCd/><NtryDtls><TxDtls><RmtInf><Ustrd>Coffee</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;

type Statements = unknown[];

const info = {
  systemId: 'S',
  bpd: {
    version: 1,
    countryCode: 280,
    bankId: '12030000',
    bankName: 'T',
    maxTransactionsPerMessage: 0,
    supportedLanguages: [],
    supportedHbciVersions: [300],
    url: 'https://fints.example.invalid/fints',
    supportedTanMethods: [
      {
        id: 920,
        name: 'App',
        version: 7,
        isDecoupled: true,
        activeTanMediaCount: 0,
        activeTanMedia: [],
        tanMediaRequirement: 0,
        decoupled: {
          maxStatusRequests: 10,
          waitingSecondsBeforeFirstStatusRequest: 5,
          waitingSecondsBetweenStatusRequests: 2,
          manualConfirmationAllowed: false,
          autoConfirmationAllowed: true,
        },
      },
    ],
    availableTanMethodIds: [920],
    allowedTransactions: [],
  },
  upd: {
    version: 1,
    usage: 2,
    bankAccounts: [
      {
        accountNumber: '532013000',
        bank: { country: 280, bankId: '12030000' },
        iban: 'DE89370400440532013000',
        customerId: 'c',
        accountType: 'CheckingAccount',
        currency: 'EUR',
        holder1: 'Max',
      },
    ],
  },
};
const params = {
  productId: 'PID',
  productVersion: '1.0',
  url: 'https://fints.example.invalid/fints',
  blz: '12030000',
  userId: 'u',
  pin: 'p',
};
const account = {
  iban: 'DE89370400440532013000',
  accountNumber: '532013000',
  blz: '12030000',
  accountType: 'CheckingAccount' as const,
};

/** Runs statements through the real LibFintsPort mapping, as lib-fints would have returned them. */
async function mapped(statements: Statements, creditCard = false) {
  const response = {
    success: true,
    requiresTan: false,
    bankAnswers: [],
    bankingInformationUpdated: false,
    dialogId: 'd',
    statements,
  };
  const session = new LibFintsPort({
    onClientCreated: (c) =>
      Object.assign(c, {
        [creditCard ? 'getCreditCardStatements' : 'getAccountStatements']: () =>
          Promise.resolve(response),
      }),
  }).openFromState(params, info, 920);
  const r = creditCard
    ? await session.getCreditCardStatements(account)
    : await session.getStatements(account);
  return (r.transactions ?? []).map((t) => mapTx(t, 'EUR'));
}

interface Parsers {
  mt940(t: string): Statements;
  camt(t: string): Statements;
}
async function parsers(): Promise<Parsers> {
  const { Mt940Parser } = await libFintsDist<{
    Mt940Parser: new (t: string) => { parse(): Statements };
  }>('mt940parser.js');
  const { CamtParser } = await libFintsDist<{
    CamtParser: new (t: string) => { parse(): Statements };
  }>('camtParser.js');
  return {
    mt940: (t) => new Mt940Parser(t).parse(),
    camt: (t) => new CamtParser(t).parse(),
  };
}

const CAMT_CASES: [string, string][] = [
  ['date only', '2026-11-03'],
  ['date with offset', '2026-11-03+01:00'],
  ['DtTm without offset (late evening)', '2026-11-03T23:30:00'],
  ['DtTm without offset (early morning)', '2026-11-03T00:15:00'],
  ['DtTm with +01:00 midnight', '2026-11-03T00:00:00+01:00'],
  ['DtTm with +14:00 midnight', '2026-11-03T00:00:00+14:00'],
  ['DtTm with -08:00 late evening', '2026-11-03T23:45:00-08:00'],
  ['DtTm UTC', '2026-11-03T23:59:59Z'],
];

describe('lib-fints parser dates through LibFintsPort and mapTx', () => {
  for (const tz of TEST_ZONES) {
    it(`MT940 on a ${tz} host`, async () => {
      await withTimeZone(tz, async () => {
        const { mt940 } = await parsers();
        const [m] = await mapped(mt940(MT940));
        // :61: 261103 (value) 1102 (entry month/day)
        expect(m?.bookingDate, tz).toBe('2026-11-02');
        expect(m?.valueDate, tz).toBe('2026-11-03');
      });
    });

    it(`credit card entries on a ${tz} host`, async () => {
      await withTimeZone(tz, async () => {
        const entry = {
          transactionDate: new Date(2026, 10, 3),
          valueDate: new Date(2026, 10, 4),
          amount: -5,
          purpose: 'x',
        };
        const [m] = await mapped([entry], true);
        expect(m?.bookingDate, tz).toBe('2026-11-03');
        expect(m?.valueDate, tz).toBe('2026-11-04');
      });
    });

    it(`CAMT keeps the written day on a ${tz} host`, async () => {
      await withTimeZone(tz, async () => {
        const { camt: parseCamt } = await parsers();
        for (const [label, day] of CAMT_CASES) {
          const [m] = await mapped(parseCamt(camtDoc(day)));
          expect(m?.bookingDate, `${tz} ${label}`).toBe('2026-11-03');
          expect(m?.valueDate, `${tz} ${label}`).toBe('2026-11-03');
        }
        // booking and value day differ
        const [d] = await mapped(parseCamt(camtDoc('2026-11-03', '2026-11-05T00:00:00+14:00')));
        expect([d?.bookingDate, d?.valueDate], tz).toEqual(['2026-11-03', '2026-11-05']);
      });
    });
  }
});
