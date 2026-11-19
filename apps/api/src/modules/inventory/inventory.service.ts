import {
  foodCostBps,
  formatScaled,
  lineCostPaisa,
  needsReorder,
  parseScaled,
  purchaseToBaseMilli,
  recipeConsumption,
  StockError,
  unitCostMicro,
  weightedAverageMicro,
} from '@erp/domain';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { drawerPayout } from '../day/shift.service';
import { openBusinessDay } from '../orders/orders.repo';
import type { Actor } from '../orders/orders.service';

const bad = (message: string, extra?: Record<string, unknown>): AppError =>
  new AppError(400, 'VALIDATION_FAILED', message, extra);

/** Decimal in -> integer thousandths (stock quantities) or millionths (costs); domain errors become 400s. */
export function milli(v: number | string): number {
  try {
    return parseScaled(typeof v === 'number' ? v.toString() : v, 3);
  } catch (e) {
    if (e instanceof StockError) throw bad(e.message);
    throw e;
  }
}
const micro = (s: string): number => parseScaled(s, 6);
const fromMilli = (n: number): string => formatScaled(n, 3);
const qtyMilli = (s: string): number =>
  parseScaled(s.replace(/^-/, ''), 3) * (s.startsWith('-') ? -1 : 1);

const audit = (
  q: Queryable,
  a: Actor,
  action: string,
  entity: string,
  id: string,
  before: unknown,
  after: unknown,
  reason?: string,
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
    reason,
    ip: a.ip,
  });

// ───────────────────────────────── stock on hand ─────────────────────────────────

async function onHandMap(
  q: Queryable,
  branchId: string,
  ids?: string[],
): Promise<Map<string, number>> {
  let query = q
    .selectFrom('stock_movements')
    .select(['ingredient_id', sql<string>`COALESCE(SUM(qty_base), 0)::text`.as('qty')])
    .where('branch_id', '=', branchId)
    .groupBy('ingredient_id');
  if (ids)
    query = query.where(
      'ingredient_id',
      'in',
      ids.length ? ids : ['00000000-0000-0000-0000-000000000000'],
    );
  const rows = await query.execute();
  return new Map(rows.map((r) => [r.ingredient_id, qtyMilli(r.qty)]));
}

const presentIngredient = (i: Awaited<ReturnType<typeof requireIngredient>>, onHand: number) => ({
  id: i.id,
  name: i.name,
  nameUr: i.name_ur,
  category: i.category,
  baseUom: i.base_uom,
  purchaseUom: i.purchase_uom,
  purchaseToBase: i.purchase_to_base,
  yieldBps: i.yield_bps,
  isPrep: i.is_prep,
  isActive: i.is_active,
  reorderLevel: i.reorder_level,
  avgCostPerBase: i.avg_cost_per_base,
  onHand: fromMilli(onHand),
  onHandMilli: onHand,
  stockValuePaisa: lineCostPaisa(Math.max(onHand, 0), micro(i.avg_cost_per_base)),
  needsReorder: needsReorder(onHand, i.reorder_level === null ? null : milli(i.reorder_level)),
});

async function requireIngredient(q: Queryable, branchId: string, id: string, lock = false) {
  let query = q
    .selectFrom('ingredients')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'ingredient not found');
  return row;
}

export async function listIngredients(
  ctx: AppContext,
  branchId: string,
  opts: { search?: string | undefined; lowOnly?: boolean | undefined },
) {
  let query = ctx.db
    .selectFrom('ingredients')
    .selectAll()
    .where('branch_id', '=', branchId)
    .orderBy('name');
  if (opts.search?.trim())
    query = query.where('name', 'ilike', `%${opts.search.trim().replace(/[%_\\]/g, '\\$&')}%`);
  const rows = await query.execute();
  const stock = await onHandMap(ctx.db, branchId);
  const out = rows.map((r) => presentIngredient(r, stock.get(r.id) ?? 0));
  return opts.lowOnly ? out.filter((i) => i.needsReorder) : out;
}

export interface IngredientInput {
  name: string;
  nameUr?: string | null | undefined;
  category?: string | null | undefined;
  baseUom: 'g' | 'ml' | 'pcs';
  purchaseUom: string;
  purchaseToBase: number | string;
  yieldBps?: number | undefined;
  isPrep?: boolean | undefined;
  reorderLevel?: number | string | null | undefined;
  openingQty?: number | string | undefined;
  openingCostPaisaPerPurchase?: number | undefined;
}

export function createIngredient(ctx: AppContext, a: Actor, input: IngredientInput) {
  return withTx(ctx.db, async (trx) => {
    let factor: number;
    try {
      factor = parseScaled(String(input.purchaseToBase), 4);
    } catch (e) {
      throw e instanceof StockError ? bad(e.message) : e;
    }
    if (factor <= 0) throw bad('The purchase-to-base factor must be above zero');
    const yieldBps = input.yieldBps ?? 10_000;
    const ing = await trx
      .insertInto('ingredients')
      .values({
        branch_id: a.branchId,
        name: input.name,
        name_ur: input.nameUr ?? null,
        category: input.category ?? null,
        base_uom: input.baseUom,
        purchase_uom: input.purchaseUom,
        purchase_to_base: formatScaled(factor, 4),
        yield_bps: yieldBps,
        is_prep: input.isPrep ?? false,
        reorder_level:
          input.reorderLevel === null || input.reorderLevel === undefined
            ? null
            : fromMilli(milli(input.reorderLevel)),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    let onHand = 0;
    if (input.openingQty !== undefined && milli(input.openingQty) > 0) {
      // opening stock enters the ledger like any other receipt, at the given purchase price
      const base = purchaseToBaseMilli(milli(input.openingQty), factor);
      const cost = unitCostMicro(input.openingCostPaisaPerPurchase ?? 0, factor, yieldBps);
      await trx
        .updateTable('ingredients')
        .set({ avg_cost_per_base: formatScaled(cost, 6) })
        .where('id', '=', ing.id)
        .execute();
      await insertMovement(trx, a, {
        ingredientId: ing.id,
        kind: 'OPENING',
        qtyMilli: base,
        costMicro: cost,
        note: 'Opening stock',
      });
      onHand = base;
    }
    await audit(trx, a, 'INGREDIENT_CREATE', 'ingredient', ing.id, null, {
      name: ing.name,
      baseUom: ing.base_uom,
    });
    return presentIngredient(await requireIngredient(trx, a.branchId, ing.id), onHand);
  });
}

export function updateIngredient(
  ctx: AppContext,
  a: Actor,
  id: string,
  patch: {
    name?: string;
    nameUr?: string | null;
    category?: string | null;
    reorderLevel?: number | string | null;
    yieldBps?: number;
    isActive?: boolean;
  },
) {
  return withTx(ctx.db, async (trx) => {
    const before = await requireIngredient(trx, a.branchId, id, true);
    const set = {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.nameUr !== undefined && { name_ur: patch.nameUr }),
      ...(patch.category !== undefined && { category: patch.category }),
      ...(patch.reorderLevel !== undefined && {
        reorder_level: patch.reorderLevel === null ? null : fromMilli(milli(patch.reorderLevel)),
      }),
      ...(patch.yieldBps !== undefined && { yield_bps: patch.yieldBps }),
      ...(patch.isActive !== undefined && { is_active: patch.isActive }),
    };
    if (Object.keys(set).length === 0) throw bad('Nothing to change');
    await trx.updateTable('ingredients').set(set).where('id', '=', id).execute();
    await audit(
      trx,
      a,
      'INGREDIENT_UPDATE',
      'ingredient',
      id,
      { name: before.name, yieldBps: before.yield_bps, isActive: before.is_active },
      patch,
    );
    const stock = await onHandMap(trx, a.branchId, [id]);
    return presentIngredient(await requireIngredient(trx, a.branchId, id), stock.get(id) ?? 0);
  });
}

export async function listMovements(
  ctx: AppContext,
  branchId: string,
  opts: { ingredientId?: string | undefined; limit: number },
) {
  let query = ctx.db
    .selectFrom('stock_movements')
    .innerJoin('ingredients', 'ingredients.id', 'stock_movements.ingredient_id')
    .select([
      'stock_movements.id as id',
      'ingredients.name as ingredient',
      'stock_movements.kind as kind',
      'stock_movements.qty_base as qty',
      'stock_movements.unit_cost_per_base as costPerBase',
      'stock_movements.reason_code as reasonCode',
      'stock_movements.note as note',
      'stock_movements.created_at as createdAt',
    ])
    .where('stock_movements.branch_id', '=', branchId)
    .orderBy('stock_movements.id', 'desc')
    .limit(opts.limit);
  if (opts.ingredientId)
    query = query.where('stock_movements.ingredient_id', '=', opts.ingredientId);
  return query.execute();
}

interface MovementInput {
  ingredientId: string;
  kind: string;
  /** signed, in thousandths of the base unit */
  qtyMilli: number;
  costMicro?: number | null;
  reasonCode?: string | null;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  key?: string | null;
  at?: Date;
}
async function insertMovement(trx: Queryable, a: Actor, m: MovementInput): Promise<void> {
  const day = await openBusinessDay(trx, a.branchId);
  await trx
    .insertInto('stock_movements')
    .values({
      branch_id: a.branchId,
      ingredient_id: m.ingredientId,
      kind: m.kind,
      qty_base: fromMilli(m.qtyMilli),
      unit_cost_per_base:
        m.costMicro === undefined || m.costMicro === null ? null : formatScaled(m.costMicro, 6),
      reason_code: m.reasonCode ?? null,
      ref_type: m.refType ?? null,
      ref_id: m.refId ?? null,
      business_day_id: day?.id ?? null,
      note: m.note ?? null,
      created_by: a.userId,
      idempotency_key: m.key ?? null,
      ...(m.at && { created_at: m.at }),
    })
    .execute();
}

// ──────────────────────────────────── suppliers ────────────────────────────────────

export async function listSuppliers(ctx: AppContext, branchId: string) {
  const rows = await ctx.db
    .selectFrom('suppliers')
    .selectAll()
    .where('branch_id', '=', branchId)
    .orderBy('name')
    .execute();
  const bought = await ctx.db
    .selectFrom('purchases')
    .select(['supplier_id', sql<string>`COALESCE(SUM(total_paisa), 0)::text`.as('total')])
    .where('branch_id', '=', branchId)
    .where('supplier_id', 'is not', null)
    .groupBy('supplier_id')
    .execute();
  const paid = await ctx.db
    .selectFrom('supplier_payments')
    .innerJoin('suppliers', 'suppliers.id', 'supplier_payments.supplier_id')
    .select([
      'supplier_payments.supplier_id as supplier_id',
      sql<string>`COALESCE(SUM(supplier_payments.amount_paisa), 0)::text`.as('total'),
    ])
    .where('suppliers.branch_id', '=', branchId)
    .groupBy('supplier_payments.supplier_id')
    .execute();
  return rows.map((s) => {
    const b = Number(bought.find((x) => x.supplier_id === s.id)?.total ?? 0);
    const p = Number(paid.find((x) => x.supplier_id === s.id)?.total ?? 0);
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      notes: s.notes,
      isActive: s.is_active,
      purchasedPaisa: b,
      paidPaisa: p,
      owedPaisa: b - p,
    };
  });
}

export function createSupplier(
  ctx: AppContext,
  a: Actor,
  input: { name: string; phone?: string | undefined; notes?: string | undefined },
) {
  return withTx(ctx.db, async (trx) => {
    const row = await trx
      .insertInto('suppliers')
      .values({
        branch_id: a.branchId,
        name: input.name,
        phone: input.phone ?? null,
        notes: input.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'SUPPLIER_CREATE', 'supplier', row.id, null, { name: row.name });
    return row;
  });
}

/** Rename a supplier, change its phone or notes, or switch it off. (What is owed lives in purchases and payments, untouched.) */
export function updateSupplier(
  ctx: AppContext,
  a: Actor,
  id: string,
  input: {
    name?: string | undefined;
    phone?: string | null | undefined;
    notes?: string | null | undefined;
    isActive?: boolean | undefined;
  },
) {
  return withTx(ctx.db, async (trx) => {
    const before = await trx
      .selectFrom('suppliers')
      .selectAll()
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, 'NOT_FOUND', 'supplier not found');
    const row = await trx
      .updateTable('suppliers')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.isActive !== undefined && { is_active: input.isActive }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'SUPPLIER_UPDATE', 'supplier', id, before, row);
    return row;
  });
}

// ──────────────────────────────────── recipes ────────────────────────────────────

export interface RecipeInput {
  /** Prep recipes only: how much one batch produces (base units). */
  outputQty?: number | string | undefined;
  lines: { ingredientId: string; qty: number | string }[];
}

async function recipeView(q: Queryable, branchId: string, recipeId: string | null) {
  if (!recipeId) return { lines: [], costPaisa: 0, outputQty: '1' };
  const recipe = await q
    .selectFrom('recipes')
    .selectAll()
    .where('id', '=', recipeId)
    .executeTakeFirstOrThrow();
  const lines = await q
    .selectFrom('recipe_lines')
    .innerJoin('ingredients', 'ingredients.id', 'recipe_lines.ingredient_id')
    .select([
      'ingredients.id as ingredientId',
      'ingredients.name as name',
      'ingredients.base_uom as baseUom',
      'ingredients.avg_cost_per_base as avg',
      'recipe_lines.qty_base as qty',
    ])
    .where('recipe_lines.recipe_id', '=', recipeId)
    .where('ingredients.branch_id', '=', branchId)
    .orderBy('ingredients.name')
    .execute();
  const costPaisa = lines.reduce((n, l) => n + lineCostPaisa(milli(l.qty), micro(l.avg)), 0);
  return {
    outputQty: recipe.output_qty_base,
    lines: lines.map((l) => ({
      ingredientId: l.ingredientId,
      name: l.name,
      baseUom: l.baseUom,
      qty: l.qty,
      costPaisa: lineCostPaisa(milli(l.qty), micro(l.avg)),
    })),
    costPaisa,
  };
}

async function writeRecipe(
  trx: Queryable,
  a: Actor,
  target: { variantId?: string; ingredientId?: string },
  input: RecipeInput,
) {
  const lines = input.lines.map((l) => ({ ingredientId: l.ingredientId, qtyMilli: milli(l.qty) }));
  if (lines.some((l) => l.qtyMilli <= 0)) throw bad('Every quantity must be above zero');
  if (new Set(lines.map((l) => l.ingredientId)).size !== lines.length)
    throw bad('An ingredient can only appear once');
  const ids = lines.map((l) => l.ingredientId);
  const found = ids.length
    ? await trx
        .selectFrom('ingredients')
        .select(['id', 'is_active'])
        .where('branch_id', '=', a.branchId)
        .where('id', 'in', ids)
        .execute()
    : [];
  if (found.length !== ids.length) throw bad('Unknown ingredient in the recipe');
  if (found.some((f) => !f.is_active)) throw bad('An ingredient in the recipe is switched off');
  if (target.ingredientId && ids.includes(target.ingredientId))
    throw bad('A prep item cannot be made from itself');

  const existing = await trx
    .selectFrom('recipes')
    .selectAll()
    .where(
      target.variantId ? 'variant_id' : 'ingredient_id',
      '=',
      (target.variantId ?? target.ingredientId)!,
    )
    .forUpdate()
    .executeTakeFirst();
  const before = existing ? await recipeView(trx, a.branchId, existing.id) : null;
  let id = existing?.id;
  if (existing) {
    await trx.deleteFrom('recipe_lines').where('recipe_id', '=', existing.id).execute();
    if (input.outputQty !== undefined)
      await trx
        .updateTable('recipes')
        .set({ output_qty_base: fromMilli(milli(input.outputQty)) })
        .where('id', '=', existing.id)
        .execute();
  } else {
    const created = await trx
      .insertInto('recipes')
      .values({
        variant_id: target.variantId ?? null,
        ingredient_id: target.ingredientId ?? null,
        output_qty_base: input.outputQty === undefined ? '1' : fromMilli(milli(input.outputQty)),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = created.id;
  }
  if (lines.length)
    await trx
      .insertInto('recipe_lines')
      .values(
        lines.map((l) => ({
          recipe_id: id!,
          ingredient_id: l.ingredientId,
          qty_base: fromMilli(l.qtyMilli),
        })),
      )
      .execute();
  const after = await recipeView(trx, a.branchId, id!);
  await audit(
    trx,
    a,
    'RECIPE_SET',
    target.variantId ? 'item_variant' : 'ingredient',
    (target.variantId ?? target.ingredientId)!,
    before,
    after,
  );
  return after;
}

export function setVariantRecipe(ctx: AppContext, a: Actor, variantId: string, input: RecipeInput) {
  return withTx(ctx.db, async (trx) => {
    const v = await trx
      .selectFrom('item_variants')
      .innerJoin('items', 'items.id', 'item_variants.item_id')
      .select('item_variants.id as id')
      .where('item_variants.id', '=', variantId)
      .where('items.branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!v) throw new AppError(404, 'NOT_FOUND', 'variant not found');
    return writeRecipe(trx, a, { variantId }, input);
  });
}

export function setPrepRecipe(ctx: AppContext, a: Actor, ingredientId: string, input: RecipeInput) {
  return withTx(ctx.db, async (trx) => {
    const ing = await requireIngredient(trx, a.branchId, ingredientId, true);
    if (!ing.is_prep) throw bad('Only a prep ingredient (semi-finished item) has a recipe');
    if (input.outputQty === undefined || milli(input.outputQty) <= 0)
      throw bad('A prep recipe needs the output quantity of one batch');
    return writeRecipe(trx, a, { ingredientId }, input);
  });
}

export async function getVariantRecipe(ctx: AppContext, branchId: string, variantId: string) {
  const r = await ctx.db
    .selectFrom('recipes')
    .select('id')
    .where('variant_id', '=', variantId)
    .executeTakeFirst();
  return recipeView(ctx.db, branchId, r?.id ?? null);
}
export async function getPrepRecipe(ctx: AppContext, branchId: string, ingredientId: string) {
  await requireIngredient(ctx.db, branchId, ingredientId);
  const r = await ctx.db
    .selectFrom('recipes')
    .select('id')
    .where('ingredient_id', '=', ingredientId)
    .executeTakeFirst();
  return recipeView(ctx.db, branchId, r?.id ?? null);
}

/** Every sellable variant with its recipe cost and today's dine-in price: the margin sheet. */
export async function recipeMargins(ctx: AppContext, branchId: string) {
  const rows = await ctx.db
    .selectFrom('recipes')
    .innerJoin('item_variants', 'item_variants.id', 'recipes.variant_id')
    .innerJoin('items', 'items.id', 'item_variants.item_id')
    .select([
      'recipes.id as recipeId',
      'item_variants.id as variantId',
      'items.name as item',
      'item_variants.name as variant',
      'items.kind as kind',
    ])
    .where('items.branch_id', '=', branchId)
    .where('items.archived_at', 'is', null)
    .orderBy('items.name')
    .execute();
  const out = [];
  for (const r of rows) {
    const rv = await recipeView(ctx.db, branchId, r.recipeId);
    const price = await ctx.db
      .selectFrom('item_prices')
      .innerJoin('price_lists', 'price_lists.id', 'item_prices.price_list_id')
      .select('item_prices.price_paisa as price')
      .where('item_prices.variant_id', '=', r.variantId)
      .where('price_lists.code', '=', 'DINE_IN')
      .where('item_prices.effective_to', 'is', null)
      .executeTakeFirst();
    const pricePaisa = price?.price ?? null;
    out.push({
      variantId: r.variantId,
      item: r.item,
      variant: r.variant,
      kind: r.kind,
      costPaisa: rv.costPaisa,
      pricePaisa,
      foodCostBps: pricePaisa ? foodCostBps(rv.costPaisa, pricePaisa) : null,
    });
  }
  return out;
}

// ──────────────────────────────────── purchases ────────────────────────────────────

export interface PurchaseInput {
  supplierId?: string | undefined;
  invoiceRef?: string | undefined;
  lines: { ingredientId: string; qty: number | string; unitCostPaisa: number }[];
  /** What was paid now (the rest stays owed to the supplier). */
  payment?: { amountPaisa: number; source: 'DRAWER_CASH' | 'OWNER_CASH' | 'BANK' } | undefined;
}

/**
 * Posts a purchase in one transaction: the document, one PURCHASE movement per line (in base units),
 * the weighted-average cost of every ingredient, and — if paid now — a supplier payment (cash from the
 * drawer also leaves the till as a paid-out, so the shift's expected cash stays right).
 */
export function createPurchase(ctx: AppContext, a: Actor, input: PurchaseInput, key: string) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('purchases')
      .select('id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (dup) return { id: dup.id, replayed: true as const };
    if (input.lines.length === 0) throw bad('A purchase needs at least one line');
    if (new Set(input.lines.map((l) => l.ingredientId)).size !== input.lines.length)
      throw bad('An ingredient can only appear once per purchase');
    if (input.supplierId) {
      const s = await trx
        .selectFrom('suppliers')
        .select('id')
        .where('id', '=', input.supplierId)
        .where('branch_id', '=', a.branchId)
        .executeTakeFirst();
      if (!s) throw bad('Unknown supplier');
    }
    const now = ctx.clock.now();
    const day = await openBusinessDay(trx, a.branchId);

    let total = 0;
    const prepared: {
      ing: Awaited<ReturnType<typeof requireIngredient>>;
      qtyPurchaseMilli: number;
      unit: number;
      line: number;
      baseMilli: number;
      costMicro: number;
    }[] = [];
    for (const l of input.lines) {
      const ing = await requireIngredient(trx, a.branchId, l.ingredientId, true);
      if (!ing.is_active) throw bad(`${ing.name} is switched off`);
      const qtyPurchaseMilli = milli(l.qty);
      if (qtyPurchaseMilli <= 0) throw bad('Quantities must be above zero');
      const factor = parseScaled(ing.purchase_to_base, 4);
      const lineTotal = Math.floor((qtyPurchaseMilli * l.unitCostPaisa * 2 + 1000) / 2000); // half-up of qty × price
      total += lineTotal;
      prepared.push({
        ing,
        qtyPurchaseMilli,
        unit: l.unitCostPaisa,
        line: lineTotal,
        baseMilli: purchaseToBaseMilli(qtyPurchaseMilli, factor),
        costMicro: unitCostMicro(l.unitCostPaisa, factor, ing.yield_bps),
      });
    }
    const pay = input.payment;
    if (pay && (pay.amountPaisa <= 0 || pay.amountPaisa > total))
      throw bad('The payment must be above zero and not more than the purchase total');
    if (pay && !input.supplierId) throw bad('Choose the supplier to record a payment');

    let shiftId: string | null = null;
    if (pay?.source === 'DRAWER_CASH')
      shiftId = (
        await drawerPayout(trx, a, {
          amountPaisa: pay.amountPaisa,
          reason: `Purchase${input.invoiceRef ? ` ${input.invoiceRef}` : ''}`,
          key: `${key}:cash`,
        })
      ).shiftId;

    const purchase = await trx
      .insertInto('purchases')
      .values({
        branch_id: a.branchId,
        business_day_id: day?.id ?? null,
        supplier_id: input.supplierId ?? null,
        invoice_ref: input.invoiceRef ?? null,
        status: 'POSTED',
        total_paisa: total,
        payment_source: pay?.source ?? 'CREDIT',
        shift_id: shiftId,
        created_by: a.userId,
        created_at: now,
        idempotency_key: key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('purchase_lines')
      .values(
        prepared.map((p) => ({
          purchase_id: purchase.id,
          ingredient_id: p.ing.id,
          qty_purchase_uom: fromMilli(p.qtyPurchaseMilli),
          unit_cost_paisa: p.unit,
          line_total_paisa: p.line,
        })),
      )
      .execute();

    for (const p of prepared) {
      const onHand = (await onHandMap(trx, a.branchId, [p.ing.id])).get(p.ing.id) ?? 0;
      const avg = weightedAverageMicro({
        onHandMilli: onHand,
        avgMicro: micro(p.ing.avg_cost_per_base),
        addedMilli: p.baseMilli,
        addedCostMicro: p.costMicro,
      });
      await trx
        .updateTable('ingredients')
        .set({ avg_cost_per_base: formatScaled(avg, 6) })
        .where('id', '=', p.ing.id)
        .execute();
      await insertMovement(trx, a, {
        ingredientId: p.ing.id,
        kind: 'PURCHASE',
        qtyMilli: p.baseMilli,
        costMicro: p.costMicro,
        refType: 'PURCHASE',
        refId: purchase.id,
        at: now,
      });
    }
    if (pay && input.supplierId)
      await trx
        .insertInto('supplier_payments')
        .values({
          supplier_id: input.supplierId,
          purchase_id: purchase.id,
          amount_paisa: pay.amountPaisa,
          source: pay.source,
          shift_id: shiftId,
          created_by: a.userId,
          created_at: now,
          idempotency_key: `${key}:pay`,
        })
        .execute();
    await audit(trx, a, 'PURCHASE_POST', 'purchase', purchase.id, null, {
      totalPaisa: total,
      paidPaisa: pay?.amountPaisa ?? 0,
      lines: prepared.length,
      supplierId: input.supplierId ?? null,
    });
    return {
      id: purchase.id,
      totalPaisa: total,
      paidPaisa: pay?.amountPaisa ?? 0,
      owedPaisa: total - (pay?.amountPaisa ?? 0),
      replayed: false as const,
    };
  });
}

export async function listPurchases(ctx: AppContext, branchId: string, limit: number) {
  const rows = await ctx.db
    .selectFrom('purchases')
    .leftJoin('suppliers', 'suppliers.id', 'purchases.supplier_id')
    .select([
      'purchases.id as id',
      'purchases.invoice_ref as invoiceRef',
      'suppliers.name as supplier',
      'purchases.total_paisa as totalPaisa',
      'purchases.created_at as createdAt',
    ])
    .where('purchases.branch_id', '=', branchId)
    .orderBy('purchases.created_at', 'desc')
    .limit(limit)
    .execute();
  const ids = rows.map((r) => r.id);
  const paid = ids.length
    ? await ctx.db
        .selectFrom('supplier_payments')
        .select(['purchase_id', sql<string>`SUM(amount_paisa)::text`.as('p')])
        .where('purchase_id', 'in', ids)
        .groupBy('purchase_id')
        .execute()
    : [];
  return rows.map((r) => ({
    ...r,
    paidPaisa: Number(paid.find((p) => p.purchase_id === r.id)?.p ?? 0),
    owedPaisa: r.totalPaisa - Number(paid.find((p) => p.purchase_id === r.id)?.p ?? 0),
  }));
}

/** Pays a supplier later (cash from the drawer, owner cash or bank). Cannot pay more than is owed. */
export function paySupplier(
  ctx: AppContext,
  a: Actor,
  supplierId: string,
  input: {
    amountPaisa: number;
    source: 'DRAWER_CASH' | 'OWNER_CASH' | 'BANK';
    note?: string | undefined;
  },
  key: string,
) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('supplier_payments')
      .select('id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (dup) return { id: dup.id, replayed: true as const };
    const s = await trx
      .selectFrom('suppliers')
      .selectAll()
      .where('id', '=', supplierId)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw new AppError(404, 'NOT_FOUND', 'supplier not found');
    const bought = await trx
      .selectFrom('purchases')
      .select(sql<string>`COALESCE(SUM(total_paisa), 0)::text`.as('t'))
      .where('supplier_id', '=', supplierId)
      .executeTakeFirstOrThrow();
    const paid = await trx
      .selectFrom('supplier_payments')
      .select(sql<string>`COALESCE(SUM(amount_paisa), 0)::text`.as('t'))
      .where('supplier_id', '=', supplierId)
      .executeTakeFirstOrThrow();
    const owed = Number(bought.t) - Number(paid.t);
    if (input.amountPaisa > owed)
      throw new AppError(
        409,
        'SUPPLIER_OVERPAYMENT',
        'That is more than is owed to this supplier',
        { owedPaisa: owed },
      );
    let shiftId: string | null = null;
    if (input.source === 'DRAWER_CASH')
      shiftId = (
        await drawerPayout(trx, a, {
          amountPaisa: input.amountPaisa,
          reason: `Supplier payment: ${s.name}`,
          key: `${key}:cash`,
        })
      ).shiftId;
    const row = await trx
      .insertInto('supplier_payments')
      .values({
        supplier_id: supplierId,
        amount_paisa: input.amountPaisa,
        source: input.source,
        shift_id: shiftId,
        created_by: a.userId,
        created_at: ctx.clock.now(),
        idempotency_key: key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(
      trx,
      a,
      'SUPPLIER_PAYMENT',
      'supplier',
      supplierId,
      { owedPaisa: owed },
      { amountPaisa: input.amountPaisa, source: input.source },
      input.note,
    );
    return { id: row.id, owedPaisa: owed - input.amountPaisa, replayed: false as const };
  });
}

// ─────────────────────────── consumption when something is sold ───────────────────────────

/**
 * Called by the billing service inside the settle transaction, BEFORE the order is frozen: every sold
 * order line whose variant has a recipe removes its ingredients (a SALE movement per ingredient, unique
 * per order line so a replay can never deduct twice) and stores the line's food cost.
 * Selling below zero stock is allowed (it is reported, not blocked): the restaurant must never be unable
 * to sell because a purchase was not typed in yet.
 */
export async function consumeForOrder(
  trx: Queryable,
  a: Actor,
  orderId: string,
  at: Date,
): Promise<{ lines: number }> {
  const items = await trx
    .selectFrom('order_items')
    .select(['id', 'variant_id', 'qty', 'weight_g'])
    .where('order_id', '=', orderId)
    .where('status', '!=', 'VOID')
    .execute();
  if (items.length === 0) return { lines: 0 };
  const recipes = await trx
    .selectFrom('recipes')
    .select(['id', 'variant_id'])
    .where('variant_id', 'in', [...new Set(items.map((i) => i.variant_id))])
    .execute();
  if (recipes.length === 0) return { lines: 0 };
  const recipeLines = await trx
    .selectFrom('recipe_lines')
    .innerJoin('ingredients', 'ingredients.id', 'recipe_lines.ingredient_id')
    .select([
      'recipe_lines.recipe_id as recipeId',
      'recipe_lines.ingredient_id as ingredientId',
      'recipe_lines.qty_base as qty',
      'ingredients.avg_cost_per_base as avg',
    ])
    .where(
      'recipe_lines.recipe_id',
      'in',
      recipes.map((r) => r.id),
    )
    .execute();
  let consumedLines = 0;
  for (const item of items) {
    const recipe = recipes.find((r) => r.variant_id === item.variant_id);
    if (!recipe) continue;
    const lines = recipeLines.filter((l) => l.recipeId === recipe.id);
    const use = recipeConsumption(
      lines.map((l) => ({ ingredientId: l.ingredientId, qtyMilli: milli(l.qty) })),
      { qtyMilli: Math.round(Number(item.qty) * 1000), weightG: item.weight_g },
    );
    let cost = 0;
    for (const u of use) {
      const avg = micro(lines.find((l) => l.ingredientId === u.ingredientId)!.avg);
      cost += lineCostPaisa(u.qtyMilli, avg);
      await trx
        .insertInto('stock_movements')
        .values({
          branch_id: a.branchId,
          ingredient_id: u.ingredientId,
          kind: 'SALE',
          qty_base: fromMilli(-u.qtyMilli),
          unit_cost_per_base: formatScaled(avg, 6),
          ref_type: 'ORDER_ITEM',
          ref_id: item.id,
          created_by: a.userId,
          created_at: at,
          idempotency_key: `sale:${item.id}:${u.ingredientId}`,
        })
        .onConflict((oc) =>
          oc.column('idempotency_key').where('idempotency_key', 'is not', null).doNothing(),
        )
        .execute();
    }
    await trx
      .updateTable('order_items')
      .set({ cost_paisa_snapshot: cost })
      .where('id', '=', item.id)
      .execute();
    consumedLines++;
  }
  return { lines: consumedLines };
}

// ─────────────────────────── wastage, staff meals, prep batches ───────────────────────────

export function recordLoss(
  ctx: AppContext,
  a: Actor,
  input: {
    ingredientId: string;
    qty: number | string;
    kind: 'WASTAGE' | 'STAFF_MEAL';
    reasonCode?: string | undefined;
    note?: string | undefined;
  },
  key: string,
) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('stock_movements')
      .select('id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (dup) return { replayed: true as const };
    const ing = await requireIngredient(trx, a.branchId, input.ingredientId, true);
    const q = milli(input.qty);
    if (q <= 0) throw bad('The quantity must be above zero');
    if (input.kind === 'WASTAGE' && !input.reasonCode)
      throw bad('A reason is required for wastage');
    const cost = micro(ing.avg_cost_per_base);
    await insertMovement(trx, a, {
      ingredientId: ing.id,
      kind: input.kind,
      qtyMilli: -q,
      costMicro: cost,
      reasonCode: input.reasonCode ?? null,
      note: input.note ?? null,
      key,
      at: ctx.clock.now(),
    });
    const valuePaisa = lineCostPaisa(q, cost);
    await audit(
      trx,
      a,
      input.kind === 'WASTAGE' ? 'STOCK_WASTAGE' : 'STOCK_STAFF_MEAL',
      'ingredient',
      ing.id,
      null,
      { qty: fromMilli(q), valuePaisa },
      input.reasonCode ?? input.note,
    );
    return { replayed: false as const, valuePaisa };
  });
}

/** Cooks a batch of a prep ingredient: components out, the prepared item in, cost carried over. */
export function makePrepBatch(
  ctx: AppContext,
  a: Actor,
  input: { ingredientId: string; batches: number | string },
  key: string,
) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('stock_movements')
      .select('id')
      .where('idempotency_key', '=', `${key}:in`)
      .executeTakeFirst();
    if (dup) return { replayed: true as const };
    const prep = await requireIngredient(trx, a.branchId, input.ingredientId, true);
    const recipe = await trx
      .selectFrom('recipes')
      .selectAll()
      .where('ingredient_id', '=', prep.id)
      .executeTakeFirst();
    if (!recipe) throw new AppError(409, 'NO_RECIPE', 'This prep item has no recipe yet');
    const batches = milli(input.batches);
    if (batches <= 0) throw bad('Batches must be above zero');
    const lines = await trx
      .selectFrom('recipe_lines')
      .innerJoin('ingredients', 'ingredients.id', 'recipe_lines.ingredient_id')
      .select([
        'recipe_lines.ingredient_id as id',
        'recipe_lines.qty_base as qty',
        'ingredients.avg_cost_per_base as avg',
      ])
      .where('recipe_lines.recipe_id', '=', recipe.id)
      .execute();
    if (lines.length === 0)
      throw new AppError(409, 'NO_RECIPE', 'The prep recipe has no ingredients');
    const now = ctx.clock.now();
    let costPaisa = 0;
    for (const l of lines) {
      const used = Math.round((milli(l.qty) * batches) / 1000);
      costPaisa += lineCostPaisa(used, micro(l.avg));
      await insertMovement(trx, a, {
        ingredientId: l.id,
        kind: 'PREP_OUT',
        qtyMilli: -used,
        costMicro: micro(l.avg),
        refType: 'PREP_BATCH',
        refId: prep.id,
        key: `${key}:out:${l.id}`,
        at: now,
      });
    }
    const made = Math.round((milli(recipe.output_qty_base) * batches) / 1000);
    const perUnitMicro = Math.round((costPaisa * 1_000_000 * 1000) / made);
    const onHand = (await onHandMap(trx, a.branchId, [prep.id])).get(prep.id) ?? 0;
    const avg = weightedAverageMicro({
      onHandMilli: onHand,
      avgMicro: micro(prep.avg_cost_per_base),
      addedMilli: made,
      addedCostMicro: perUnitMicro,
    });
    await trx
      .updateTable('ingredients')
      .set({ avg_cost_per_base: formatScaled(avg, 6) })
      .where('id', '=', prep.id)
      .execute();
    await insertMovement(trx, a, {
      ingredientId: prep.id,
      kind: 'PREP_IN',
      qtyMilli: made,
      costMicro: perUnitMicro,
      refType: 'PREP_BATCH',
      refId: prep.id,
      key: `${key}:in`,
      at: now,
    });
    await audit(trx, a, 'PREP_BATCH', 'ingredient', prep.id, null, {
      batches: fromMilli(batches),
      made: fromMilli(made),
      costPaisa,
    });
    return { replayed: false as const, made: fromMilli(made), costPaisa };
  });
}

// ──────────────────────────────────── stocktake ────────────────────────────────────

export function startStocktake(ctx: AppContext, a: Actor) {
  return withTx(ctx.db, async (trx) => {
    const open = await trx
      .selectFrom('stocktakes')
      .select('id')
      .where('branch_id', '=', a.branchId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    if (open)
      throw new AppError(409, 'CONFLICT', 'A stocktake is already open', { stocktakeId: open.id });
    const day = await openBusinessDay(trx, a.branchId);
    const st = await trx
      .insertInto('stocktakes')
      .values({
        branch_id: a.branchId,
        business_day_id: day?.id ?? null,
        created_by: a.userId,
        created_at: ctx.clock.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const ings = await trx
      .selectFrom('ingredients')
      .select('id')
      .where('branch_id', '=', a.branchId)
      .where('is_active', '=', true)
      .execute();
    const stock = await onHandMap(trx, a.branchId);
    if (ings.length)
      await trx
        .insertInto('stocktake_lines')
        .values(
          ings.map((i) => ({
            stocktake_id: st.id,
            ingredient_id: i.id,
            system_qty: fromMilli(stock.get(i.id) ?? 0),
          })),
        )
        .execute();
    await audit(trx, a, 'STOCKTAKE_START', 'stocktake', st.id, null, { lines: ings.length });
    return getStocktake(trx, a.branchId, st.id);
  });
}

export async function getStocktake(q: Queryable, branchId: string, id: string) {
  const st = await q
    .selectFrom('stocktakes')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!st) throw new AppError(404, 'NOT_FOUND', 'stocktake not found');
  const lines = await q
    .selectFrom('stocktake_lines')
    .innerJoin('ingredients', 'ingredients.id', 'stocktake_lines.ingredient_id')
    .select([
      'ingredients.id as ingredientId',
      'ingredients.name as name',
      'ingredients.base_uom as baseUom',
      'stocktake_lines.system_qty as systemQty',
      'stocktake_lines.counted_qty as countedQty',
    ])
    .where('stocktake_lines.stocktake_id', '=', id)
    .orderBy('ingredients.name')
    .execute();
  return {
    id: st.id,
    status: st.status,
    createdAt: st.created_at,
    postedAt: st.posted_at,
    lines: lines.map((l) => ({
      ...l,
      varianceQty:
        l.countedQty === null ? null : fromMilli(milli(l.countedQty) - milli(l.systemQty)),
    })),
  };
}

export function countStocktakeLine(
  ctx: AppContext,
  a: Actor,
  id: string,
  input: { ingredientId: string; countedQty: number | string | null },
) {
  return withTx(ctx.db, async (trx) => {
    const st = await trx
      .selectFrom('stocktakes')
      .select('status')
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!st) throw new AppError(404, 'NOT_FOUND', 'stocktake not found');
    if (st.status !== 'OPEN')
      throw new AppError(409, 'CONFLICT', 'This stocktake is already posted');
    const counted = input.countedQty === null ? null : milli(input.countedQty);
    const res = await trx
      .updateTable('stocktake_lines')
      .set({ counted_qty: counted === null ? null : fromMilli(counted) })
      .where('stocktake_id', '=', id)
      .where('ingredient_id', '=', input.ingredientId)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0)
      throw new AppError(404, 'NOT_FOUND', 'that ingredient is not on this stocktake');
    return getStocktake(trx, a.branchId, id);
  });
}

/** Posts the count: each counted difference becomes an ADJUSTMENT movement. Uncounted lines are left alone. */
export function postStocktake(ctx: AppContext, a: Actor, id: string) {
  return withTx(ctx.db, async (trx) => {
    const st = await trx
      .selectFrom('stocktakes')
      .selectAll()
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!st) throw new AppError(404, 'NOT_FOUND', 'stocktake not found');
    if (st.status !== 'OPEN')
      throw new AppError(409, 'CONFLICT', 'This stocktake is already posted');
    const lines = await trx
      .selectFrom('stocktake_lines')
      .innerJoin('ingredients', 'ingredients.id', 'stocktake_lines.ingredient_id')
      .select([
        'stocktake_lines.ingredient_id as ingredientId',
        'stocktake_lines.system_qty as systemQty',
        'stocktake_lines.counted_qty as countedQty',
        'ingredients.avg_cost_per_base as avg',
      ])
      .where('stocktake_lines.stocktake_id', '=', id)
      .execute();
    const now = ctx.clock.now();
    let adjusted = 0;
    let valuePaisa = 0;
    for (const l of lines) {
      if (l.countedQty === null) continue;
      const variance = milli(l.countedQty) - milli(l.systemQty);
      if (variance === 0) continue;
      await insertMovement(trx, a, {
        ingredientId: l.ingredientId,
        kind: 'ADJUSTMENT',
        qtyMilli: variance,
        costMicro: micro(l.avg),
        reasonCode: 'STOCKTAKE',
        refType: 'STOCKTAKE',
        refId: id,
        key: `stocktake:${id}:${l.ingredientId}`,
        at: now,
      });
      valuePaisa += (variance < 0 ? -1 : 1) * lineCostPaisa(Math.abs(variance), micro(l.avg));
      adjusted++;
    }
    await trx
      .updateTable('stocktakes')
      .set({ status: 'POSTED', posted_at: now })
      .where('id', '=', id)
      .execute();
    await audit(
      trx,
      a,
      'STOCKTAKE_POST',
      'stocktake',
      id,
      { status: 'OPEN' },
      { adjusted, varianceValuePaisa: valuePaisa },
    );
    return { adjusted, varianceValuePaisa: valuePaisa };
  });
}

// ──────────────────────────────────── food cost ────────────────────────────────────

/** Food cost of what was sold between two business dates, by item: revenue, cost, margin. */
export async function foodCostReport(ctx: AppContext, branchId: string, from: string, to: string) {
  const rows = await ctx.db
    .selectFrom('order_items')
    .innerJoin('orders', 'orders.id', 'order_items.order_id')
    .innerJoin('business_days', 'business_days.id', 'orders.business_day_id')
    .select([
      'order_items.item_id as itemId',
      sql<string>`MAX(order_items.name_snapshot)`.as('name'),
      sql<number>`COALESCE(SUM(order_items.qty), 0)::float8`.as('qty'),
      sql<number>`COALESCE(SUM(order_items.line_total_paisa), 0)::bigint`.as('revenue'),
      sql<number>`COALESCE(SUM(order_items.cost_paisa_snapshot), 0)::bigint`.as('cost'),
      sql<number>`COUNT(*) FILTER (WHERE order_items.cost_paisa_snapshot IS NULL AND order_items.parent_order_item_id IS NULL)::int`.as(
        'uncosted',
      ),
    ])
    .where('orders.branch_id', '=', branchId)
    .where('orders.status', '=', 'SETTLED')
    .where('order_items.status', '!=', 'VOID')
    .where('business_days.business_date', '>=', from)
    .where('business_days.business_date', '<=', to)
    .groupBy('order_items.item_id')
    .orderBy(sql`MAX(order_items.name_snapshot)`)
    .execute();
  const items = rows.map((r) => ({
    itemId: r.itemId,
    name: r.name,
    qty: r.qty,
    revenuePaisa: r.revenue,
    costPaisa: r.cost,
    marginPaisa: r.revenue - r.cost,
    foodCostBps: foodCostBps(r.cost, r.revenue),
    uncostedLines: r.uncosted,
  }));
  const revenue = items.reduce((n, i) => n + i.revenuePaisa, 0);
  const cost = items.reduce((n, i) => n + i.costPaisa, 0);
  const waste = await ctx.db
    .selectFrom('stock_movements')
    .select([
      'kind',
      sql<number>`COALESCE(SUM(ABS(qty_base) * COALESCE(unit_cost_per_base, 0)), 0)::float8`.as(
        'value',
      ),
    ])
    .where('branch_id', '=', branchId)
    .where('kind', 'in', ['WASTAGE', 'STAFF_MEAL'])
    .where('created_at', '>=', new Date(`${from}T00:00:00Z`))
    .where('created_at', '<', new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000))
    .groupBy('kind')
    .execute();
  return {
    from,
    to,
    items,
    totals: {
      revenuePaisa: revenue,
      costPaisa: cost,
      marginPaisa: revenue - cost,
      foodCostBps: foodCostBps(cost, revenue),
    },
    wastagePaisa: Math.round(waste.find((w) => w.kind === 'WASTAGE')?.value ?? 0),
    staffMealPaisa: Math.round(waste.find((w) => w.kind === 'STAFF_MEAL')?.value ?? 0),
  };
}

// ──────────────────────────────────── expenses ────────────────────────────────────

export function createExpense(
  ctx: AppContext,
  a: Actor,
  input: {
    category: string;
    amountPaisa: number;
    paidFrom: 'DRAWER_CASH' | 'OWNER_CASH' | 'BANK';
    note?: string | undefined;
  },
  key: string,
) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('expenses')
      .select('id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (dup) return { id: dup.id, replayed: true as const };
    const day = await openBusinessDay(trx, a.branchId);
    let shiftId: string | null = null;
    if (input.paidFrom === 'DRAWER_CASH')
      shiftId = (
        await drawerPayout(trx, a, {
          amountPaisa: input.amountPaisa,
          reason: `Expense: ${input.category}`,
          key: `${key}:cash`,
        })
      ).shiftId;
    const row = await trx
      .insertInto('expenses')
      .values({
        branch_id: a.branchId,
        business_day_id: day?.id ?? null,
        category: input.category,
        amount_paisa: input.amountPaisa,
        paid_from: input.paidFrom,
        shift_id: shiftId,
        note: input.note ?? null,
        created_by: a.userId,
        created_at: ctx.clock.now(),
        idempotency_key: key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(
      trx,
      a,
      'EXPENSE_CREATE',
      'expense',
      row.id,
      null,
      { category: input.category, amountPaisa: input.amountPaisa, paidFrom: input.paidFrom },
      input.note,
    );
    return { id: row.id, replayed: false as const };
  });
}

export async function listExpenses(ctx: AppContext, branchId: string, from: string, to: string) {
  const rows = await ctx.db
    .selectFrom('expenses')
    .leftJoin('business_days', 'business_days.id', 'expenses.business_day_id')
    .select([
      'expenses.id as id',
      'expenses.category as category',
      'expenses.amount_paisa as amountPaisa',
      'expenses.paid_from as paidFrom',
      'expenses.note as note',
      'expenses.created_at as createdAt',
      'business_days.business_date as businessDate',
    ])
    .where('expenses.branch_id', '=', branchId)
    .where('expenses.created_at', '>=', new Date(`${from}T00:00:00Z`))
    .where('expenses.created_at', '<', new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000))
    .orderBy('expenses.created_at', 'desc')
    .execute();
  const byCategory = new Map<string, number>();
  for (const r of rows)
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amountPaisa);
  return {
    items: rows,
    totalPaisa: rows.reduce((n, r) => n + r.amountPaisa, 0),
    byCategory: [...byCategory.entries()]
      .map(([category, totalPaisa]) => ({ category, totalPaisa }))
      .sort((x, y) => y.totalPaisa - x.totalPaisa),
  };
}
