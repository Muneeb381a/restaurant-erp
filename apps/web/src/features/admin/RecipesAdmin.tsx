import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import type { AdminMenu, MarginRow, RecipeView } from '../../lib/types';
import { Icon } from '../../components/Icon';
import { Dialog, EmptyRow, ErrorText, PageHead } from './ui';
import { useIngredients } from './StockAdmin';

interface Row {
  variantId: string;
  item: string;
  variant: string;
  costPaisa: number | null;
  pricePaisa: number | null;
  foodCostBps: number | null;
}

/** Every sellable variant with its recipe cost, price and food cost %; edit a recipe from here. */
export function RecipesAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const menu = useQuery({ queryKey: ['admin-menu'], queryFn: () => api<AdminMenu>('/menu/admin') });
  const margins = useQuery({
    queryKey: ['margins'],
    queryFn: async () => (await api<{ items: MarginRow[] }>('/inventory/margins')).items,
  });
  const [editing, setEditing] = useState<Row | null>(null);
  const [search, setSearch] = useState('');
  const [missing, setMissing] = useState(false);

  const withRecipe = new Map((margins.data ?? []).map((m) => [m.variantId, m]));
  const rows: Row[] = (menu.data?.items ?? [])
    .filter((i) => i.kind !== 'DEAL' && i.isActive)
    .flatMap((i) =>
      i.variants.map((v) => {
        const m = withRecipe.get(v.id);
        return {
          variantId: v.id,
          item: i.name,
          variant: i.variants.length > 1 ? v.name : '',
          costPaisa: m?.costPaisa ?? null,
          pricePaisa: m?.pricePaisa ?? null,
          foodCostBps: m?.foodCostBps ?? null,
        };
      }),
    );

  const shown = rows.filter(
    (r) =>
      (!missing || r.costPaisa === null) &&
      (!search.trim() ||
        `${r.item} ${r.variant}`.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const withoutRecipe = rows.filter((r) => r.costPaisa === null).length;

  return (
    <div className="max-w-6xl space-y-4 p-4 md:p-6">
      <PageHead title={t('recipePage.title')} hint={t('recipePage.hint')} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="seg-item border border-slate-400 bg-white"
          aria-pressed={missing}
          onClick={() => setMissing(!missing)}
        >
          {t('recipePage.onlyMissing', { count: withoutRecipe })}
        </button>
      </div>
      <div className="dt">
        <table className="min-w-[36rem]">
          <thead>
            <tr>
              <th>{t('recipePage.item')}</th>
              <th className="num">{t('recipePage.cost')}</th>
              <th className="num">{t('recipePage.price')}</th>
              <th className="num">{t('recipePage.foodCost')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const bps = r.foodCostBps;
              const tone =
                bps === null
                  ? ''
                  : bps <= 3000
                    ? 'chip-ok'
                    : bps <= 4000
                      ? 'chip-warn'
                      : 'chip-bad';
              return (
                <tr
                  key={r.variantId}
                  data-testid={`recipe-row-${r.item}${r.variant ? `-${r.variant}` : ''}`}
                >
                  <td className="name">
                    {r.item}{' '}
                    {r.variant && <span className="font-normal text-slate-600">({r.variant})</span>}
                  </td>
                  <td className="num">
                    {r.costPaisa === null ? (
                      <span className="chip-warn">{t('recipePage.noRecipe')}</span>
                    ) : (
                      ltr(formatRs(r.costPaisa))
                    )}
                  </td>
                  <td className="num">
                    {r.pricePaisa === null ? '—' : ltr(formatRs(r.pricePaisa))}
                  </td>
                  <td className="num">
                    {bps === null ? (
                      '—'
                    ) : (
                      <span className={tone}>{ltr(`${(bps / 100).toFixed(1)}%`)}</span>
                    )}
                  </td>
                  <td className="text-end">
                    <button
                      className="btn-secondary"
                      onClick={() => setEditing(r)}
                      aria-label={`${t('recipePage.edit')} ${r.item}`}
                    >
                      {t('recipePage.edit')}
                    </button>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <EmptyRow cols={5} icon="search" text={t('recipePage.none')} />}
          </tbody>
        </table>
      </div>
      {editing && (
        <RecipeDialog
          row={editing}
          onClose={() => setEditing(null)}
          onDone={() =>
            void Promise.all(['margins'].map((k) => qc.invalidateQueries({ queryKey: [k] })))
          }
        />
      )}
    </div>
  );
}

function RecipeDialog({
  row,
  onClose,
  onDone,
}: {
  row: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const ingredients = useIngredients();
  const [lines, setLines] = useState<{ ingredientId: string; qty: string }[] | null>(null);
  useQuery({
    queryKey: ['recipe', row.variantId],
    staleTime: 0,
    queryFn: async () => {
      const r = await api<RecipeView>(`/variants/${row.variantId}/recipe`);
      setLines(
        r.lines.length
          ? r.lines.map((l) => ({ ingredientId: l.ingredientId, qty: l.qty }))
          : [{ ingredientId: '', qty: '' }],
      );
      return r;
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/variants/${row.variantId}/recipe`, {
        method: 'PUT',
        body: {
          lines: (lines ?? [])
            .filter((l) => l.ingredientId)
            .map((l) => ({ ingredientId: l.ingredientId, qty: Number(l.qty) })),
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const valid = (lines ?? []).every((l) => !l.ingredientId || Number(l.qty) > 0);
  const patch = (i: number, p: Partial<{ ingredientId: string; qty: string }>): void =>
    setLines((ls) => (ls ?? []).map((l, k) => (k === i ? { ...l, ...p } : l)));

  return (
    <Dialog title={`${t('recipePage.edit')}: ${row.item} ${row.variant}`} onClose={onClose}>
      {!lines ? (
        <p>{t('common.loading')}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{t('recipePage.lines')}</p>
          {lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className="input flex-1"
                value={l.ingredientId}
                onChange={(e) => patch(i, { ingredientId: e.target.value })}
                aria-label={`${t('recipePage.item')} ${i + 1}`}
              >
                <option value="">—</option>
                {(ingredients.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.baseUom})
                  </option>
                ))}
              </select>
              <input
                className="input w-28"
                inputMode="decimal"
                value={l.qty}
                onChange={(e) => patch(i, { qty: e.target.value })}
                aria-label={`${t('recipePage.qty')} ${i + 1}`}
              />
              <button
                className="btn-secondary"
                onClick={() => setLines(lines.filter((_, k) => k !== i))}
                aria-label={t('recipePage.remove')}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn-secondary"
            onClick={() => setLines([...lines, { ingredientId: '', qty: '' }])}
          >
            + {t('recipePage.addLine')}
          </button>
          <ErrorText error={save.error} />
          <button
            className="btn-primary w-full"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('recipePage.save')}
          </button>
        </div>
      )}
    </Dialog>
  );
}
