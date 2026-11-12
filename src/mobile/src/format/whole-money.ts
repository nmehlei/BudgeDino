import { currencyExponent } from '@budgedino/shared';

import { formatMoney } from './money';

/** Whole currency units: `formatMoney` without the decimals (chart axes, bar labels). */
export function formatWholeMoney(minor: bigint, currency: string): string {
  const text = formatMoney({ minor, currency });
  const exponent = currencyExponent(currency);
  return exponent === 0 ? text : text.replace(new RegExp(`,\\d{${String(exponent)}}(?=\\D*$)`), '');
}
