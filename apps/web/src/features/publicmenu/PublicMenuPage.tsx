import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Mark } from '../../components/Brand';
import { localName, setLanguage, type Lang } from '../../i18n';
import { formatRs, ltr } from '../../lib/money';

/** Shape of GET /public/menu (apps/api/src/modules/menu/public.routes.ts). */
interface PublicMenu {
  restaurant: { name: string; nameUr: string | null; address: string | null; phone: string | null };
  date: string;
  note: string | null;
  serviceChargeBps: number;
  categories: {
    id: string;
    parentId: string | null;
    name: string;
    nameUr: string | null;
    sort: number;
  }[];
  items: {
    id: string;
    name: string;
    nameUr: string | null;
    isDeal: boolean;
    categoryId: string | null;
    available: boolean;
    description: string | null;
    descriptionUr: string | null;
    tags: string[];
    allergens: string[];
    imageUrl: string | null;
    variants: { name: string; nameUr: string | null; pricePaisa: number }[];
    dealSlots: {
      name: string;
      qty: number;
      options: { name: string; nameUr: string | null; variant: string; available: boolean }[];
    }[];
  }[];
}

const TAG_STYLE: Record<string, string> = {
  HALAL: 'chip-ok',
  VEGETARIAN: 'chip-ok',
  SPICY: 'chip-bad',
  CHEF: 'chip-warn',
  NEW: 'chip-info',
};

class MenuUnavailable extends Error {
  constructor(readonly off: boolean) {
    super('menu unavailable');
  }
}

async function loadMenu(branch: string | null): Promise<PublicMenu> {
  const res = await fetch(
    `/api/v1/public/menu${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
  );
  if (!res.ok) throw new MenuUnavailable(res.status === 404);
  return (await res.json()) as PublicMenu;
}

/** First visit on a phone set to Urdu opens in Urdu; after that the guest's own choice wins. */
function useGuestLanguage(): Lang {
  const { i18n } = useTranslation();
  useEffect(() => {
    let chosen: string | null = null;
    try {
      chosen = localStorage.getItem('erp-lang');
    } catch {
      /* private mode */
    }
    if (!chosen && navigator.language?.toLowerCase().startsWith('ur')) setLanguage('ur');
    else if (chosen) setLanguage(chosen === 'ur' ? 'ur' : 'en');
    else setLanguage('en');
  }, []);
  return i18n.language === 'ur' ? 'ur' : 'en';
}

/**
 * What a guest sees after scanning the QR code on the table: today's menu, readable on a phone, in
 * English or Urdu. No sign-in, no ordering: it only reads. Prices are the dine-in prices for today.
 */
export function PublicMenuPage() {
  const { t } = useTranslation();
  const lang = useGuestLanguage();
  const [params] = useSearchParams();
  const branch = params.get('b');
  const menu = useQuery({
    queryKey: ['public-menu', branch],
    queryFn: () => loadMenu(branch),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const [search, setSearch] = useState('');
  const [vegOnly, setVegOnly] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const chips = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = menu.data
      ? localName(lang, menu.data.restaurant.name, menu.data.restaurant.nameUr)
      : t('pm.title');
  }, [menu.data, lang, t]);

  const sections = useMemo(() => {
    const d = menu.data;
    if (!d) return [];
    const q = search.trim().toLowerCase();
    const match = (i: PublicMenu['items'][number]): boolean =>
      (!vegOnly || i.tags.includes('VEGETARIAN')) &&
      (!q || `${i.name} ${i.nameUr ?? ''} ${i.description ?? ''}`.toLowerCase().includes(q));
    const cats = [...d.categories].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const out = cats
      .map((c) => ({
        id: c.id,
        name: localName(lang, c.name, c.nameUr),
        items: d.items.filter((i) => i.categoryId === c.id && match(i)),
      }))
      .filter((s) => s.items.length > 0);
    const loose = d.items.filter((i) => !i.categoryId && match(i));
    if (loose.length) out.push({ id: 'other', name: t('pm.other'), items: loose });
    return out;
  }, [menu.data, search, vegOnly, lang, t]);

  // highlight the section being read
  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(`pm-${s.id}`))
      .filter(Boolean) as HTMLElement[];
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (seen) setActive(seen.target.id.replace('pm-', ''));
      },
      { rootMargin: '-120px 0px -65% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [sections]);

  const goTo = (id: string): void => {
    document.getElementById(`pm-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const r = menu.data?.restaurant;
  const name = r ? localName(lang, r.name, r.nameUr) : '';
  const price = (p: number): string => ltr(formatRs(p));
  const desc = (i: PublicMenu['items'][number]): string | null =>
    (lang === 'ur' && i.descriptionUr ? i.descriptionUr : i.description) ?? null;
  const hasVeg = menu.data?.items.some((i) => i.tags.includes('VEGETARIAN')) ?? false;

  return (
    <div className="min-h-full bg-slate-50 text-slate-900">
      <header className="bg-slate-900 text-slate-50">
        <div className="mx-auto flex max-w-2xl items-start gap-3 px-4 pb-5 pt-5">
          <span className="mt-1 text-amber-400">
            <Mark size={36} />
          </span>
          <div className="me-auto min-w-0">
            <p className="text-xs font-medium uppercase tracking-widest text-amber-300">
              {t('pm.todaysMenu')}
            </p>
            <h1 className="text-balance text-2xl font-semibold leading-tight">
              {name || t('pm.title')}
            </h1>
            {menu.data && (
              <p className="mt-1 text-sm text-slate-300">
                {ltr(
                  new Date(`${menu.data.date}T00:00:00`).toLocaleDateString(
                    lang === 'ur' ? 'ur-PK' : 'en-GB',
                    { weekday: 'long', day: 'numeric', month: 'long' },
                  ),
                )}
              </p>
            )}
          </div>
          <div
            className="seg shrink-0 border-slate-600 bg-slate-800"
            role="group"
            aria-label={t('pm.language')}
          >
            {(['en', 'ur'] as const).map((l) => (
              <button
                key={l}
                className="seg-item !min-h-9 !min-w-0 !px-3 !text-slate-200"
                aria-pressed={lang === l}
                onClick={() => setLanguage(l)}
              >
                {l === 'en' ? 'EN' : 'اردو'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {menu.isPending && (
        <p className="mx-auto max-w-2xl px-4 py-10 text-center text-slate-600">
          {t('common.loading')}
        </p>
      )}

      {menu.isError && (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-slate-200 text-slate-600">
            <Icon name="book" size={28} />
          </span>
          <h2 className="text-lg font-semibold">{t('pm.unavailable')}</h2>
          <p className="text-slate-600">
            {menu.error instanceof MenuUnavailable && menu.error.off
              ? t('pm.off')
              : t('pm.tryAgain')}
          </p>
          <button className="btn-secondary" onClick={() => void menu.refetch()}>
            {t('pm.retry')}
          </button>
        </div>
      )}

      {menu.data && (
        <>
          <div className="sticky top-0 z-10 border-b border-slate-300 bg-slate-50/95 backdrop-blur">
            <div className="mx-auto max-w-2xl space-y-2 px-4 py-2">
              <div className="relative">
                <Icon
                  name="search"
                  size={18}
                  className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  className="input ps-10"
                  placeholder={t('pm.search')}
                  aria-label={t('pm.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {hasVeg && (
                <button
                  className="seg-item !min-h-9 border border-slate-400 bg-white"
                  aria-pressed={vegOnly}
                  onClick={() => setVegOnly(!vegOnly)}
                >
                  {t('pm.vegOnly')}
                </button>
              )}
              <div
                ref={chips}
                className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
                role="tablist"
                aria-label={t('pm.categories')}
              >
                {sections.map((s) => (
                  <button
                    key={s.id}
                    role="tab"
                    aria-selected={active === s.id}
                    className="seg-item shrink-0 border border-slate-400 bg-white"
                    onClick={() => goTo(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">
            {menu.data.note && (
              <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <Icon name="info" size={18} className="mt-0.5 shrink-0" />
                {menu.data.note}
              </p>
            )}
            {sections.length === 0 && (
              <p className="py-10 text-center text-slate-600">
                {search ? t('pm.noMatch') : t('pm.empty')}
              </p>
            )}
            {sections.map((s) => (
              <section key={s.id} id={`pm-${s.id}`} className="scroll-mt-32 pb-6">
                <h2 className="mb-1 border-b-2 border-slate-900 pb-1 text-lg font-semibold">
                  {s.name}
                </h2>
                <ul className="divide-y divide-slate-200">
                  {s.items.map((i) => (
                    <li key={i.id} className={`py-3 ${i.available ? '' : 'opacity-60'}`}>
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-3">
                            <span className="me-auto min-w-0 font-medium">
                              {localName(lang, i.name, i.nameUr)}
                              {i.isDeal && (
                                <span className="chip-info ms-2 align-middle">{t('pm.deal')}</span>
                              )}
                              {!i.available && (
                                <span className="chip-mute ms-2 align-middle">
                                  {t('pm.soldOut')}
                                </span>
                              )}
                            </span>
                            {i.variants.length === 1 && (
                              <span
                                className={`money shrink-0 font-semibold ${i.available ? '' : 'line-through'}`}
                              >
                                {price(i.variants[0]!.pricePaisa)}
                              </span>
                            )}
                          </div>
                          {i.variants.length > 1 && (
                            <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
                              {i.variants.map((v) => (
                                <li key={v.name} className="flex justify-between gap-3">
                                  <span>{localName(lang, v.name, v.nameUr)}</span>
                                  <span
                                    className={`money ${i.available ? 'font-semibold' : 'line-through'}`}
                                  >
                                    {price(v.pricePaisa)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {i.isDeal && i.dealSlots.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-sm text-slate-600">
                              {i.dealSlots.map((sl) => (
                                <li key={sl.name}>
                                  <span className="font-medium text-slate-700">
                                    {ltr(`${sl.qty} ×`)} {sl.name}
                                  </span>
                                  {sl.options.length > 0 && (
                                    <>
                                      :{' '}
                                      {sl.options
                                        .map((o) => localName(lang, o.name, o.nameUr))
                                        .join(' / ')}
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          {(i.tags.length > 0 || i.allergens.length > 0 || desc(i)) && (
                            <div className="mt-1.5 space-y-1.5">
                              {desc(i) && <p className="text-sm text-slate-600">{desc(i)}</p>}
                              {i.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                  {i.tags.map((tg) => (
                                    <span key={tg} className={TAG_STYLE[tg] ?? 'chip-mute'}>
                                      {t(`guest.tag.${tg}`)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {i.allergens.length > 0 && (
                                <p className="flex items-start gap-1.5 text-xs text-amber-900">
                                  <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                                  <span>
                                    {t('pm.contains')}{' '}
                                    {i.allergens.map((a) => t(`guest.allergen.${a}`)).join(', ')}
                                  </span>
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                        {i.imageUrl && (
                          <img
                            src={i.imageUrl}
                            alt={localName(lang, i.name, i.nameUr)}
                            loading="lazy"
                            className="size-24 shrink-0 rounded-lg border border-slate-300 bg-slate-200 object-cover"
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <footer className="space-y-1 border-t border-slate-300 pt-4 text-sm text-slate-600">
              <p>{t('pm.pricesNote')}</p>
              {menu.data.serviceChargeBps > 0 && (
                <p>
                  {t('pm.service', {
                    pct: ltr(`${(menu.data.serviceChargeBps / 100).toString()}%`),
                  })}
                </p>
              )}
              {(r?.address || r?.phone) && (
                <p className="pt-2 text-slate-700">
                  {r.address}
                  {r.address && r.phone ? ' · ' : ''}
                  {r.phone && <span dir="ltr">{r.phone}</span>}
                </p>
              )}
              <p className="pt-2">{t('pm.askStaff')}</p>
            </footer>
          </main>
        </>
      )}
    </div>
  );
}
