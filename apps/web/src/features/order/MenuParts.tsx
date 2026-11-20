import { Icon } from '../../components/Icon';
import { ItemPhoto } from '../../components/ItemPhoto';
import { formatRs, ltr } from '../../lib/money';
import { localName } from '../../i18n';
import type { MenuItem } from '../../lib/types';

/**
 * The menu the counter person taps: a rail of big category tiles and a grid of big dish cards with photos, the way
 * a burger-chain kiosk looks. Plain presentation: the order screen owns the state and the actions.
 */

/** One accent per main category, in menu order (the name is always shown too: colour is never the only signal). */
export const HUES = [
  {
    edge: 'border-s-emerald-500',
    dot: 'bg-emerald-500',
    soft: 'bg-emerald-50',
    solid: 'bg-emerald-600',
    ink: 'text-emerald-800',
  },
  {
    edge: 'border-s-orange-500',
    dot: 'bg-orange-500',
    soft: 'bg-orange-50',
    solid: 'bg-orange-500',
    ink: 'text-orange-700',
  },
  {
    edge: 'border-s-sky-500',
    dot: 'bg-sky-500',
    soft: 'bg-sky-50',
    solid: 'bg-sky-600',
    ink: 'text-sky-800',
  },
  {
    edge: 'border-s-violet-500',
    dot: 'bg-violet-500',
    soft: 'bg-violet-50',
    solid: 'bg-violet-500',
    ink: 'text-violet-700',
  },
  {
    edge: 'border-s-rose-500',
    dot: 'bg-rose-500',
    soft: 'bg-rose-50',
    solid: 'bg-rose-600',
    ink: 'text-rose-800',
  },
  {
    edge: 'border-s-teal-500',
    dot: 'bg-teal-500',
    soft: 'bg-teal-50',
    solid: 'bg-teal-500',
    ink: 'text-teal-700',
  },
  {
    edge: 'border-s-pink-500',
    dot: 'bg-pink-500',
    soft: 'bg-pink-50',
    solid: 'bg-pink-500',
    ink: 'text-pink-700',
  },
  {
    edge: 'border-s-amber-500',
    dot: 'bg-amber-500',
    soft: 'bg-amber-50',
    solid: 'bg-amber-500',
    ink: 'text-amber-900',
  },
] as const;
export type Hue = (typeof HUES)[number];
export const hueAt = (n: number): Hue => HUES[n % HUES.length]!;

export interface CategoryTile {
  id: string;
  name: string;
  count: number;
  hue: Hue;
  /** a dish photo of this category, shown as its picture (no extra upload needed) */
  cover: { itemId: string; ver: number } | null;
}

/** A picture, or a coloured tile with the first letter when there is none. */
function Thumb({
  cover,
  label,
  hue,
  className,
}: {
  cover: { itemId: string; ver: number } | null;
  label: string;
  hue: Hue;
  className: string;
}) {
  if (cover) return <ItemPhoto itemId={cover.itemId} version={cover.ver} className={className} />;
  return (
    <span
      aria-hidden="true"
      className={`flex items-center justify-center font-bold text-white ${hue.solid} ${className}`}
    >
      {[...label.trim()][0]?.toUpperCase() ?? '•'}
    </span>
  );
}

const SPECIAL = { all: '__all', popular: '__popular' } as const;

/**
 * Category tiles. A vertical rail on tablets and desktops, a row of compact tiles across the top of a phone.
 * `active` is the id of the main category (or null = everything, or the popular key).
 */
export function CategoryTabs({
  tiles,
  active,
  popular,
  labels,
  onSelect,
  allCount,
}: {
  tiles: CategoryTile[];
  active: string | null;
  popular: { count: number; key: string } | null;
  labels: { all: string; popular: string; aria: string };
  onSelect: (id: string | null) => void;
  allCount: number;
}) {
  const base =
    'group relative flex shrink-0 items-center gap-2.5 rounded-xl text-start transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 md:w-full';
  const size = 'min-h-12 px-2 py-1.5 md:min-h-16 md:px-2.5 md:py-2';
  const tab = (selected: boolean, extra = ''): string =>
    `${base} ${size} ${selected ? 'bg-white shadow-sm ring-1 ring-slate-300' : 'hover:bg-white/70'} ${extra}`;
  return (
    <div
      role="tablist"
      aria-label={labels.aria}
      aria-orientation="vertical"
      className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2 md:w-40 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:border-e md:border-slate-200 md:bg-slate-100/60 md:p-2 lg:w-48"
    >
      <button
        role="tab"
        aria-selected={active === null}
        aria-label={labels.all}
        className={tab(active === null)}
        onClick={() => onSelect(null)}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-white md:size-11 md:rounded-xl">
          <Icon name="book" size={18} />
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold md:text-base">{labels.all}</span>
          <span className="hidden text-xs text-slate-500 md:block">{allCount}</span>
        </span>
      </button>
      {popular && popular.count >= 3 && (
        <button
          role="tab"
          aria-selected={active === popular.key}
          aria-label={labels.popular}
          className={tab(active === popular.key)}
          onClick={() => onSelect(popular.key)}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-400 text-slate-900 md:size-11 md:rounded-xl">
            <Icon name="flame" size={18} />
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold md:text-base">
              {labels.popular}
            </span>
            <span className="hidden text-xs text-slate-500 md:block">{popular.count}</span>
          </span>
        </button>
      )}
      {tiles.map((c) => {
        const selected = active === c.id;
        return (
          <button
            key={c.id}
            role="tab"
            aria-selected={selected}
            aria-label={c.name}
            className={`${tab(selected)} ${selected ? `border-s-4 ${c.hue.edge}` : 'border-s-4 border-s-transparent'}`}
            onClick={() => onSelect(c.id)}
          >
            <Thumb
              cover={c.cover}
              label={c.name}
              hue={c.hue}
              className="size-8 shrink-0 rounded-lg text-base md:size-11 md:rounded-xl md:text-xl"
            />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold md:line-clamp-2 md:whitespace-normal md:text-base">
                {c.name}
              </span>
              <span className="hidden text-xs text-slate-500 md:block">{c.count}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const SPECIAL_KEYS = SPECIAL;

/** The price line of a card: "from" for sizes, per kg for weighed dishes, "Sold out" when switched off. */
const priceOf = (item: MenuItem): string =>
  item.variants.length > 1
    ? `${formatRs(Math.min(...item.variants.map((v) => v.pricePaisa)))}+`
    : formatRs(item.variants[0]!.pricePaisa) + (item.kind === 'WEIGHT' ? '/kg' : '');

export interface CartLine {
  qty: number;
}

/**
 * A dish card: the photo on top (or a plain coloured band when the restaurant has no photos at all), the name,
 * the price. A plain dish already in the cart shows a − n + stepper on the card itself.
 */
export function ItemCard({
  item,
  lang,
  hue,
  showPhoto,
  editable,
  inCart,
  plainLine,
  busy,
  labels,
  onPick,
  onMinus,
  onPlus,
}: {
  item: MenuItem;
  lang: string;
  hue: Hue;
  showPhoto: boolean;
  editable: boolean;
  inCart: number;
  plainLine: CartLine | undefined;
  busy: boolean;
  labels: { soldOut: string; removeOne: string; addOne: string };
  onPick: () => void;
  onMinus: () => void;
  onPlus: () => void;
}) {
  const name = localName(lang, item.name, item.nameUr);
  const stepper = !!plainLine && editable;
  return (
    <div className="relative flex">
      <button
        disabled={!item.available || !editable}
        onClick={onPick}
        className={`card relative flex w-full flex-col overflow-hidden text-start transition hover:shadow-md active:scale-[0.99] disabled:opacity-40 ${
          showPhoto ? '' : `border-s-4 ${hue.edge}`
        } ${stepper ? 'pb-14' : ''}`}
      >
        {showPhoto &&
          (item.imageVer ? (
            <ItemPhoto
              itemId={item.id}
              version={item.imageVer}
              className="aspect-[4/3] w-full shrink-0"
            />
          ) : (
            <span
              aria-hidden="true"
              className={`flex aspect-[4/3] w-full shrink-0 items-center justify-center text-4xl font-bold ${hue.soft} ${hue.ink}`}
            >
              {[...name.trim()][0]?.toUpperCase() ?? '•'}
            </span>
          ))}
        <span className="flex min-h-[4.25rem] flex-1 flex-col justify-between gap-1 p-3">
          <span className="line-clamp-2 text-base font-semibold leading-snug">{name}</span>
          <span className="money text-base font-bold text-slate-800">
            {item.available ? ltr(priceOf(item)) : labels.soldOut}
          </span>
        </span>
        {inCart > 0 && !plainLine && (
          <span className="absolute end-2 top-2 flex size-7 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white shadow">
            {inCart}
          </span>
        )}
      </button>
      {stepper && (
        <div className="absolute bottom-2 end-2 inline-flex items-center rounded-xl border border-emerald-600 bg-white shadow-sm">
          <button
            className="btn-quiet min-w-touch px-0 text-emerald-800"
            aria-label={`${labels.removeOne} ${item.name}`}
            disabled={busy}
            onClick={onMinus}
          >
            <Icon name="minus" size={18} />
          </button>
          <span className="money w-7 text-center font-bold text-emerald-900">{plainLine!.qty}</span>
          <button
            className="btn-quiet min-w-touch px-0 text-emerald-800"
            aria-label={`${labels.addOne} ${item.name}`}
            disabled={busy}
            onClick={onPlus}
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
