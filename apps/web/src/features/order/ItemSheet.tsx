import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localName } from '../../i18n';
import { formatRs } from '../../lib/money';
import type { MenuItem } from '../../lib/types';

export interface AddBody {
  itemId: string;
  variantId: string;
  qty?: number;
  weightG?: number;
  modifierIds?: string[];
  dealPicks?: { slotId: string; optionId: string; count: number }[];
  note?: string;
}

/**
 * Bottom sheet for items that need a choice: variant (Half/Full), modifiers, weight, or deal
 * options. Prices shown are the server's list prices for orientation only — the server prices
 * the line when it is added (rule 5), so nothing here is authoritative.
 */
export function ItemSheet({
  item,
  onClose,
  onAdd,
  busy,
  error,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (body: AddBody) => void;
  busy: boolean;
  error: string | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [variantId, setVariantId] = useState(
    item.variants.find((v) => v.isDefault)?.id ?? item.variants[0]!.id,
  );
  const [qty, setQty] = useState(1);
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [mods, setMods] = useState<Record<string, string[]>>({});
  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const slot of item.deal?.slots ?? []) {
      const chosen =
        slot.options.find((o) => o.isDefault) ??
        (slot.options.length === 1 ? slot.options[0] : undefined);
      if (chosen) init[chosen.id] = slot.qty;
    }
    return init;
  });

  const toggle = (groupId: string, modId: string, max: number): void => {
    const cur = mods[groupId] ?? [];
    const next = cur.includes(modId)
      ? cur.filter((x) => x !== modId)
      : max === 1
        ? [modId]
        : [...cur, modId].slice(-max);
    setMods({ ...mods, [groupId]: next });
  };
  const bump = (slotId: string, optionId: string, delta: number, slotQty: number): void => {
    const slot = item.deal!.slots.find((s) => s.id === slotId)!;
    const used = slot.options.reduce((n, o) => n + (counts[o.id] ?? 0), 0);
    const mine = counts[optionId] ?? 0;
    if (delta > 0 && used >= slotQty) return;
    if (delta < 0 && mine === 0) return;
    setCounts({ ...counts, [optionId]: mine + delta });
  };

  const groupsOk = item.modifierGroups.every((g) => (mods[g.id]?.length ?? 0) >= g.minSelect);
  const weightOk = item.kind !== 'WEIGHT' || Number(weight) > 0;
  const dealOk = (item.deal?.slots ?? []).every(
    (s) => s.options.reduce((n, o) => n + (counts[o.id] ?? 0), 0) === s.qty,
  );
  const price = item.variants.find((v) => v.id === variantId)?.pricePaisa ?? 0;

  function submit(): void {
    onAdd({
      itemId: item.id,
      variantId,
      ...(item.kind === 'WEIGHT' ? { weightG: Number(weight) } : { qty }),
      modifierIds: Object.values(mods).flat(),
      ...(item.deal
        ? {
            dealPicks: item.deal.slots.flatMap((s) =>
              s.options
                .filter((o) => (counts[o.id] ?? 0) > 0)
                .map((o) => ({ slotId: s.id, optionId: o.id, count: counts[o.id]! })),
            ),
          }
        : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="card max-h-[92vh] w-full max-w-lg space-y-4 overflow-auto rounded-b-none p-5 sm:rounded-b-xl">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-xl font-bold">{localName(lang, item.name, item.nameUr)}</h2>
          <button className="btn-secondary" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        {item.variants.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {item.variants.map((v) => (
              <button
                key={v.id}
                onClick={() => setVariantId(v.id)}
                className={v.id === variantId ? 'btn-primary' : 'btn-secondary'}
              >
                {localName(lang, v.name, v.nameUr)} · {formatRs(v.pricePaisa)}
              </button>
            ))}
          </div>
        )}

        {item.modifierGroups.map((g) => (
          <fieldset key={g.id} className="space-y-2">
            <legend className="font-semibold">
              {localName(lang, g.name, g.nameUr)}{' '}
              {g.minSelect > 0 && <span className="text-rose-600">*</span>}
            </legend>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => (
                <button
                  key={m.id}
                  onClick={() => toggle(g.id, m.id, g.maxSelect)}
                  className={mods[g.id]?.includes(m.id) ? 'btn-primary' : 'btn-secondary'}
                >
                  {localName(lang, m.name, m.nameUr)}
                  {m.priceDeltaPaisa !== 0 && ` (+${formatRs(m.priceDeltaPaisa)})`}
                </button>
              ))}
            </div>
          </fieldset>
        ))}

        {item.deal?.slots.map((slot) => (
          <fieldset key={slot.id} className="space-y-2">
            <legend className="font-semibold">
              {slot.name} <span className="text-slate-500">× {slot.qty}</span>
            </legend>
            {slot.options.map((o) => (
              <div key={o.id} className="flex items-center gap-2">
                <span className="me-auto">
                  {localName(lang, o.itemName, o.itemNameUr)}{' '}
                  {o.variantName !== 'Regular' && `(${o.variantName})`}
                  {o.priceDeltaPaisa !== 0 && ` +${formatRs(o.priceDeltaPaisa)}`}
                  {!o.available && <span className="ms-2 text-rose-600">{t('order.soldOut')}</span>}
                </span>
                <button
                  className="btn-secondary"
                  onClick={() => bump(slot.id, o.id, -1, slot.qty)}
                  aria-label="minus"
                >
                  −
                </button>
                <span className="w-6 text-center">{counts[o.id] ?? 0}</span>
                <button
                  className="btn-secondary"
                  disabled={!o.available}
                  onClick={() => bump(slot.id, o.id, 1, slot.qty)}
                  aria-label="plus"
                >
                  +
                </button>
              </div>
            ))}
          </fieldset>
        ))}

        {item.kind === 'WEIGHT' ? (
          <label className="block space-y-2">
            <span className="font-semibold">{t('order.weight')}</span>
            <div className="flex flex-wrap gap-2">
              {[250, 500, 750, 1000, 1500].map((g) => (
                <button
                  key={g}
                  className={weight === String(g) ? 'btn-primary' : 'btn-secondary'}
                  onClick={() => setWeight(String(g))}
                >
                  {g}
                </button>
              ))}
            </div>
            <input
              className="input"
              inputMode="numeric"
              value={weight}
              onChange={(e) => setWeight(e.target.value.replace(/\D/g, ''))}
            />
          </label>
        ) : (
          <div className="flex items-center gap-3">
            <span className="me-auto font-semibold">{t('order.quantity')}</span>
            <button
              className="btn-secondary"
              onClick={() => setQty(Math.max(1, qty - 1))}
              aria-label="minus"
            >
              −
            </button>
            <span className="w-8 text-center text-xl">{qty}</span>
            <button
              className="btn-secondary"
              onClick={() => setQty(Math.min(99, qty + 1))}
              aria-label="plus"
            >
              +
            </button>
          </div>
        )}

        <input
          className="input"
          placeholder={t('order.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        )}

        <button
          className="btn-primary h-14 w-full text-lg"
          disabled={busy || !groupsOk || !weightOk || !dealOk}
          onClick={submit}
        >
          {t('order.add')} ·{' '}
          {item.kind === 'WEIGHT' ? formatRs(price) + '/kg' : formatRs(price * qty)}
        </button>
      </div>
    </div>
  );
}
