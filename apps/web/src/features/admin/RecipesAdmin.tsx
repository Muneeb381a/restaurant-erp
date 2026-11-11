import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import type { AdminMenu, MarginRow, RecipeView } from '../../lib/types';
import { Dialog, ErrorText, td, th } from './ui';
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

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">{t('recipePage.title')}</h1>
      <p className="text-sm text-slate-600">{t('recipePage.hint')}</p>
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>{t('recipePage.item')}</th>
              <th className={th}>{t('recipePage.cost')}</th>
              <th className={th}>{t('recipePage.price')}</th>
              <th className={th}>{t('recipePage.foodCost')}</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.variantId}
                className="border-t border-slate-100"
                data-testid={`recipe-row-${r.item}${r.variant ? `-${r.variant}` : ''}`}
              >
                <td className={td}>
                  {r.item} {r.variant && <span className="text-slate-500">({r.variant})</span>}
                </td>
                <td className={td}>
                  {r.costPaisa === null ? (
                    <span className="text-slate-400">{t('recipePage.noRecipe')}</span>
                  ) : (
                    ltr(formatRs(r.costPaisa))
                  )}
                </td>
                <td className={td}>{r.pricePaisa === null ? '—' : ltr(formatRs(r.pricePaisa))}</td>
                <td className={td}>
                  {r.foodCostBps === null ? '—' : ltr(`${(r.foodCostBps / 100).toFixed(1)}%`)}
                </td>
                <td className={td}>
                  <button
                    className="btn-secondary"
                    onClick={() => setEditing(r)}
                    aria-label={`${t('recipePage.edit')} ${r.item}`}
                  >
                    {t('recipePage.edit')}
                  </button>
                </td>
              </tr>
            ))}
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
