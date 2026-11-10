import { allocateProRata } from '../allocate';
import { asPaisa, mulDivHalfUp, type Paisa } from '../money';

export type TaxClass = 'CASH_OTHER' | 'DIGITAL';

export class TaxError extends Error {
  constructor(
    readonly code: 'TAX_RULE_MISSING' | 'TAX_RULE_AMBIGUOUS' | 'TAX_INPUT_INVALID',
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TaxError';
  }
}

/** One effective-dated rate from the `tax_rules` table. Nothing here is hard-coded: rates come from data. */
export interface TaxRule {
  id: string;
  authority: string;
  categoryId: string;
  /** `ANY` applies to every payment class. */
  paymentClass: TaxClass | 'ANY';
  rateBps: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
}

/**
 * The single rule that applies on `date` for a category and payment class. A missing rule and an
 * ambiguous one (two rules that both apply, including a class-specific rule next to an ANY rule)
 * are hard errors — a bill is never taxed with a guessed rate.
 */
export function resolveRule(
  rules: readonly TaxRule[],
  q: { authority: string; categoryId: string; paymentClass: TaxClass; date: string },
): TaxRule {
  const hits = rules.filter(
    (r) =>
      r.authority === q.authority &&
      r.categoryId === q.categoryId &&
      (r.paymentClass === q.paymentClass || r.paymentClass === 'ANY') &&
      r.effectiveFrom <= q.date &&
      (r.effectiveTo === null || r.effectiveTo >= q.date),
  );
  if (hits.length === 0)
    throw new TaxError(
      'TAX_RULE_MISSING',
      `No tax rule for category ${q.categoryId}, ${q.paymentClass}, on ${q.date}`,
      { categoryId: q.categoryId, paymentClass: q.paymentClass, date: q.date },
    );
  if (hits.length > 1)
    throw new TaxError('TAX_RULE_AMBIGUOUS', `More than one tax rule applies on ${q.date}`, {
      categoryId: q.categoryId,
      paymentClass: q.paymentClass,
      date: q.date,
      ruleIds: hits.map((h) => h.id),
    });
  return hits[0] as TaxRule;
}

export interface TaxLineInput {
  id: string;
  /** Line amount before the bill-level discount and service charge. */
  netPaisa: number;
  categoryId: string;
}
export interface TaxLineResult {
  id: string;
  taxPaisa: Paisa;
  rateBps: number;
  ruleId: string;
}
export interface TaxResult {
  lines: TaxLineResult[];
  taxPaisa: Paisa;
  /** Set when every line was taxed by the same rule (then the bill can show one rate). */
  singleRule: { ruleId: string; rateBps: number } | null;
}

const signedShare = (value: number, rate: number): number =>
  value < 0 ? -mulDivHalfUp(-value, rate, 10_000) : mulDivHalfUp(value, rate, 10_000);

/**
 * Tax of a bill: each line's taxable base is its net less its share of the bill discount, plus (when
 * `serviceChargeTaxable`) its share of the service charge; the line's own rule rate is applied to that
 * base, half-up, and the bill tax is the SUM of the line taxes — so the parts always equal the whole
 * and a credit note can reverse a line's tax exactly.
 */
export function computeTax(input: {
  lines: readonly TaxLineInput[];
  discountPaisa: number;
  serviceChargePaisa: number;
  serviceChargeTaxable: boolean;
  /** Resolves the rule of a category (throws TaxError when missing/ambiguous). */
  ruleFor: (categoryId: string) => TaxRule;
}): TaxResult {
  const { lines } = input;
  if (lines.length === 0)
    throw new TaxError('TAX_INPUT_INVALID', 'A bill without lines has nothing to tax');
  const nets = lines.map((l) => l.netPaisa);
  const disc = allocateProRata(asPaisa(input.discountPaisa), nets);
  const svc = input.serviceChargeTaxable
    ? allocateProRata(asPaisa(input.serviceChargePaisa), nets)
    : nets.map(() => 0);
  const results = lines.map((l, i): TaxLineResult => {
    const rule = input.ruleFor(l.categoryId);
    const base = l.netPaisa - (disc[i] as number) + (svc[i] as number);
    return {
      id: l.id,
      taxPaisa: asPaisa(signedShare(base, rule.rateBps)),
      rateBps: rule.rateBps,
      ruleId: rule.id,
    };
  });
  const first = results[0] as TaxLineResult;
  const same = results.every((r) => r.ruleId === first.ruleId);
  return {
    lines: results,
    taxPaisa: asPaisa(results.reduce((n, r) => n + r.taxPaisa, 0)),
    singleRule: same ? { ruleId: first.ruleId, rateBps: first.rateBps } : null,
  };
}

/** Rule overlap check for the admin screen: do two rules of the same scope share any day? */
export function rulesOverlap(
  a: Pick<TaxRule, 'authority' | 'categoryId' | 'paymentClass' | 'effectiveFrom' | 'effectiveTo'>,
  b: Pick<TaxRule, 'authority' | 'categoryId' | 'paymentClass' | 'effectiveFrom' | 'effectiveTo'>,
): boolean {
  if (a.authority !== b.authority || a.categoryId !== b.categoryId) return false;
  const sameScope =
    a.paymentClass === b.paymentClass || a.paymentClass === 'ANY' || b.paymentClass === 'ANY';
  if (!sameScope) return false;
  const aEnd = a.effectiveTo ?? '9999-12-31';
  const bEnd = b.effectiveTo ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}
