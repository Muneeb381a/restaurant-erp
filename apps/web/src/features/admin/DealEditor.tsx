import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import type { AdminItem, AdminMenu } from '../../lib/types';
import { Dialog, ErrorText } from './ui';

interface OptionRow {
  variantId: string;
  /** Rupees as typed (may be negative); converted to integer paisa on save. */
  delta: string;
  isDefault: boolean;
}
interface SlotRow {
  name: string;
  qty: string;
  options: OptionRow[];
}
interface DealRead {
  deal: {
    slots: {
      name: string;
      qty: number;
      options: { variantId: string; priceDeltaPaisa: number; isDefault: boolean }[];
    }[];
  } | null;
}

/** "-50", "25.5" → integer paisa without floats; null when it is not an amount. */
export function parseSignedRs(text: string): number | null {
  const m = /^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const paisa = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -paisa : paisa;
}
const rupees = (paisa: number): string =>
  paisa === 0 ? '0' : (paisa / 100).toFixed(2).replace(/\.00$/, '');

/** Edits what a deal contains: slots ("choose a karahi"), how many, and which items may fill each. */
export function DealEditor({
  item,
  menu,
  onClose,
  onDone,
}: {
  item: AdminItem;
  menu: AdminMenu;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [slots, setSlots] = useState<SlotRow[] | null>(null);

  const current = useQuery({
    queryKey: ['deal', item.id],
    queryFn: async () => {
      const full = await api<DealRead>(`/items/${item.id}`);
      const rows: SlotRow[] = (full.deal?.slots ?? []).map((s) => ({
        name: s.name,
        qty: String(s.qty),
        options: s.options.map((o) => ({
          variantId: o.variantId,
          delta: rupees(o.priceDeltaPaisa),
          isDefault: o.isDefault,
        })),
      }));
      setSlots(rows.length ? rows : [{ name: '', qty: '1', options: [] }]);
      return full;
    },
    staleTime: 0,
  });

  const choices = menu.items
    .filter((i) => i.kind !== 'DEAL' && i.isActive)
    .flatMap((i) =>
      i.variants.map((v) => ({
        id: v.id,
        label: i.variants.length > 1 ? `${i.name} — ${v.name}` : i.name,
      })),
    );

  const save = useMutation({
    mutationFn: () =>
      api(`/items/${item.id}/deal`, {
        method: 'PUT',
        body: {
          slots: (slots ?? []).map((s) => ({
            name: s.name.trim(),
            qty: Number(s.qty),
            options: s.options.map((o) => ({
              variantId: o.variantId,
              priceDeltaPaisa: parseSignedRs(o.delta) ?? 0,
              isDefault: o.isDefault,
            })),
          })),
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  const edit = (i: number, patch: Partial<SlotRow>): void =>
    setSlots((all) => (all ?? []).map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const editOption = (i: number, j: number, patch: Partial<OptionRow>): void =>
    setSlots((all) =>
      (all ?? []).map((s, k) =>
        k === i
          ? { ...s, options: s.options.map((o, m) => (m === j ? { ...o, ...patch } : o)) }
          : s,
      ),
    );

  const valid =
    !!slots?.length &&
    slots.every(
      (s) =>
        s.name.trim() &&
        Number.isInteger(Number(s.qty)) &&
        Number(s.qty) >= 1 &&
        s.options.length > 0 &&
        s.options.every((o) => o.variantId && parseSignedRs(o.delta) !== null),
    );

  return (
    <Dialog title={`${t('admin.dealEditor.title')}: ${item.name}`} onClose={onClose} wide>
      {current.isPending || !slots ? (
        <p>{t('common.loading')}</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t('admin.dealEditor.help')}</p>
          {slots.map((s, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 space-y-1">
                  <span className="text-sm text-slate-600">{t('admin.dealEditor.slotName')}</span>
                  <input
                    className="input"
                    value={s.name}
                    onChange={(e) => edit(i, { name: e.target.value })}
                  />
                </label>
                <label className="w-24 space-y-1">
                  <span className="text-sm text-slate-600">{t('admin.dealEditor.qty')}</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={s.qty}
                    onChange={(e) => edit(i, { qty: e.target.value })}
                  />
                </label>
                <button
                  className="btn-secondary text-rose-700"
                  disabled={slots.length === 1}
                  onClick={() => setSlots(slots.filter((_, k) => k !== i))}
                >
                  {t('admin.dealEditor.removeSlot')}
                </button>
              </div>
              {s.options.map((o, j) => (
                <div key={j} className="flex flex-wrap items-center gap-2">
                  <select
                    className="input flex-1"
                    aria-label={t('admin.dealEditor.option')}
                    value={o.variantId}
                    onChange={(e) => editOption(i, j, { variantId: e.target.value })}
                  >
                    <option value="">—</option>
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input w-28"
                    inputMode="decimal"
                    aria-label={t('admin.dealEditor.upcharge')}
                    title={t('admin.dealEditor.upcharge')}
                    value={o.delta}
                    onChange={(e) => editOption(i, j, { delta: e.target.value })}
                  />
                  <label className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={o.isDefault}
                      onChange={(e) => editOption(i, j, { isDefault: e.target.checked })}
                    />
                    {t('admin.dealEditor.default')}
                  </label>
                  <button
                    className="btn-secondary"
                    onClick={() => edit(i, { options: s.options.filter((_, m) => m !== j) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="btn-secondary"
                onClick={() =>
                  edit(i, {
                    options: [
                      ...s.options,
                      { variantId: '', delta: '0', isDefault: s.options.length === 0 },
                    ],
                  })
                }
              >
                + {t('admin.dealEditor.addOption')}
              </button>
              {s.options.some(
                (o) => parseSignedRs(o.delta) !== null && parseSignedRs(o.delta)! !== 0,
              ) && (
                <p className="text-xs text-slate-500">
                  {s.options
                    .filter((o) => (parseSignedRs(o.delta) ?? 0) !== 0)
                    .map(
                      (o) =>
                        `${choices.find((c) => c.id === o.variantId)?.label ?? ''}: ${ltr(formatRs(parseSignedRs(o.delta)!))}`,
                    )
                    .join(' · ')}
                </p>
              )}
            </div>
          ))}
          <button
            className="btn-secondary"
            onClick={() => setSlots([...slots, { name: '', qty: '1', options: [] }])}
          >
            + {t('admin.dealEditor.addSlot')}
          </button>
          <ErrorText error={save.error} />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              className="btn-primary"
              disabled={!valid || save.isPending}
              onClick={() => save.mutate()}
            >
              {t('admin.save')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
