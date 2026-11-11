import { ALLERGENS, GUEST_TAGS, asPaisa, sniffImage } from '@erp/domain';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { importMenu, exportMenuCsv } from './menu.import';
import { getItemFull } from './menu.repo';
import { getAdminMenu, getMenu, getMenuWarnings, popularItems } from './menu.readmodel';
import * as svc from './menu.service';

const text = (max = 200) => z.string().trim().min(1).max(max);
const nullableText = (max = 200) => z.string().trim().min(1).max(max).nullable();
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const sort = z.number().int().min(0).max(100_000);
const paisaInt = z.number().int().min(0).max(1_000_000_000);
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,40}$/, 'letters, digits, . _ - (max 40)');

const guestTags = z.array(z.enum(GUEST_TAGS)).max(GUEST_TAGS.length);
const allergens = z.array(z.enum(ALLERGENS)).max(ALLERGENS.length);

const categoryBody = z
  .object({
    name: text(100),
    nameUr: nullableText(100).optional(),
    parentId: uuid.nullable().optional(),
    sort: sort.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const variantBody = z
  .object({
    name: text(100),
    nameUr: nullableText(100).optional(),
    isDefault: z.boolean().optional(),
    sort: sort.optional(),
  })
  .strict();

const itemCreateBody = z
  .object({
    code: code.nullable().optional(),
    name: text(200),
    nameUr: nullableText(200).optional(),
    kind: z.enum(['STANDARD', 'WEIGHT', 'DEAL']),
    categoryId: uuid.nullable().optional(),
    stationId: uuid.nullable().optional(),
    searchTerms: nullableText(300).optional(),
    taxCategoryCode: text(60).optional(),
    sort: sort.optional(),
    variants: z.array(variantBody).max(30).optional(),
    description: nullableText(300).optional(),
    descriptionUr: nullableText(300).optional(),
    hiddenFromGuests: z.boolean().optional(),
    guestTags: guestTags.optional(),
    allergens: allergens.optional(),
  })
  .strict();

const itemPatchBody = z
  .object({
    code: code.nullable(),
    name: text(200),
    nameUr: nullableText(200),
    categoryId: uuid.nullable(),
    stationId: uuid.nullable(),
    searchTerms: nullableText(300),
    sort,
    isActive: z.boolean(),
    description: nullableText(300),
    descriptionUr: nullableText(300),
    hiddenFromGuests: z.boolean(),
    guestTags,
    allergens,
  })
  .partial()
  .strict();

const variantPatchBody = z
  .object({
    name: text(100),
    nameUr: nullableText(100),
    sort,
    isDefault: z.literal(true),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

const groupBody = z
  .object({
    code,
    name: text(100),
    nameUr: nullableText(100).optional(),
    minSelect: z.number().int().min(0).max(50),
    maxSelect: z.number().int().min(0).max(50),
  })
  .strict();
const groupPatch = groupBody.omit({ code: true }).partial().strict();
const modifierBody = z
  .object({
    name: text(100),
    nameUr: nullableText(100).optional(),
    priceDeltaPaisa: z.number().int().min(-1_000_000_000).max(1_000_000_000),
    sort: sort.optional(),
  })
  .strict();
const modifierPatch = modifierBody.partial().extend({ isActive: z.boolean().optional() }).strict();

const dealBody = z
  .object({
    slots: z
      .array(
        z
          .object({
            name: text(100),
            qty: z.number().int().min(1).max(100),
            options: z
              .array(
                z
                  .object({
                    variantId: uuid,
                    priceDeltaPaisa: z
                      .number()
                      .int()
                      .min(-1_000_000_000)
                      .max(1_000_000_000)
                      .optional(),
                    isDefault: z.boolean().optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const actorOf = (req: Request): svc.Actor => ({
  branchId: req.branchId!,
  userId: req.principal!.userId,
  deviceId: req.principal!.deviceId,
  ip: req.ip,
});

export function menuRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const manage = [...read, requirePermission(ctx, 'menu.manage')];
  const availability = [...read, requirePermission(ctx, 'menu.availability')];

  // ───────── categories
  r.get(
    '/categories',
    ...read,
    asyncHandler(async (req, res) => {
      const rows = await ctx.db
        .selectFrom('categories')
        .selectAll()
        .where('branch_id', '=', req.branchId!)
        .orderBy('sort')
        .orderBy('name')
        .execute();
      res.json({ items: rows });
    }),
  );
  r.post(
    '/categories',
    ...manage,
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(await svc.createCategory(ctx, actorOf(req), categoryBody.parse(req.body)));
    }),
  );
  r.patch(
    '/categories/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const body = categoryBody.partial().strict().parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      res.json(await svc.updateCategory(ctx, actorOf(req), id, body));
    }),
  );

  // ───────── items
  r.get(
    '/items',
    ...read,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          includeInactive: z.enum(['true', 'false']).default('false'),
          categoryId: uuid.optional(),
          kind: z.enum(['STANDARD', 'WEIGHT', 'DEAL']).optional(),
        })
        .parse(req.query);
      let sel = ctx.db
        .selectFrom('items')
        .selectAll()
        .where('branch_id', '=', req.branchId!)
        .orderBy('sort')
        .orderBy('name');
      if (q.includeInactive !== 'true') sel = sel.where('is_active', '=', true);
      if (q.categoryId) sel = sel.where('category_id', '=', q.categoryId);
      if (q.kind) sel = sel.where('kind', '=', q.kind);
      const items = await sel.execute();
      const variants = items.length
        ? await ctx.db
            .selectFrom('item_variants')
            .selectAll()
            .where(
              'item_id',
              'in',
              items.map((i) => i.id),
            )
            .orderBy('sort')
            .orderBy('name')
            .execute()
        : [];
      res.json({
        items: items.map((i) => ({
          id: i.id,
          code: i.code,
          name: i.name,
          nameUr: i.name_ur,
          kind: i.kind,
          categoryId: i.category_id,
          stationId: i.station_id,
          isAvailable: i.is_available,
          isActive: i.is_active,
          sort: i.sort,
          searchTerms: i.search_terms,
          description: i.description,
          descriptionUr: i.description_ur,
          hiddenFromGuests: i.hidden_from_guests,
          guestTags: i.guest_tags,
          allergens: i.allergens,
          variants: variants
            .filter((v) => v.item_id === i.id)
            .map((v) => ({
              id: v.id,
              name: v.name,
              nameUr: v.name_ur,
              isDefault: v.is_default,
              isActive: v.is_active,
            })),
        })),
      });
    }),
  );
  /** The dishes sold most in the last N days (default 14): for a "Popular" row when taking an order. */
  r.get(
    '/menu/popular',
    ...read,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          days: z.coerce.number().int().min(1).max(90).default(14),
          limit: z.coerce.number().int().min(1).max(30).default(10),
        })
        .parse(req.query);
      res.json(await popularItems(ctx, req.branchId!, q.days, q.limit));
    }),
  );
  r.get(
    '/items/:id',
    ...read,
    asyncHandler(async (req, res) => {
      res.json(await getItemFull(ctx.db, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.post(
    '/items',
    ...manage,
    asyncHandler(async (req, res) => {
      res.status(201).json(await svc.createItem(ctx, actorOf(req), itemCreateBody.parse(req.body)));
    }),
  );
  r.patch(
    '/items/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const body = itemPatchBody.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      res.json(await svc.updateItem(ctx, actorOf(req), id, body));
    }),
  );
  /** One photo per dish. The browser shrinks it first; the server checks the bytes, not the declared type. */
  r.put(
    '/items/:id/image',
    ...manage,
    express.raw({ type: () => true, limit: '600kb' }),
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const data: unknown = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'Send the image as the request body');
      const contentType = sniffImage(data);
      if (!contentType)
        throw new AppError(400, 'VALIDATION_FAILED', 'The photo must be a JPEG, PNG or WebP image');
      res.json(await svc.setItemImage(ctx, actorOf(req), id, { contentType, data }));
    }),
  );
  r.get(
    '/items/:id/image',
    ...read,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const row = await ctx.db
        .selectFrom('item_images')
        .innerJoin('items', 'items.id', 'item_images.item_id')
        .select(['item_images.content_type as contentType', 'item_images.data as data'])
        .where('item_images.item_id', '=', id)
        .where('items.branch_id', '=', req.branchId!)
        .executeTakeFirst();
      if (!row) throw new AppError(404, 'NOT_FOUND', 'No photo');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache');
      res.type(row.contentType).send(row.data);
    }),
  );
  r.delete(
    '/items/:id/image',
    ...manage,
    asyncHandler(async (req, res) => {
      res.json(await svc.clearItemImage(ctx, actorOf(req), idParam.parse(req.params).id));
    }),
  );
  r.patch(
    '/items/:id/availability',
    ...availability,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const { isAvailable } = z.object({ isAvailable: z.boolean() }).strict().parse(req.body);
      res.json(await svc.setAvailability(ctx, actorOf(req), id, isAvailable));
    }),
  );

  // ───────── variants + prices
  r.post(
    '/items/:id/variants',
    ...manage,
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(
          await svc.createVariant(
            ctx,
            actorOf(req),
            idParam.parse(req.params).id,
            variantBody.parse(req.body),
          ),
        );
    }),
  );
  r.patch(
    '/variants/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const body = variantPatchBody.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      res.json(await svc.updateVariant(ctx, actorOf(req), idParam.parse(req.params).id, body));
    }),
  );
  r.put(
    '/variants/:id/prices/:priceListId',
    ...manage,
    asyncHandler(async (req, res) => {
      const p = z.object({ id: uuid, priceListId: uuid }).parse(req.params);
      const body = z
        .object({ pricePaisa: paisaInt, effectiveFrom: isoDate.optional() })
        .strict()
        .parse(req.body);
      res.json(
        await svc.setPrice(
          ctx,
          actorOf(req),
          p.id,
          p.priceListId,
          asPaisa(body.pricePaisa),
          body.effectiveFrom,
        ),
      );
    }),
  );

  // ───────── modifiers
  r.get(
    '/modifier-groups',
    ...read,
    asyncHandler(async (req, res) => {
      const groups = await ctx.db
        .selectFrom('modifier_groups')
        .selectAll()
        .where('branch_id', '=', req.branchId!)
        .orderBy('name')
        .execute();
      const mods = groups.length
        ? await ctx.db
            .selectFrom('modifiers')
            .selectAll()
            .where(
              'group_id',
              'in',
              groups.map((g) => g.id),
            )
            .orderBy('sort')
            .orderBy('name')
            .execute()
        : [];
      res.json({
        items: groups.map((g) => ({ ...g, modifiers: mods.filter((m) => m.group_id === g.id) })),
      });
    }),
  );
  r.post(
    '/modifier-groups',
    ...manage,
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(await svc.createModifierGroup(ctx, actorOf(req), groupBody.parse(req.body)));
    }),
  );
  r.patch(
    '/modifier-groups/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const body = groupPatch.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      res.json(
        await svc.updateModifierGroup(ctx, actorOf(req), idParam.parse(req.params).id, body),
      );
    }),
  );
  r.post(
    '/modifier-groups/:id/modifiers',
    ...manage,
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(
          await svc.createModifier(
            ctx,
            actorOf(req),
            idParam.parse(req.params).id,
            modifierBody.parse(req.body),
          ),
        );
    }),
  );
  r.patch(
    '/modifiers/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const body = modifierPatch.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      res.json(await svc.updateModifier(ctx, actorOf(req), idParam.parse(req.params).id, body));
    }),
  );
  r.put(
    '/items/:id/modifier-groups',
    ...manage,
    asyncHandler(async (req, res) => {
      const { groupIds } = z
        .object({ groupIds: z.array(uuid).max(30) })
        .strict()
        .parse(req.body);
      res.json(
        await svc.setItemModifierGroups(ctx, actorOf(req), idParam.parse(req.params).id, groupIds),
      );
    }),
  );

  // ───────── deals
  r.put(
    '/items/:id/deal',
    ...manage,
    asyncHandler(async (req, res) => {
      res.json(
        await svc.setDeal(
          ctx,
          actorOf(req),
          idParam.parse(req.params).id,
          dealBody.parse(req.body),
        ),
      );
    }),
  );

  // ───────── POS read model, admin warnings, CSV
  r.get(
    '/menu',
    ...read,
    asyncHandler(async (req, res) => {
      const q = z
        .object({ priceList: z.string().min(1).max(40).optional(), date: isoDate.optional() })
        .parse(req.query);
      const { etag, body } = await getMenu(ctx, {
        branchId: req.branchId!,
        priceList: q.priceList,
        date: q.date,
      });
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, no-cache'); // always revalidate; 304 keeps it cheap
      if (req.header('if-none-match') === etag) return void res.status(304).end();
      res.type('application/json').send(body);
    }),
  );
  r.get(
    '/menu/admin',
    ...manage,
    asyncHandler(async (req, res) => {
      const q = z.object({ date: isoDate.optional() }).parse(req.query);
      res.json(await getAdminMenu(ctx, req.branchId!, q.date));
    }),
  );
  r.get(
    '/menu/warnings',
    ...manage,
    asyncHandler(async (req, res) => {
      const q = z.object({ date: isoDate.optional() }).parse(req.query);
      res.json(await getMenuWarnings(ctx, req.branchId!, q.date));
    }),
  );
  r.get(
    '/menu/export.csv',
    ...manage,
    asyncHandler(async (req, res) => {
      const q = z.object({ date: isoDate.optional() }).parse(req.query);
      res
        .type('text/csv; charset=utf-8')
        .setHeader('Content-Disposition', 'attachment; filename="menu.csv"');
      res.send(await exportMenuCsv(ctx, req.branchId!, q.date));
    }),
  );
  r.post(
    '/menu/import',
    ...manage,
    express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
    asyncHandler(async (req, res) => {
      if (typeof req.body !== 'string')
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send the CSV as the request body with Content-Type: text/csv',
        );
      const q = z
        .object({
          dryRun: z.enum(['true', 'false']).default('true'),
          effectiveFrom: isoDate.optional(),
        })
        .parse(req.query);
      // Safe default: a bare call is a dry run; applying needs an explicit dryRun=false.
      res.json(
        await importMenu(ctx, actorOf(req), req.body, {
          dryRun: q.dryRun === 'true',
          effectiveFrom: q.effectiveFrom,
        }),
      );
    }),
  );

  return r;
}
