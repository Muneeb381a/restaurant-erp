import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor } from '../orders/orders.service';
import {
  countStocktakeLine,
  createExpense,
  createIngredient,
  createPurchase,
  createSupplier,
  foodCostReport,
  getPrepRecipe,
  getStocktake,
  getVariantRecipe,
  listExpenses,
  listIngredients,
  listMovements,
  listPurchases,
  listSuppliers,
  makePrepBatch,
  paySupplier,
  postStocktake,
  recipeMargins,
  recordLoss,
  setPrepRecipe,
  setVariantRecipe,
  startStocktake,
  updateIngredient,
} from './inventory.service';

const qty = z.union([
  z.number().positive().max(1_000_000_000),
  z.string().regex(/^\d{1,12}(\.\d{1,4})?$/),
]);
const paisa = z.number().int().min(0).max(1_000_000_000_000);
const source = z.enum(['DRAWER_CASH', 'OWNER_CASH', 'BANK']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const recipeBody = z
  .object({
    outputQty: qty.optional(),
    lines: z.array(z.object({ ingredientId: z.string().uuid(), qty }).strict()).max(60),
  })
  .strict();

export function inventoryRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const view = [...read, requirePermission(ctx, 'report.view')];
  const stock = [...read, requirePermission(ctx, 'stock.manage')];
  const money = [...read, requirePermission(ctx, 'expense.manage')];
  const actor = async (req: Request): Promise<Actor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });
  const key = (req: Request): string => {
    const k = req.header('idempotency-key');
    if (!k || !/^[A-Za-z0-9._:-]{8,80}$/.test(k))
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
      );
    return k;
  };
  const range = (req: Request): { from: string; to: string } => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    return q;
  };

  // ── ingredients and stock
  r.get(
    '/inventory/ingredients',
    ...view,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          search: z.string().max(100).optional(),
          low: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      res.json({
        items: await listIngredients(ctx, req.branchId!, {
          search: q.search,
          lowOnly: q.low === 'true',
        }),
      });
    }),
  );
  r.post(
    '/inventory/ingredients',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          name: text(120),
          nameUr: z.string().trim().max(120).nullable().optional(),
          category: z.string().trim().max(40).nullable().optional(),
          baseUom: z.enum(['g', 'ml', 'pcs']),
          purchaseUom: text(30),
          purchaseToBase: z.union([
            z.number().positive(),
            z.string().regex(/^\d{1,10}(\.\d{1,4})?$/),
          ]),
          yieldBps: z.number().int().min(1).max(10_000).optional(),
          isPrep: z.boolean().optional(),
          reorderLevel: qty.nullable().optional(),
          openingQty: qty.optional(),
          openingCostPaisaPerPurchase: paisa.optional(),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await createIngredient(ctx, await actor(req), body));
    }),
  );
  r.patch(
    '/inventory/ingredients/:id',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          name: text(120).optional(),
          nameUr: z.string().trim().max(120).nullable().optional(),
          category: z.string().trim().max(40).nullable().optional(),
          reorderLevel: qty.nullable().optional(),
          yieldBps: z.number().int().min(1).max(10_000).optional(),
          isActive: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      res.json(
        await updateIngredient(ctx, await actor(req), idParam.parse(req.params).id, body as never),
      );
    }),
  );
  r.get(
    '/inventory/movements',
    ...view,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          ingredientId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      res.json({ items: await listMovements(ctx, req.branchId!, q) });
    }),
  );
  r.post(
    '/inventory/wastage',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          ingredientId: z.string().uuid(),
          qty,
          kind: z.enum(['WASTAGE', 'STAFF_MEAL']).default('WASTAGE'),
          reasonCode: z.string().trim().max(40).optional(),
          note: z.string().trim().max(300).optional(),
        })
        .strict()
        .parse(req.body);
      const out = await recordLoss(ctx, await actor(req), body, key(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );
  r.post(
    '/inventory/prep-batches',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({ ingredientId: z.string().uuid(), batches: qty })
        .strict()
        .parse(req.body);
      const out = await makePrepBatch(ctx, await actor(req), body, key(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );

  // ── recipes
  r.get(
    '/variants/:id/recipe',
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await getVariantRecipe(ctx, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.put(
    '/variants/:id/recipe',
    ...stock,
    asyncHandler(async (req, res) => {
      res.json(
        await setVariantRecipe(
          ctx,
          await actor(req),
          idParam.parse(req.params).id,
          recipeBody.parse(req.body),
        ),
      );
    }),
  );
  r.get(
    '/inventory/ingredients/:id/recipe',
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await getPrepRecipe(ctx, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.put(
    '/inventory/ingredients/:id/recipe',
    ...stock,
    asyncHandler(async (req, res) => {
      res.json(
        await setPrepRecipe(
          ctx,
          await actor(req),
          idParam.parse(req.params).id,
          recipeBody.parse(req.body),
        ),
      );
    }),
  );
  r.get(
    '/inventory/margins',
    ...view,
    asyncHandler(async (req, res) => {
      res.json({ items: await recipeMargins(ctx, req.branchId!) });
    }),
  );

  // ── suppliers and purchases
  r.get(
    '/suppliers',
    ...view,
    asyncHandler(async (req, res) => {
      res.json({ items: await listSuppliers(ctx, req.branchId!) });
    }),
  );
  r.post(
    '/suppliers',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          name: text(120),
          phone: z.string().trim().max(30).optional(),
          notes: z.string().trim().max(300).optional(),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await createSupplier(ctx, await actor(req), body));
    }),
  );
  r.post(
    '/suppliers/:id/payments',
    ...money,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          amountPaisa: paisa.refine((n) => n > 0, 'must be positive'),
          source,
          note: z.string().trim().max(300).optional(),
        })
        .strict()
        .parse(req.body);
      const out = await paySupplier(
        ctx,
        await actor(req),
        idParam.parse(req.params).id,
        body,
        key(req),
      );
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );
  r.get(
    '/purchases',
    ...view,
    asyncHandler(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
      res.json({ items: await listPurchases(ctx, req.branchId!, limit) });
    }),
  );
  r.post(
    '/purchases',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          supplierId: z.string().uuid().optional(),
          invoiceRef: z.string().trim().max(60).optional(),
          lines: z
            .array(
              z.object({ ingredientId: z.string().uuid(), qty, unitCostPaisa: paisa }).strict(),
            )
            .min(1)
            .max(80),
          payment: z.object({ amountPaisa: paisa, source }).strict().optional(),
        })
        .strict()
        .parse(req.body);
      // paying a supplier is money going out: it needs the expense permission as well
      const a = await actor(req);
      if (body.payment && !a.permissions.has('expense.manage'))
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
          permission: 'expense.manage',
        });
      const out = await createPurchase(ctx, a, body, key(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );

  // ── stocktake
  r.post(
    '/stocktakes',
    ...stock,
    asyncHandler(async (req, res) => {
      res.status(201).json(await startStocktake(ctx, await actor(req)));
    }),
  );
  r.get(
    '/stocktakes/:id',
    ...stock,
    asyncHandler(async (req, res) => {
      res.json(await getStocktake(ctx.db, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.get(
    '/stocktakes',
    ...stock,
    asyncHandler(async (req, res) => {
      const rows = await ctx.db
        .selectFrom('stocktakes')
        .select(['id', 'status', 'created_at as createdAt', 'posted_at as postedAt'])
        .where('branch_id', '=', req.branchId!)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      res.json({ items: rows });
    }),
  );
  r.put(
    '/stocktakes/:id/lines',
    ...stock,
    asyncHandler(async (req, res) => {
      const body = z
        .object({ ingredientId: z.string().uuid(), countedQty: qty.nullable() })
        .strict()
        .parse(req.body);
      res.json(await countStocktakeLine(ctx, await actor(req), idParam.parse(req.params).id, body));
    }),
  );
  r.post(
    '/stocktakes/:id/post',
    ...stock,
    asyncHandler(async (req, res) => {
      res.json(await postStocktake(ctx, await actor(req), idParam.parse(req.params).id));
    }),
  );

  // ── reports and expenses
  r.get(
    '/inventory/food-cost',
    ...[...read, requirePermission(ctx, 'report.financial')],
    asyncHandler(async (req, res) => {
      const { from, to } = range(req);
      res.json(await foodCostReport(ctx, req.branchId!, from, to));
    }),
  );
  r.get(
    '/expenses',
    ...money,
    asyncHandler(async (req, res) => {
      const { from, to } = range(req);
      res.json(await listExpenses(ctx, req.branchId!, from, to));
    }),
  );
  r.post(
    '/expenses',
    ...money,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          category: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .transform((s) => s.toUpperCase()),
          amountPaisa: paisa.refine((n) => n > 0, 'must be positive'),
          paidFrom: source,
          note: z.string().trim().max(300).optional(),
        })
        .strict()
        .parse(req.body);
      const out = await createExpense(ctx, await actor(req), body, key(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );
  return r;
}
