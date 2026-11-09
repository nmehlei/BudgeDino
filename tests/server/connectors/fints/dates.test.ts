import { describe, expect, it } from 'vitest';
import { mapTx } from '@budgedino/server/connectors/fints/map';
import type { FinTSTx } from '@budgedino/server/connectors/fints/port';
import { TEST_ZONES, libFintsDist, withTimeZone } from '../../../support/fints/lib-fints-dist';

/**
 * Decode side of the date handling: feed real lib-fints parser output through mapTx under several
 * host zones. MT940 and credit card dates are host-local midnight, CAMT date-only values are
 * host-local noon, CAMT values with an offset are true instants (read in Europe/Berlin).
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

const camt = (bookingDay: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt><GrpHdr><MsgId>1</MsgId><CreDtTm>2026-11-04T10:00:00</CreDtTm></GrpHdr><Rpt><Id>1</Id><CreDtTm>2026-11-04T10:00:00</CreDtTm><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-11-02</Dt></Dt></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">987.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${bookingDay}</Dt></Dt></Bal><Ntry><Amt Ccy="EUR">12.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${bookingDay}</Dt></BookgDt><ValDt><Dt>${bookingDay}</Dt></ValDt><BkTxCd/><NtryDtls><TxDtls><RmtInf><Ustrd>Coffee</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Rpt></BkToCstmrAcctRpt></Document>`;

interface ParsedStatement {
  transactions: FinTSTx[];
}
type Parse = (text: string) => ParsedStatement[];

async function parsers(): Promise<{ mt940: Parse; camtParse: Parse }> {
  const { Mt940Parser: Mt } = await libFintsDist<{
    Mt940Parser: new (t: string) => { parse(): ParsedStatement[] };
  }>('mt940parser.js');
  const { CamtParser } = await libFintsDist<{
    CamtParser: new (t: string) => { parse(): ParsedStatement[] };
  }>('camtParser.js');
  return {
    mt940: (t) => new Mt(t).parse(),
    camtParse: (t) => new CamtParser(t).parse(),
  };
}

describe('lib-fints parser dates through mapTx', () => {
  for (const tz of TEST_ZONES) {
    it(`MT940: booking date is the statement day on a ${tz} host`, async () => {
      await withTimeZone(tz, async () => {
        const { mt940 } = await parsers();
        const t = mt940(MT940)[0]?.transactions[0] as FinTSTx;
        const m = mapTx(t, 'EUR');
        // :61: 261103 (value) 1102 (entry month/day)
        expect(m.bookingDate, tz).toBe('2026-11-02');
        expect(m.valueDate, tz).toBe('2026-11-03');
      });
    });

    it(`CAMT: date-only and offset forms map to the Berlin day on a ${tz} host`, async () => {
      await withTimeZone(tz, async () => {
        const { camtParse } = await parsers();
        for (const day of ['2026-11-03', '2026-11-03+01:00', '2026-11-03T00:00:00+01:00']) {
          const t = camtParse(camt(day))[0]?.transactions[0] as FinTSTx;
          const m = mapTx(t, 'EUR');
          expect(m.bookingDate, `${tz} ${day}`).toBe('2026-11-03');
          expect(m.valueDate, `${tz} ${day}`).toBe('2026-11-03');
        }
      });
    });
  }
});
