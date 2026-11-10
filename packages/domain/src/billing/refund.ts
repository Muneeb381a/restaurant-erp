import { allocateProRata } from '../allocate';
import { asPaisa, mulDivHalfUp, type Paisa } from '../money';

export class RefundError extends Error {
  constructor(
    readonly code:
      | 'REFUND_EMPTY'
      | 'REFUND_QTY_INVALID'
      | 'REFUND_QTY_EXCEEDS'
      | 'REFUND_UNKNOWN_LINE'
      | 'REFUND_DUPLICATE_LINE',
    message: string,
  ) {
    super(message);
    this.name = 'RefundError';
  }
}

export interface RefundBill {
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
}
export interface RefundableLine {
  id: string;
  /** Line amount before the bill-level discount and service charge. */
  netPaisa: number;
  /** Quantity in thousandths (1 = 0.001), so weights stay integers. */
  qtyMilli: number;
  /** Already returned by earlier credit notes. */
  refundedQtyMilli: number;
}
export interface RefundRequestLine {
  lineId: string;
  qtyMilli: number;
}
export interface RefundResult {
  lines: { lineId: string; qtyMilli: number; paisa: Paisa }[];
  /** What goes back to the customer, including the round-off when the bill is fully returned. */
  totalPaisa: Paisa;
  /** Every line of the bill has now been returned in full. */
  completesBill: boolean;
}

/** Signed version of mulDivHalfUp (a line's share can be negative in extreme discount cases). */
const share = (value: number, numerator: number, denominator: number): number =>
  value < 0
    ? -mulDivHalfUp(-value, numerator, denominator)
    : mulDivHalfUp(value, numerator, denominator);

/**
 * What the customer actually paid for each line: its net, less its share of the bill discount, plus
 * its share of the service charge. By construction Σ = subtotal − discount + service = total − roundOff.
 */
export function linePaidValues(bill: RefundBill, lines: readonly { netPaisa: number }[]): number[] {
  const nets = lines.map((l) => l.netPaisa);
  const disc = allocateProRata(asPaisa(bill.discountPaisa), nets);
  const svc = allocateProRata(asPaisa(bill.serviceChargePaisa), nets);
  return nets.map((n, i) => n - (disc[i] as number) + (svc[i] as number));
}

/**
 * Pure credit-note maths. Returning `q` of a line of quantity `Q` is worth V(refunded + q) − V(refunded)
 * with V(r) = paid × r / Q (half-up) — a telescoping sum, so returning a line in several steps gives
 * exactly the same total as returning it at once, and the parts always add up to the whole.
 * The bill's round-off is returned together with the last line.
 */
export function computeRefund(
  bill: RefundBill,
  lines: readonly RefundableLine[],
  request: readonly RefundRequestLine[],
): RefundResult {
  if (request.length === 0) throw new RefundError('REFUND_EMPTY', 'Choose what to return');
  const seen = new Set<string>();
  const paid = linePaidValues(bill, lines);

  const out = request.map((r) => {
    if (seen.has(r.lineId))
      throw new RefundError('REFUND_DUPLICATE_LINE', 'A line can only be listed once');
    seen.add(r.lineId);
    const i = lines.findIndex((l) => l.id === r.lineId);
    if (i < 0) throw new RefundError('REFUND_UNKNOWN_LINE', 'That line is not on this bill');
    const line = lines[i] as RefundableLine;
    if (!Number.isSafeInteger(r.qtyMilli) || r.qtyMilli <= 0)
      throw new RefundError('REFUND_QTY_INVALID', 'The quantity must be above zero');
    const after = line.refundedQtyMilli + r.qtyMilli;
    if (after > line.qtyMilli)
      throw new RefundError('REFUND_QTY_EXCEEDS', 'More than was sold on this line');
    const v = (q: number): number => share(paid[i] as number, q, line.qtyMilli);
    return {
      lineId: r.lineId,
      qtyMilli: r.qtyMilli,
      paisa: asPaisa(v(after) - v(line.refundedQtyMilli)),
    };
  });

  const returnedNow = new Map(request.map((r) => [r.lineId, r.qtyMilli]));
  const completesBill = lines.every(
    (l) => l.refundedQtyMilli + (returnedNow.get(l.id) ?? 0) === l.qtyMilli,
  );
  const sum = out.reduce((n, l) => n + l.paisa, 0);
  return {
    lines: out,
    totalPaisa: asPaisa(sum + (completesBill ? bill.roundOffPaisa : 0)),
    completesBill,
  };
}
