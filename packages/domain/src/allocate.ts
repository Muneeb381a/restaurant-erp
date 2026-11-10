import { MoneyError, asPaisa, type Paisa } from './money';

/**
 * Splits `total` across `weights` in proportion, so that the parts ALWAYS add up to the whole.
 * Each part is floored; the leftover paisa (at most weights.length - 1) go to the LAST entry
 * (ARCHITECTURE §5 rule 4). If every weight is 0 the total is split equally, remainder last.
 * Used for deal price allocation and equal bill splits.
 */
export function allocateProRata(total: Paisa, weights: readonly number[]): Paisa[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new MoneyError(
      `allocateProRata: total must be a non-negative integer, got ${total}`,
      'MONEY_INVALID_AMOUNT',
    );
  }
  if (weights.length === 0) {
    throw new MoneyError(
      'allocateProRata: at least one weight is required',
      'MONEY_INVALID_AMOUNT',
    );
  }
  if (!weights.every((w) => Number.isSafeInteger(w) && w >= 0)) {
    throw new MoneyError(
      'allocateProRata: weights must be non-negative integers',
      'MONEY_INVALID_AMOUNT',
    );
  }

  const n = weights.length;
  const sum = weights.reduce((acc, w) => acc + BigInt(w), 0n);
  const parts =
    sum === 0n
      ? weights.map(() => BigInt(total) / BigInt(n))
      : weights.map((w) => (BigInt(total) * BigInt(w)) / sum);
  const leftover = BigInt(total) - parts.reduce((acc, p) => acc + p, 0n);
  parts[n - 1] = (parts[n - 1] as bigint) + leftover;
  return parts.map((p) => asPaisa(Number(p)));
}
