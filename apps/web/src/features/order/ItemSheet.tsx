import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { localName } from '../../i18n';
import { formatRs, ltr } from '../../lib/money';
import type { MenuItem } from '../../lib/types';

/** Keys of the one-tap notes (wording in i18n `order.qn.*`). */
export const QUICK_NOTES = [
  'lessSpicy',
  'extraSpicy',
  'noOnion',
  'wellDone',
  'serveHot',
  'pack',
] as const;

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

  const choice = (on: boolean): string =>
    `btn border ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-400 bg-white text-slate-900 hover:bg-slate-100'}`;
  const stepper = (
    value: number,
    onMinus: () => void,
    onPlus: () => void,
    plusDisabled = false,
  ) => (
    <div className="inline-flex items-center rounded-lg border border-slate-400">
      <button className="btn-quiet min-w-touch px-0" onClick={onMinus} aria-label="minus">
        <Icon name="minus" size={18} />
      </button>
      <span className="money w-8 text-center font-semibold">{value}</span>
      <button
        className="btn-quiet min-w-touch px-0"
        disabled={plusDisabled}
        onClick={onPlus}
        aria-label="plus"
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  );

  return (
    <Modal
      title={localName(lang, item.name, item.nameUr)}
      onClose={onClose}
      footer={
        <button
          className="btn-primary btn-lg w-full"
          disabled={busy || !groupsOk || !weightOk || !dealOk}
          onClick={submit}
        >
          {t('order.add')} ·{' '}
          {ltr(item.kind === 'WEIGHT' ? formatRs(price) + '/kg' : formatRs(price * qty))}
        </button>
      }
    >
      <div className="space-y-5">
        {item.variants.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="label">{t('order.size')}</legend>
            <div className="flex flex-wrap gap-2">
              {item.variants.map((v) => (
                <button
                  key={v.id}
                  aria-pressed={v.id === variantId}
                  onClick={() => setVariantId(v.id)}
                  className={choice(v.id === variantId)}
                >
                  {localName(lang, v.name, v.nameUr)} · {ltr(formatRs(v.pricePaisa))}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {item.modifierGroups.map((g) => (
          <fieldset key={g.id} className="space-y-2">
            <legend className="label">
              {localName(lang, g.name, g.nameUr)}{' '}
              {g.minSelect > 0 ? (
                <span className="chip-warn">{t('order.required')}</span>
              ) : (
                <span className="text-slate-500">({t('order.optional')})</span>
              )}
            </legend>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={!!mods[g.id]?.includes(m.id)}
                  onClick={() => toggle(g.id, m.id, g.maxSelect)}
                  className={choice(!!mods[g.id]?.includes(m.id))}
                >
                  {localName(lang, m.name, m.nameUr)}
                  {m.priceDeltaPaisa !== 0 && ` ${ltr(`+${formatRs(m.priceDeltaPaisa)}`)}`}
                </button>
              ))}
            </div>
          </fieldset>
        ))}

        {item.deal?.slots.map((slot) => (
          <fieldset key={slot.id} className="space-y-2">
            <legend className="label">
              {slot.name}{' '}
              <span className="text-slate-600">· {t('order.pickN', { count: slot.qty })}</span>
            </legend>
            {slot.options.map((o) => (
              <div key={o.id} className="flex items-center gap-2">
                <span className="me-auto">
                  {localName(lang, o.itemName, o.itemNameUr)}{' '}
                  {o.variantName !== 'Regular' && `(${o.variantName})`}
                  {o.priceDeltaPaisa !== 0 && ` ${ltr(`+${formatRs(o.priceDeltaPaisa)}`)}`}
                  {!o.available && <span className="chip-bad ms-2">{t('order.soldOut')}</span>}
                </span>
                {stepper(
                  counts[o.id] ?? 0,
                  () => bump(slot.id, o.id, -1, slot.qty),
                  () => bump(slot.id, o.id, 1, slot.qty),
                  !o.available,
                )}
              </div>
            ))}
          </fieldset>
        ))}

        {item.kind === 'WEIGHT' ? (
          <div className="space-y-2">
            <label className="label" htmlFor="weight-g">
              {t('order.weight')}
            </label>
            <div className="flex flex-wrap gap-2">
              {[250, 500, 750, 1000, 1500].map((g) => (
                <button
                  key={g}
                  aria-pressed={weight === String(g)}
                  className={choice(weight === String(g))}
                  onClick={() => setWeight(String(g))}
                >
                  {ltr(String(g))}
                </button>
              ))}
            </div>
            <input
              id="weight-g"
              className="input"
              inputMode="numeric"
              value={weight}
              onChange={(e) => setWeight(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="label me-auto">{t('order.quantity')}</span>
            {stepper(
              qty,
              () => setQty(Math.max(1, qty - 1)),
              () => setQty(Math.min(99, qty + 1)),
            )}
          </div>
        )}

        <div className="space-y-2">
          <input
            className="input"
            placeholder={t('order.note')}
            aria-label={t('order.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {/* the notes cooks hear all day: one tap instead of typing (tap again to take it off) */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('order.quickNotes')}>
            {QUICK_NOTES.map((k) => {
              const label = t(`order.qn.${k}`);
              const on = note.split(', ').includes(label);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  className={`min-h-touch rounded-full border px-3 text-sm font-medium ${on ? 'border-amber-500 bg-amber-100 text-amber-950' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'}`}
                  onClick={() =>
                    setNote(
                      on
                        ? note
                            .split(', ')
                            .filter((x) => x !== label)
                            .join(', ')
                        : note.trim()
                          ? `${note.trim()}, ${label}`
                          : label,
                    )
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
