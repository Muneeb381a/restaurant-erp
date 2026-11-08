/**
 * Money is an integer number of paisa (1 PKR = 100 paisa). Never a float.
 * Represented as a branded `number`; values must stay within Number.MAX_SAFE_INTEGER
 * (≈ Rs 90 trillion), which is far beyond any restaurant bill. See docs/adr/0001-money-type.md.
 */
export type Paisa = number & { readonly __brand: 'Paisa' };

export class MoneyError extends Error {
  readonly code = 'MONEY_NOT_SAFE_INTEGER';
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
