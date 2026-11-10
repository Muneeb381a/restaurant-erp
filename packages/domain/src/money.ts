/**
 * Money is an integer number of paisa (1 PKR = 100 paisa). Never a float.
 * Represented as a branded `number`; values must stay within Number.MAX_SAFE_INTEGER
 * (≈ Rs 90 trillion), which is far beyond any restaurant bill. See docs/adr/0001-money-type.md.
 */
export type Paisa = number & { readonly __brand: 'Paisa' };

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code: 'MONEY_NOT_SAFE_INTEGER' | 'MONEY_INVALID_AMOUNT' = 'MONEY_NOT_SAFE_INTEGER',
  ) {
    super(message);
  }
}

/** Validates and brands an integer paisa amount. Throws on floats / unsafe integers. */
export function asPaisa(value: number): Paisa {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Not a safe integer paisa amount: ${String(value)}`);
  }
  return value as Paisa;
}

/** Parses a Postgres BIGINT text value (as returned by node-postgres) into Paisa. */
export function paisaFromDb(text: string): Paisa {
  if (!/^-?\d+$/.test(text)) {
    throw new MoneyError(`Not an integer string: ${text}`);
  }
  return asPaisa(Number(text));
}

// Whole part: plain digits, or standard thousands grouping (1,250 / 1,250,000).
// Lakh grouping (1,25,000) is rejected on purpose: it is ambiguous with typos.
const RUPEES_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a human-typed rupee amount ("1250", "1,250.5", "99.99") into integer paisa.
 * Pure string/integer arithmetic — no floats. Rejects negatives, >2 decimals and junk.
 */
export function parseRupees(input: string): Paisa {
  const m = RUPEES_RE.exec(input.trim());
  if (!m) throw new MoneyError(`Invalid rupee amount: "${input}"`, 'MONEY_INVALID_AMOUNT');
  const whole = Number((m[1] as string).replace(/,/g, ''));
  const fraction = Number((m[2] ?? '').padEnd(2, '0'));
  return asPaisa(whole * 100 + fraction);
}

/**
 * `round_half_up(amount × numerator / denominator)` in exact integer arithmetic (BigInt), so no
 * float error and no intermediate overflow. Used for weight pricing, percentages and tax.
 * `amount` and `numerator` must be non-negative integers, `denominator` a positive integer.
 */
export function mulDivHalfUp(amount: number, numerator: number, denominator: number): Paisa {
  const ints = [amount, numerator, denominator];
  if (!ints.every(Number.isSafeInteger) || amount < 0 || numerator < 0 || denominator <= 0) {
    throw new MoneyError(
      `mulDivHalfUp needs non-negative integers and a positive divisor, got ${ints.join(', ')}`,
      'MONEY_INVALID_AMOUNT',
    );
  }
  const x = BigInt(amount) * BigInt(numerator);
  const d = BigInt(denominator);
  return asPaisa(Number((2n * x + d) / (2n * d)));
}

/** Plain decimal rupees for CSV/export ("1250.50"). UI adds currency symbols/grouping. */
export function formatPaisa(value: Paisa): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
