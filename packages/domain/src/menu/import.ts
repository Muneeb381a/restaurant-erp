import { MoneyError, parseRupees, type Paisa } from '../money';
import { dayBefore, type IsoDate } from './price';

/**
 * Menu CSV import — pure part: validate rows and diff against what exists.
 * One CSV row = one item variant. Rows of the same `item_code` form one item.
 * Prices are rupees ("1,250.50"); one `price_<pricelist>` column per price list
 * (price_dine_in, price_takeaway, …). A blank price means "not sold on that channel".
 * Blank optional cells mean "leave unchanged". Nothing is ever deleted by an import.
 */

export const REQUIRED_COLUMNS = ['item_code', 'item_name'] as const;
export const OPTIONAL_COLUMNS = [
  'category',
  'category_ur',
  'item_name_ur',
  'kind',
  'station',
  'tax_category',
  'variant',
  'variant_ur',
  'search_terms',
  'available',
] as const;

export interface ImportContext {
  /** Price list codes of the branch, any case. */
  priceListCodes: readonly string[];
  stationCodes: readonly string[];
  taxCategoryCodes: readonly string[];
}

export interface RowError {
  /** 1-based spreadsheet line (header = line 1). */
  line: number;
  message: string;
}

export interface ParsedVariant {
  name: string;
  nameUr: string | null;
  isDefault: boolean;
  /** by upper-case price list code */
  prices: Record<string, Paisa>;
  line: number;
}

export interface ParsedItem {
  code: string;
  name: string;
  nameUr: string | null;
  categoryName: string | null;
  categoryNameUr: string | null;
  kind: 'STANDARD' | 'WEIGHT';
  stationCode: string | null;
  taxCategoryCode: string | null;
  searchTerms: string | null;
  /** null = not specified in the file (leave unchanged / default true for new items) */
  available: boolean | null;
  variants: ParsedVariant[];
  line: number;
}

const CODE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);
const KNOWN = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

export function validateHeaders(headers: readonly string[], ctx: ImportContext): RowError[] {
  const errors: RowError[] = [];
  const lists = new Set(ctx.priceListCodes.map((c) => c.toUpperCase()));
  for (const col of REQUIRED_COLUMNS) {
    if (!headers.includes(col))
      errors.push({ line: 1, message: `Missing required column "${col}"` });
  }
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) errors.push({ line: 1, message: `Column "${h}" appears twice` });
    seen.add(h);
    if (KNOWN.has(h)) continue;
    if (h.startsWith('price_')) {
      const list = h.slice('price_'.length).toUpperCase();
      if (!lists.has(list)) {
        errors.push({
          line: 1,
          message: `Column "${h}": no price list with code "${list}" (have: ${[...lists].join(', ') || 'none'})`,
        });
      }
    } else {
      errors.push({ line: 1, message: `Unknown column "${h}"` });
    }
  }
  return errors;
}

interface Draft {
  item: Omit<ParsedItem, 'variants' | 'kind'> & { kind: 'STANDARD' | 'WEIGHT' | null };
  rows: {
    line: number;
    variantName: string | null;
    variantNameUr: string | null;
    prices: Record<string, Paisa>;
  }[];
  /** line where each item-level field was first set (for conflict messages) */
  setAt: Record<string, number>;
}

/** Validates records (header names already trimmed + lower-cased) into items. Collects ALL errors. */
export function parseMenuRecords(
  records: readonly Record<string, string>[],
  ctx: ImportContext,
): { items: ParsedItem[]; errors: RowError[]; warnings: string[] } {
  const errors: RowError[] = [];
  const warnings: string[] = [];
  const drafts = new Map<string, Draft>();
  const stations = new Map(ctx.stationCodes.map((s) => [s.toLowerCase(), s]));
  const taxes = new Map(ctx.taxCategoryCodes.map((s) => [s.toLowerCase(), s]));

  records.forEach((rec, idx) => {
    const line = idx + 2;
    const cell = (col: string): string | null => {
      const v = rec[col]?.trim();
      return v ? v : null;
    };
    const err = (message: string): void => void errors.push({ line, message });

    const code = cell('item_code');
    if (!code) return err('item_code is required');
    if (!CODE_RE.test(code))
      return err(`item_code "${code}" may only contain letters, digits, . _ - (max 40)`);

    // ---- item-level fields
    const name = cell('item_name');
    const nameUr = cell('item_name_ur');
    const categoryName = cell('category');
    const categoryNameUr = cell('category_ur');
    const searchTerms = cell('search_terms');
    if (name && name.length > 200) err('item_name is longer than 200 characters');
    if (categoryName && categoryName.length > 100) err('category is longer than 100 characters');
    if (searchTerms && searchTerms.length > 300) err('search_terms is longer than 300 characters');
    if (categoryNameUr && !categoryName) err('category_ur needs category on the same row');

    let kind: 'STANDARD' | 'WEIGHT' | null = null;
    const kindRaw = cell('kind');
    if (kindRaw) {
      const k = kindRaw.toUpperCase();
      if (k === 'STANDARD' || k === 'WEIGHT') kind = k;
      else if (k === 'DEAL') err('kind DEAL cannot be imported from CSV: create deals in the app');
      else err(`kind "${kindRaw}" must be STANDARD or WEIGHT`);
    }

    let stationCode: string | null = null;
    const stationRaw = cell('station');
    if (stationRaw) {
      stationCode = stations.get(stationRaw.toLowerCase()) ?? null;
      if (!stationCode)
        err(
          `station "${stationRaw}" does not exist (have: ${[...stations.values()].join(', ') || 'none'})`,
        );
    }

    let taxCategoryCode: string | null = null;
    const taxRaw = cell('tax_category');
    if (taxRaw) {
      taxCategoryCode = taxes.get(taxRaw.toLowerCase()) ?? null;
      if (!taxCategoryCode) err(`tax_category "${taxRaw}" does not exist`);
    }

    let available: boolean | null = null;
    const availRaw = cell('available');
    if (availRaw) {
      const a = availRaw.toLowerCase();
      if (TRUE_WORDS.has(a)) available = true;
      else if (FALSE_WORDS.has(a)) available = false;
      else err(`available "${availRaw}" must be yes or no`);
    }

    // ---- variant-level fields
    const prices: Record<string, Paisa> = {};
    for (const [col, raw] of Object.entries(rec)) {
      if (!col.startsWith('price_') || !raw.trim()) continue;
      try {
        prices[col.slice('price_'.length).toUpperCase()] = parseRupees(raw);
      } catch (e) {
        if (!(e instanceof MoneyError)) throw e;
        err(
          `${col}: "${raw.trim()}" is not a valid amount (use e.g. 1250 or 1,250.50; no negatives)`,
        );
      }
    }
    const variantName = cell('variant');
    if (variantName && variantName.length > 100) err('variant is longer than 100 characters');

    // ---- merge into the item draft
    let found = drafts.get(code);
    if (!found) {
      found = {
        item: {
          code,
          name: '',
          nameUr: null,
          categoryName: null,
          categoryNameUr: null,
          kind: null,
          stationCode: null,
          taxCategoryCode: null,
          searchTerms: null,
          available: null,
          line,
        },
        rows: [],
        setAt: {},
      };
      drafts.set(code, found);
    }
    const d: Draft = found;
    const merge = <
      K extends
        | 'nameUr'
        | 'categoryName'
        | 'categoryNameUr'
        | 'kind'
        | 'stationCode'
        | 'taxCategoryCode'
        | 'searchTerms'
        | 'available',
    >(
      field: K,
      value: Draft['item'][K],
      label: string,
    ): void => {
      if (value === null) return;
      const current = d.item[field];
      if (current === null) {
        d.item[field] = value;
        d.setAt[field] = line;
      } else if (current !== value) {
        err(
          `${label} "${String(value)}" conflicts with "${String(current)}" on line ${d.setAt[field]} for item ${code}`,
        );
      }
    };
    if (name) {
      if (!d.item.name) {
        d.item.name = name;
        d.setAt.name = line;
      } else if (d.item.name !== name) {
        err(
          `item_name "${name}" conflicts with "${d.item.name}" on line ${d.setAt.name} for item ${code}`,
        );
      }
    }
    merge('nameUr', nameUr, 'item_name_ur');
    merge('categoryName', categoryName, 'category');
    merge('categoryNameUr', categoryNameUr, 'category_ur');
    merge('kind', kind, 'kind');
    merge('stationCode', stationCode, 'station');
    merge('taxCategoryCode', taxCategoryCode, 'tax_category');
    merge('searchTerms', searchTerms, 'search_terms');
    merge('available', available, 'available');
    d.rows.push({ line, variantName, variantNameUr: cell('variant_ur'), prices });
  });

  const items: ParsedItem[] = [];
  for (const d of drafts.values()) {
    const { item } = d;
    if (!item.name) {
      errors.push({ line: item.line, message: `item_name is required for item ${item.code}` });
      continue;
    }
    const kind = item.kind ?? 'STANDARD';
    const multi = d.rows.length > 1;
    const variants: ParsedVariant[] = [];
    const names = new Set<string>();
    for (const row of d.rows) {
      let vName = row.variantName;
      if (!vName) {
        if (multi) {
          errors.push({
            line: row.line,
            message: `variant is required because item ${item.code} has several rows`,
          });
          continue;
        }
        vName = kind === 'WEIGHT' ? 'Per kg' : 'Regular';
      }
      if (names.has(vName.toLowerCase())) {
        errors.push({
          line: row.line,
          message: `Variant "${vName}" appears twice for item ${item.code}`,
        });
        continue;
      }
      names.add(vName.toLowerCase());
      if (Object.keys(row.prices).length === 0) {
        warnings.push(
          `Line ${row.line}: ${item.code} / ${vName} has no price on any channel, so it will not be sold anywhere`,
        );
      }
      variants.push({
        name: vName,
        nameUr: row.variantNameUr,
        isDefault: variants.length === 0,
        prices: row.prices,
        line: row.line,
      });
    }
    if (kind === 'WEIGHT' && d.rows.length > 1) {
      errors.push({
        line: item.line,
        message: `WEIGHT item ${item.code} must have exactly one row (its price is per kg)`,
      });
    }
    items.push({ ...item, kind, variants });
  }
  return { items, errors, warnings };
}

// ───────────────────────────────── planning ─────────────────────────────────

export interface ExistingPrice {
  listCode: string;
  pricePaisa: Paisa;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
}
export interface ExistingVariant {
  id: string;
  name: string;
  nameUr: string | null;
  isActive: boolean;
  prices: readonly ExistingPrice[];
}
export interface ExistingItem {
  id: string;
  code: string;
  name: string;
  nameUr: string | null;
  kind: 'STANDARD' | 'WEIGHT' | 'DEAL';
  categoryId: string | null;
  stationCode: string | null;
  searchTerms: string | null;
  isAvailable: boolean;
  isActive: boolean;
  variants: readonly ExistingVariant[];
}
export interface ExistingCategory {
  id: string;
  name: string;
  nameUr: string | null;
  parentId: string | null;
}
export interface ExistingMenu {
  items: readonly ExistingItem[];
  categories: readonly ExistingCategory[];
}

export type ImportOp =
  | { type: 'createCategory'; name: string; nameUr: string | null }
  | { type: 'updateCategory'; name: string; nameUr: string }
  | { type: 'createItem'; item: Omit<ParsedItem, 'variants'> }
  | {
      type: 'updateItem';
      code: string;
      changes: {
        name?: string;
        nameUr?: string;
        categoryName?: string;
        stationCode?: string;
        searchTerms?: string;
        isAvailable?: boolean;
        reactivate?: true;
      };
    }
  | {
      type: 'createVariant';
      itemCode: string;
      variant: { name: string; nameUr: string | null; isDefault: boolean };
    }
  | {
      type: 'updateVariant';
      itemCode: string;
      variantName: string;
      changes: { nameUr?: string; reactivate?: true };
    }
  | {
      type: 'setPrice';
      itemCode: string;
      variantName: string;
      listCode: string;
      pricePaisa: Paisa;
      effectiveFrom: IsoDate;
      mode: 'new' | 'close_and_new' | 'same_day_update';
      /** for close_and_new: the previous period is closed on this date */
      closePreviousTo?: IsoDate;
    };

export interface ImportSummary {
  categoriesCreated: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  variantsCreated: number;
  variantsUpdated: number;
  pricesSet: number;
  pricesUnchanged: number;
}

export interface ImportPlan {
  ops: ImportOp[];
  summary: ImportSummary;
  warnings: string[];
  errors: RowError[];
}

/** Diffs parsed items against the existing menu. Re-importing the same file yields zero ops. */
export function planMenuImport(
  parsed: readonly ParsedItem[],
  existing: ExistingMenu,
  effectiveFrom: IsoDate,
): ImportPlan {
  const ops: ImportOp[] = [];
  const errors: RowError[] = [];
  const warnings: string[] = [];
  const summary: ImportSummary = {
    categoriesCreated: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsUnchanged: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    pricesSet: 0,
    pricesUnchanged: 0,
  };

  const byCode = new Map(existing.items.map((i) => [i.code, i]));
  const topCategories = new Map(
    existing.categories.filter((c) => c.parentId === null).map((c) => [c.name.toLowerCase(), c]),
  );
  const plannedCategories = new Set<string>();

  for (const item of parsed) {
    const before = ops.length;
    const itemOps: ImportOp[] = [];
    const current = byCode.get(item.code);

    // ---- category
    if (item.categoryName) {
      const key = item.categoryName.toLowerCase();
      const cat = topCategories.get(key);
      if (!cat && !plannedCategories.has(key)) {
        plannedCategories.add(key);
        ops.push({ type: 'createCategory', name: item.categoryName, nameUr: item.categoryNameUr });
        summary.categoriesCreated++;
      } else if (cat && item.categoryNameUr && cat.nameUr !== item.categoryNameUr) {
        ops.push({ type: 'updateCategory', name: cat.name, nameUr: item.categoryNameUr });
      }
    }

    if (!current) {
      itemOps.push({ type: 'createItem', item: stripVariants(item) });
      summary.itemsCreated++;
    } else {
      if (current.kind === 'DEAL') {
        errors.push({
          line: item.line,
          message: `${item.code} is a DEAL in the app; deals cannot be changed by CSV`,
        });
        continue;
      }
      if (current.kind !== item.kind) {
        errors.push({
          line: item.line,
          message: `${item.code}: kind cannot change from ${current.kind} to ${item.kind} by import`,
        });
        continue;
      }
      const changes: Extract<ImportOp, { type: 'updateItem' }>['changes'] = {};
      if (current.name !== item.name) changes.name = item.name;
      if (item.nameUr && current.nameUr !== item.nameUr) changes.nameUr = item.nameUr;
      if (item.stationCode && current.stationCode !== item.stationCode)
        changes.stationCode = item.stationCode;
      if (item.searchTerms && current.searchTerms !== item.searchTerms)
        changes.searchTerms = item.searchTerms;
      if (item.available !== null && current.isAvailable !== item.available)
        changes.isAvailable = item.available;
      if (item.categoryName) {
        const cat = topCategories.get(item.categoryName.toLowerCase());
        if (!cat || cat.id !== current.categoryId) changes.categoryName = item.categoryName;
      }
      if (!current.isActive) {
        changes.reactivate = true;
        warnings.push(`${item.code} was deactivated; the import reactivates it`);
      }
      if (Object.keys(changes).length > 0) {
        itemOps.push({ type: 'updateItem', code: item.code, changes });
        summary.itemsUpdated++;
      }
    }

    // ---- variants and prices
    let itemOk = true;
    for (const v of item.variants) {
      const cv = current?.variants.find((x) => x.name.toLowerCase() === v.name.toLowerCase());
      if (!cv) {
        itemOps.push({
          type: 'createVariant',
          itemCode: item.code,
          variant: { name: v.name, nameUr: v.nameUr, isDefault: !current && v.isDefault },
        });
        summary.variantsCreated++;
      } else {
        const changes: Extract<ImportOp, { type: 'updateVariant' }>['changes'] = {};
        if (v.nameUr && cv.nameUr !== v.nameUr) changes.nameUr = v.nameUr;
        if (!cv.isActive) {
          changes.reactivate = true;
          warnings.push(`${item.code} / ${cv.name} was deactivated; the import reactivates it`);
        }
        if (Object.keys(changes).length > 0) {
          itemOps.push({
            type: 'updateVariant',
            itemCode: item.code,
            variantName: cv.name,
            changes,
          });
          summary.variantsUpdated++;
        }
      }

      for (const [listCode, pricePaisa] of Object.entries(v.prices)) {
        const rows = (cv?.prices ?? []).filter((p) => p.listCode.toUpperCase() === listCode);
        if (rows.some((p) => p.effectiveFrom > effectiveFrom)) {
          errors.push({
            line: v.line,
            message: `${item.code} / ${v.name} / ${listCode} has a future-dated price; change it in the app instead`,
          });
          itemOk = false;
          continue;
        }
        const active = rows.find(
          (p) =>
            p.effectiveFrom <= effectiveFrom &&
            (p.effectiveTo === null || p.effectiveTo >= effectiveFrom),
        );
        if (active && active.pricePaisa === pricePaisa) {
          summary.pricesUnchanged++;
          continue;
        }
        const base = {
          type: 'setPrice' as const,
          itemCode: item.code,
          variantName: cv?.name ?? v.name,
          listCode,
          pricePaisa,
          effectiveFrom,
        };
        if (!active) itemOps.push({ ...base, mode: 'new' });
        else if (active.effectiveFrom === effectiveFrom)
          itemOps.push({ ...base, mode: 'same_day_update' });
        else
          itemOps.push({
            ...base,
            mode: 'close_and_new',
            closePreviousTo: dayBefore(effectiveFrom),
          });
        summary.pricesSet++;
      }
    }

    if (!itemOk) continue;
    ops.push(...itemOps);
    if (current && ops.length === before) summary.itemsUnchanged++;
  }

  return { ops: errors.length ? [] : ops, summary, warnings, errors };
}

function stripVariants(item: ParsedItem): Omit<ParsedItem, 'variants'> {
  const copy: Partial<ParsedItem> = { ...item };
  delete copy.variants;
  return copy as Omit<ParsedItem, 'variants'>;
}
