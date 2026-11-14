import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Mark } from '../../components/Brand';
import { localName, setLanguage, type Lang } from '../../i18n';
import { formatRs, ltr } from '../../lib/money';
import { apiBase, withApiBase } from '../../lib/tenant';

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

class MenuUnavailable extends Error {
  constructor(readonly off: boolean) {
    super('menu unavailable');
  }
}

async function loadMenu(branch: string | null): Promise<PublicMenu> {
  const res = await fetch(
    `${apiBase()}/public/menu${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
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

  const dealNames = (sl: PublicMenu['items'][number]['dealSlots'][number]): string =>
    sl.options.map((o) => localName(lang, o.name, o.nameUr)).join(' / ');

  return (
    <div className="mc mc-table min-h-full px-3 py-5 sm:py-10" lang={lang}>
      <div className="mc-sheet mx-auto max-w-[40rem] px-6 pb-10 pt-6 sm:px-12">
        <div className="flex justify-end gap-1 text-sm" role="group" aria-label={t('pm.language')}>
          {(['en', 'ur'] as const).map((l) => (
            <button
              key={l}
              className={`min-h-9 px-2 underline-offset-4 ${lang === l ? 'font-bold text-[var(--wine)] underline' : 'text-[var(--ink-2)]'}`}
              aria-pressed={lang === l}
              onClick={() => setLanguage(l)}
            >
              {l === 'en' ? 'English' : 'اردو'}
            </button>
          ))}
        </div>

        <header className="pb-2 text-center">
          <span className="inline-block text-[var(--gold)]">
            <Mark size={38} />
          </span>
          <h1 className="mt-2 text-balance text-[2rem] font-bold leading-tight sm:text-[2.6rem]">
            {name || t('pm.title')}
          </h1>
          {lang === 'en' && r?.nameUr && (
            <p lang="ur" dir="rtl" className="mt-1 text-xl text-[var(--wine)]">
              {r.nameUr}
            </p>
          )}
          <div className="mc-orn my-4">
            <span className="mc-caps text-[var(--wine)]">{t('pm.menuWord')}</span>
          </div>
          {menu.data && (
            <p className="mc-desc">
              {ltr(
                new Date(`${menu.data.date}T00:00:00`).toLocaleDateString(
                  lang === 'ur' ? 'ur-PK' : 'en-GB',
                  { weekday: 'long', day: 'numeric', month: 'long' },
                ),
              )}
            </p>
          )}
        </header>

        {menu.isPending && (
          <p className="py-12 text-center text-[var(--ink-2)]">{t('common.loading')}</p>
        )}

        {menu.isError && (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-12 text-center">
            <h2 className="text-xl font-bold">{t('pm.unavailable')}</h2>
            <p className="mc-desc">
              {menu.error instanceof MenuUnavailable && menu.error.off
                ? t('pm.off')
                : t('pm.tryAgain')}
            </p>
            <button
              className="mc-caps border-b-2 border-[var(--gold)] pb-1 text-[var(--wine)]"
              onClick={() => void menu.refetch()}
            >
              {t('pm.retry')}
            </button>
          </div>
        )}

        {menu.data && (
          <>
            {menu.data.note && (
              <div className="my-5 border-y-[3px] border-double border-[var(--gold)] px-2 py-3 text-center">
                <p className="mc-caps text-[var(--gold)]">{t('pm.noteLabel')}</p>
                <p className="mc-desc mt-1 text-base">{menu.data.note}</p>
              </div>
            )}

            <div className="sticky top-0 z-10 border-y border-[var(--rule)] bg-[var(--paper)] py-2">
              <div className="flex items-center gap-3">
                <label className="relative min-w-0 flex-1">
                  <Icon
                    name="search"
                    size={16}
                    className="pointer-events-none absolute start-0 top-1/2 -translate-y-1/2 text-[var(--gold)]"
                  />
                  <input
                    className="min-h-10 w-full border-0 border-b border-[var(--rule)] bg-transparent ps-6 text-base outline-none placeholder:italic placeholder:text-[var(--ink-2)]/70 focus:border-[var(--wine)]"
                    placeholder={t('pm.search')}
                    aria-label={t('pm.search')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                {hasVeg && (
                  <button
                    className={`mc-caps shrink-0 border-b-2 pb-0.5 ${vegOnly ? 'border-[var(--wine)] text-[var(--wine)]' : 'border-transparent text-[var(--ink-2)]'}`}
                    aria-pressed={vegOnly}
                    onClick={() => setVegOnly(!vegOnly)}
                  >
                    {t('pm.vegOnly')}
                  </button>
                )}
              </div>
              <div
                className="-mx-1 mt-1 flex gap-5 overflow-x-auto whitespace-nowrap px-1"
                role="tablist"
                aria-label={t('pm.categories')}
              >
                {sections.map((s) => (
                  <button
                    key={s.id}
                    role="tab"
                    aria-selected={active === s.id}
                    className={`mc-caps min-h-10 shrink-0 border-b-2 ${active === s.id ? 'border-[var(--gold)] text-[var(--wine)]' : 'border-transparent text-[var(--ink-2)]'}`}
                    onClick={() => goTo(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            <main>
              {sections.length === 0 && (
                <p className="mc-desc py-12 text-center">
                  {search ? t('pm.noMatch') : t('pm.empty')}
                </p>
              )}
              {sections.map((s) => (
                <section key={s.id} id={`pm-${s.id}`} className="scroll-mt-28 pt-9">
                  <div className="mc-orn mb-5">
                    <h2 className="mc-caps !text-[0.95rem] font-bold text-[var(--wine)]">
                      {s.name}
                    </h2>
                  </div>
                  <ul className="space-y-6">
                    {s.items.map((i) => {
                      const d = desc(i);
                      return (
                        <li key={i.id}>
                          <div className="flex items-start gap-4">
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex items-baseline gap-2">
                                <span
                                  className={`mc-name ${i.available ? '' : 'line-through decoration-1'}`}
                                >
                                  {localName(lang, i.name, i.nameUr)}
                                </span>
                                {i.isDeal && (
                                  <span className="mc-caps text-[var(--gold)]">{t('pm.deal')}</span>
                                )}
                                {i.available && i.variants.length === 1 && (
                                  <>
                                    <span className="mc-leader" aria-hidden />
                                    <span className="mc-price">
                                      {price(i.variants[0]!.pricePaisa)}
                                    </span>
                                  </>
                                )}
                                {!i.available && (
                                  <>
                                    <span className="mc-leader" aria-hidden />
                                    <span className="mc-caps whitespace-nowrap text-[var(--wine)]">
                                      {t('pm.soldOut')}
                                    </span>
                                  </>
                                )}
                              </div>
                              {i.available &&
                                i.variants.length > 1 &&
                                i.variants.map((v) => (
                                  <div
                                    key={v.name}
                                    className="flex items-baseline gap-2 ps-3 text-[0.95rem]"
                                  >
                                    <span className="italic text-[var(--ink-2)]">
                                      {localName(lang, v.name, v.nameUr)}
                                    </span>
                                    <span className="mc-leader" aria-hidden />
                                    <span className="mc-price !text-[0.98rem]">
                                      {price(v.pricePaisa)}
                                    </span>
                                  </div>
                                ))}
                              {d && <p className="mc-desc">{d}</p>}
                              {i.isDeal && i.dealSlots.length > 0 && (
                                <ul className="mc-desc space-y-0.5 border-s-2 border-[var(--rule)] ps-3">
                                  {i.dealSlots.map((sl) => (
                                    <li key={sl.name}>
                                      <span className="font-medium not-italic text-[var(--ink)]">
                                        {ltr(`${sl.qty} ×`)} {sl.name}
                                      </span>
                                      {sl.options.length > 0 && <>: {dealNames(sl)}</>}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {i.tags.length > 0 && (
                                <div className="flex flex-wrap pt-0.5">
                                  {i.tags.map((tg) => (
                                    <span
                                      key={tg}
                                      className={`mc-caps mc-tag ${tg === 'CHEF' || tg === 'NEW' ? 'text-[var(--wine)]' : 'text-[var(--ink-2)]'}`}
                                    >
                                      {t(`guest.tag.${tg}`)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {i.allergens.length > 0 && (
                                <p className="text-[0.8rem] italic text-[var(--ink-2)]">
                                  * {t('pm.contains')}{' '}
                                  {i.allergens.map((a) => t(`guest.allergen.${a}`)).join(', ')}
                                </p>
                              )}
                            </div>
                            {i.imageUrl && (
                              <img
                                src={withApiBase(i.imageUrl)}
                                alt={localName(lang, i.name, i.nameUr)}
                                loading="lazy"
                                className="mc-photo size-[5.5rem] shrink-0 object-cover"
                              />
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </main>

            <footer className="mt-12 space-y-2 text-center">
              <div className="mc-orn">
                <Mark size={20} />
              </div>
              <p className="mc-desc pt-2">{t('pm.pricesNote')}</p>
              {menu.data.serviceChargeBps > 0 && (
                <p className="mc-desc">
                  {t('pm.service', {
                    pct: ltr(`${(menu.data.serviceChargeBps / 100).toString()}%`),
                  })}
                </p>
              )}
              <p className="mc-desc">{t('pm.askStaff')}</p>
              {(r?.address || r?.phone) && (
                <p className="mc-caps pt-3 text-[var(--wine)]">
                  {r.address}
                  {r.address && r.phone ? ' · ' : ''}
                  {r.phone && <span dir="ltr">{r.phone}</span>}
                </p>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
