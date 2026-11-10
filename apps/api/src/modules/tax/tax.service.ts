import {
  computeTax,
  resolveRule,
  rulesOverlap,
  TaxError,
  type TaxClass,
  type TaxResult,
  type TaxRule,
} from '@erp/domain';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import type { Actor } from '../orders/orders.service';

/**
 * The tax engine's data side. Rates are rows in `tax_rules` that the owner or accountant maintains;
 * nothing here knows a rate. Tax is off until `tax.enabled` is switched on (see `taxReadiness`).
 */

export interface TaxContext {
  enabled: boolean;
  authority: string;
  serviceChargeTaxable: boolean;
  rules: TaxRule[];
}

const toRule = (r: {
  id: string;
  authority: string;
  tax_category_id: string;
  payment_class: string;
  rate_bps: number;
  effective_from: string;
  effective_to: string | null;
}): TaxRule => ({
  id: r.id,
  authority: r.authority,
  categoryId: r.tax_category_id,
  paymentClass: r.payment_class as TaxRule['paymentClass'],
  rateBps: r.rate_bps,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
});

export async function loadTaxContext(q: Queryable, branchId: string): Promise<TaxContext> {
  const [branch, settings] = await Promise.all([
    q
      .selectFrom('branches')
      .select('tax_authority')
      .where('id', '=', branchId)
      .executeTakeFirstOrThrow(),
    q
      .selectFrom('settings')
      .select(['key', 'value'])
      .where('branch_id', '=', branchId)
      .where('key', 'in', ['tax.enabled', 'tax.service_charge_taxable'])
      .execute(),
  ]);
  const get = (k: string): unknown => settings.find((s) => s.key === k)?.value;
  const enabled = get('tax.enabled') === true;
  const rules = enabled
    ? (
        await q
          .selectFrom('tax_rules')
          .selectAll()
          .where('authority', '=', branch.tax_authority)
          .execute()
      ).map(toRule)
    : [];
  return {
    enabled,
    authority: branch.tax_authority,
    serviceChargeTaxable: get('tax.service_charge_taxable') !== false,
    rules,
  };
}

/** Domain tax errors become stable, documented API errors (a bill is never taxed with a guessed rate). */
export function asApiTaxError(e: unknown): never {
  if (e instanceof TaxError) {
    const status = e.code === 'TAX_INPUT_INVALID' ? 400 : 409;
    throw new AppError(
      status,
      e.code === 'TAX_INPUT_INVALID' ? 'VALIDATION_FAILED' : e.code,
      e.message,
      e.extra,
    );
  }
  throw e;
}

/** Tax for a priced bill; all zero (and no rule) when tax is switched off. */
export function taxFor(
  tctx: TaxContext,
  input: {
    lines: { id: string; netPaisa: number; categoryId: string }[];
    discountPaisa: number;
    serviceChargePaisa: number;
    paymentClass: TaxClass;
    date: string;
  },
): TaxResult | null {
  if (!tctx.enabled) return null;
  try {
    return computeTax({
      lines: input.lines,
      discountPaisa: input.discountPaisa,
      serviceChargePaisa: input.serviceChargePaisa,
      serviceChargeTaxable: tctx.serviceChargeTaxable,
      ruleFor: (categoryId) =>
        resolveRule(tctx.rules, {
          authority: tctx.authority,
          categoryId,
          paymentClass: input.paymentClass,
          date: input.date,
        }),
    });
  } catch (e) {
    return asApiTaxError(e);
  }
}

// ──────────────────────────────── readiness ────────────────────────────────

export interface TaxProblem {
  code: 'AUTHORITY_NOT_SET' | 'RULE_MISSING' | 'RULE_AMBIGUOUS' | 'RULE_UNVERIFIED';
  message: string;
  categoryCode?: string;
  paymentClass?: TaxClass;
  ruleId?: string;
}

/**
 * Can tax be switched on safely? The branch needs a tax authority, and EVERY category in use needs
 * exactly one rule for both payment classes today, each confirmed by a named person (`verified_by`).
 */
export async function taxReadiness(
  ctx: AppContext,
  branchId: string,
): Promise<{ ready: boolean; problems: TaxProblem[]; date: string }> {
  const q = ctx.db;
  const branch = await q
    .selectFrom('branches')
    .select(['tax_authority', 'timezone'])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
  const day = await q
    .selectFrom('business_days')
    .select('business_date')
    .where('branch_id', '=', branchId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  const date =
    day?.business_date ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: branch.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(ctx.clock.now());
  const problems: TaxProblem[] = [];
  if (branch.tax_authority === 'NONE')
    problems.push({
      code: 'AUTHORITY_NOT_SET',
      message: 'Choose the tax authority of this branch (for example PRA)',
    });

  const used = await q
    .selectFrom('items')
    .innerJoin('tax_categories', 'tax_categories.id', 'items.tax_category_id')
    .select(['tax_categories.id as id', 'tax_categories.code as code'])
    .where('items.branch_id', '=', branchId)
    .where('items.is_active', '=', true)
    .groupBy(['tax_categories.id', 'tax_categories.code'])
    .execute();
  const rules = await q
    .selectFrom('tax_rules')
    .selectAll()
    .where('authority', '=', branch.tax_authority)
    .execute();
  for (const cat of used) {
    for (const paymentClass of ['CASH_OTHER', 'DIGITAL'] as const) {
      try {
        const rule = resolveRule(rules.map(toRule), {
          authority: branch.tax_authority,
          categoryId: cat.id,
          paymentClass,
          date,
        });
        const row = rules.find((r) => r.id === rule.id)!;
        if (!row.verified_by?.trim())
          problems.push({
            code: 'RULE_UNVERIFIED',
            message: `The ${paymentClass} rule for ${cat.code} is not confirmed by anyone yet`,
            categoryCode: cat.code,
            paymentClass,
            ruleId: rule.id,
          });
      } catch (e) {
        if (e instanceof TaxError)
          problems.push({
            code: e.code === 'TAX_RULE_AMBIGUOUS' ? 'RULE_AMBIGUOUS' : 'RULE_MISSING',
            message:
              e.code === 'TAX_RULE_AMBIGUOUS'
                ? `More than one ${paymentClass} rule applies to ${cat.code} on ${date}`
                : `No ${paymentClass} rule for ${cat.code} on ${date}`,
            categoryCode: cat.code,
            paymentClass,
          });
        else throw e;
      }
    }
  }
  return { ready: problems.length === 0, problems, date };
}

/** Switching tax ON needs a clean readiness report; switching it off is always allowed. */
export async function assertCanEnableTax(ctx: AppContext, branchId: string): Promise<void> {
  const r = await taxReadiness(ctx, branchId);
  if (!r.ready)
    throw new AppError(409, 'TAX_NOT_READY', 'Tax cannot be switched on yet', {
      problems: r.problems,
    });
}

// ─────────────────────────────── categories & rules ───────────────────────────────

const audit = (
  q: Queryable,
  a: Actor,
  action: string,
  entity: string,
  id: string,
  before: unknown,
  after: unknown,
) =>
  writeAudit(q, {
    branchId: a.branchId,
    userId: a.userId,
    deviceId: a.deviceId,
    action,
    entity,
    entityId: id,
    before,
    after,
    ip: a.ip,
  });

export async function listCategories(q: Queryable) {
  return q.selectFrom('tax_categories').selectAll().orderBy('code').execute();
}

export function createCategory(ctx: AppContext, a: Actor, input: { code: string; name: string }) {
  return withTx(ctx.db, async (trx) => {
    const row = await trx
      .insertInto('tax_categories')
      .values({ code: input.code, name: input.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'TAX_CATEGORY_CREATE', 'tax_category', row.id, null, row);
    return row;
  });
}

export async function listRules(q: Queryable, authority?: string) {
  let query = q
    .selectFrom('tax_rules')
    .innerJoin('tax_categories', 'tax_categories.id', 'tax_rules.tax_category_id')
    .select([
      'tax_rules.id as id',
      'tax_rules.authority as authority',
      'tax_rules.tax_category_id as categoryId',
      'tax_categories.code as categoryCode',
      'tax_rules.payment_class as paymentClass',
      'tax_rules.rate_bps as rateBps',
      'tax_rules.input_tax_adjustable as inputTaxAdjustable',
      'tax_rules.effective_from as effectiveFrom',
      'tax_rules.effective_to as effectiveTo',
      'tax_rules.source_note as sourceNote',
      'tax_rules.verified_by as verifiedBy',
    ])
    .orderBy('tax_rules.authority')
    .orderBy('tax_categories.code')
    .orderBy('tax_rules.payment_class')
    .orderBy('tax_rules.effective_from', 'desc');
  if (authority) query = query.where('tax_rules.authority', '=', authority);
  return query.execute();
}

export interface NewRule {
  authority: string;
  categoryId: string;
  paymentClass: 'CASH_OTHER' | 'DIGITAL' | 'ANY';
  rateBps: number;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  sourceNote?: string | undefined;
  verifiedBy?: string | undefined;
  inputTaxAdjustable?: boolean | undefined;
}

/**
 * Adds a rule. Rates are never edited: a rate change is a NEW rule from a new date (the old one is
 * ended with `effectiveTo`), so every old bill keeps pointing at the rate it was taxed with.
 */
export function createRule(ctx: AppContext, a: Actor, input: NewRule) {
  return withTx(ctx.db, async (trx) => {
    const existing = (
      await trx
        .selectFrom('tax_rules')
        .selectAll()
        .where('authority', '=', input.authority)
        .where('tax_category_id', '=', input.categoryId)
        .execute()
    ).map(toRule);
    const clash = existing.find((r) =>
      rulesOverlap(
        {
          authority: input.authority,
          categoryId: input.categoryId,
          paymentClass: input.paymentClass,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
        },
        r,
      ),
    );
    if (clash)
      throw new AppError(
        409,
        'CONFLICT',
        'Another rule already covers some of these days for this category and payment class; end it first',
        { ruleId: clash.id },
      );
    const row = await trx
      .insertInto('tax_rules')
      .values({
        authority: input.authority,
        tax_category_id: input.categoryId,
        payment_class: input.paymentClass,
        rate_bps: input.rateBps,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        source_note: input.sourceNote ?? null,
        verified_by: input.verifiedBy?.trim() || null,
        input_tax_adjustable: input.inputTaxAdjustable ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'TAX_RULE_CREATE', 'tax_rule', row.id, null, row);
    return row;
  });
}

/** End a rule or record who verified it. The rate, class and start date are immutable (DB trigger). */
export function updateRule(
  ctx: AppContext,
  a: Actor,
  id: string,
  patch: {
    effectiveTo?: string | null | undefined;
    verifiedBy?: string | null | undefined;
    sourceNote?: string | null | undefined;
  },
) {
  return withTx(ctx.db, async (trx) => {
    const before = await trx
      .selectFrom('tax_rules')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, 'NOT_FOUND', 'tax rule not found');
    const set = {
      ...(patch.effectiveTo !== undefined && { effective_to: patch.effectiveTo }),
      ...(patch.verifiedBy !== undefined && { verified_by: patch.verifiedBy?.trim() || null }),
      ...(patch.sourceNote !== undefined && { source_note: patch.sourceNote }),
    };
    const row = await trx
      .updateTable('tax_rules')
      .set(set)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'TAX_RULE_UPDATE', 'tax_rule', id, before, row);
    return row;
  });
}
