import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader } from '../../components/Loader';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { CategoryTabs, ItemCard, hueAt, type CategoryTile } from './MenuParts';
import { CustomerDialog } from './CustomerDialog';
import { KotSlip, SlipModal, TokenSlip, type KotTicketDoc, type TokenSlipDoc } from './Slips';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { localName } from '../../i18n';
import { matchesQuery } from '../../lib/search';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { topOf as topOfCat } from '../../lib/categories';
import { useOutbox } from '../../lib/outbox';
import { mode } from '../../lib/tenant';
import { can, useKitchenScreen, useMe, useMenu, useOrder } from '../../lib/queries';
import type { MenuItem, Order, OrderLine, SendResult } from '../../lib/types';
import { ItemSheet, QUICK_NOTES, type AddBody } from './ItemSheet';
import { OrderActions } from './OrderActions';

const PRICE_LIST: Record<Order['type'], string> = {
  DINE_IN: 'DINE_IN',
  TAKEAWAY: 'TAKEAWAY',
  DELIVERY: 'DELIVERY',
};

const POPULAR = '__popular';

const needsSheet = (i: MenuItem): boolean =>
  i.kind !== 'STANDARD' || i.variants.length > 1 || i.modifierGroups.length > 0;

export function OrderPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const order = useOrder(id);
  const menu = useMenu(order.data ? PRICE_LIST[order.data.type] : undefined);

  // dishes and "send" kept on this device while the internet was down (ADR 0026)
  const outboxItems = useOutbox((s) => s.items);
  const pending = useMemo(() => outboxItems.filter((c) => c.orderId === id), [outboxItems, id]);
  const pendingAdds = pending.filter((c) => c.kind === 'ADD' && c.state === 'WAITING').length;
  const pendingSend = pending.some((c) => c.kind === 'SEND' && c.state === 'WAITING');
  const [category, setCategory] = useState<string | null>(null);
  // what sold most lately, best first: a one-tap shortcut for the usual orders
  const popular = useQuery({
    queryKey: ['popular'],
    queryFn: () =>
      api<{ items: { itemId: string; qty: number }[] }>('/menu/popular?days=14&limit=12'),
    staleTime: 5 * 60_000,
  });
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState<MenuItem | null>(null);
  const [voiding, setVoiding] = useState<OrderLine | null>(null);
  const [noting, setNoting] = useState<OrderLine | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false); // phones: the cart is a full-screen sheet

  const apply = (o: Order): void => {
    // an older fetch that is still in flight must not overwrite this newer version (If-Match!)
    void qc.cancelQueries({ queryKey: ['order', id] });
    qc.setQueryData(['order', id], o);
    qc.removeQueries({ queryKey: ['floor'] }); // not invalidate: no stale floor may flash up
    setMessage(null);
  };
  const onError = (e: unknown): void => {
    if (
      e instanceof ApiError &&
      (e.code === 'VERSION_CONFLICT' || e.code === 'ORDER_NOT_EDITABLE')
    ) {
      setMessage(e.code === 'VERSION_CONFLICT' ? t('order.conflict') : t('order.notEditable'));
      void order.refetch();
      return;
    }
    setMessage(e instanceof ApiError ? e.message : t('common.error'));
  };

  // Without internet a dish (or "send") is kept on this device and goes to the server when it is back.
  const offlineOk = (e: unknown): boolean =>
    e instanceof ApiError &&
    e.code === 'OFFLINE' &&
    order.data?.status === 'OPEN' &&
    !order.data.held;
  const add = useMutation({
    mutationFn: async (body: AddBody): Promise<Order | null> => {
      try {
        return await api<Order>(`/orders/${id}/items`, { method: 'POST', body });
      } catch (e) {
        if (!offlineOk(e)) throw e;
        const item = menu.data?.items.find((i) => i.id === body.itemId);
        const variant = item?.variants.find((v) => v.id === body.variantId);
        const name = item ? localName(lang, item.name, item.nameUr) : '';
        useOutbox.getState().enqueue({
          orderId: id,
          kind: 'ADD',
          body: { ...body },
          label: item && item.variants.length > 1 && variant ? `${name} (${variant.name})` : name,
          qty: body.qty ?? 1,
        });
        toast(t('offline.kept'), 'warn');
        return null;
      }
    },
    onSuccess: (o) => {
      if (o) apply(o);
      setSheet(null);
    },
    onError,
  });
  const changeQty = useMutation({
    mutationFn: (v: { line: OrderLine; qty: number }) =>
      api<Order>(`/orders/${id}/items/${v.line.id}`, { method: 'PATCH', body: { qty: v.qty } }),
    onSuccess: apply,
    onError,
  });
  const voidLine = useMutation({
    mutationFn: (v: { line: OrderLine; reason?: string }) =>
      api<Order>(`/orders/${id}/items/${v.line.id}/void`, {
        method: 'POST',
        body: v.reason ? { reason: v.reason } : {},
      }),
    onSuccess: (o, v) => {
      apply(o);
      setVoiding(null);
      // a dish taken out of the cart before it was sent can be put back with one tap (no confirm dialog)
      const l = v.line;
      if (l.status === 'NEW' && !o.items.some((k) => k.parentId === l.id)) {
        toast(t('order.removedLine', { name: l.name }), 'ok', {
          label: t('order.undo'),
          run: () =>
            add.mutate({
              itemId: l.itemId,
              variantId: l.variantId,
              qty: l.qty,
              ...(l.weightG ? { weightG: l.weightG } : {}),
              ...(l.modifiers.length ? { modifierIds: l.modifiers.map((m) => m.id) } : {}),
              ...(l.note ? { note: l.note } : {}),
            }),
        });
      }
    },
    onError,
  });
  const saveNote = useMutation({
    mutationFn: (v: { line: OrderLine; note: string }) =>
      api<Order>(`/orders/${id}/items/${v.line.id}`, {
        method: 'PATCH',
        body: { note: v.note.trim() || null },
      }),
    onSuccess: (o) => {
      apply(o);
      setNoting(null);
    },
    onError,
  });
  const hold = useMutation({
    mutationFn: (held: boolean) =>
      api<Order>(`/orders/${id}/${held ? 'hold' : 'resume'}`, { method: 'POST' }),
    onSuccess: apply,
    onError,
  });

  const [rush, setRush] = useState(false);
  // a slip the browser prints when no thermal printer took it (modal with a Print button)
  const [slip, setSlip] = useState<
    | { kind: 'token'; doc: TokenSlipDoc; language: 'en' | 'ur' }
    | { kind: 'kot'; doc: KotTicketDoc }
    | null
  >(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const kitchenScreen = useKitchenScreen();
  const send = useMutation({
    mutationFn: async (): Promise<SendResult | null> => {
      const body = rush ? { rush: true } : {};
      try {
        return await api<SendResult>(`/orders/${id}/send`, { method: 'POST', body });
      } catch (e) {
        if (!offlineOk(e)) throw e;
        if (!pendingSend)
          useOutbox
            .getState()
            .enqueue({ orderId: id, kind: 'SEND', body, label: t('order.send'), qty: 0 });
        toast(t('offline.keptSend'), 'warn');
        // the kitchen still needs a paper: the ticket is made here from the order and the dishes kept on this device
        const unsent = (order.data?.items ?? [])
          .filter((l) => l.status === 'NEW' && !l.parentId)
          .map((l) => ({
            qty: l.qty,
            name: l.name,
            weightG: l.weightG,
            modifiers: l.modifiers.map((m) => m.name),
            note: l.note,
          }));
        const kept = pending
          .filter((c) => c.kind === 'ADD' && c.state === 'WAITING')
          .map((c) => ({ qty: c.qty, name: c.label, modifiers: [] as string[], note: null }));
        const lines = [...unsent, ...kept];
        if (order.data && lines.length)
          setSlip({
            kind: 'kot',
            doc: {
              orderNo: order.data.orderNo,
              orderType: order.data.type,
              tableCode: order.data.tableCode,
              customer: {
                name: order.data.customerName ?? null,
                phone: order.data.customerPhone ?? null,
              },
              time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
              sections: [{ station: 'KITCHEN', kotNo: 0, lines }],
            },
          });
        return null;
      }
    },
    onSuccess: (out) => {
      if (!out) {
        setRush(false);
        return;
      }
      apply(out.order);
      setRush(false);
      const stations = out.kots.map((k) => k.station).join(', ');
      const printed = out.kots.some((k) => k.printers > 0);
      toast(
        printed
          ? t(kitchenScreen ? 'order.sentOkPrinted' : 'order.sentKotPrinted', {
              stations,
              token: out.order.orderNo,
            })
          : t('order.sentOk', { stations }),
      );
      // in the cloud the kitchen works from its screen, so "no printer" is not a problem to report;
      // without that screen the printed ticket IS the kitchen, so it must be reported
      // a ticket no printer took is printed from here, in a modal (and the browser's print dialog), like the bill
      if (out.ticket) setSlip({ kind: 'kot', doc: out.ticket });
      if (out.unprinted.length && (mode.kind !== 'tenant' || !kitchenScreen))
        setMessage(t('order.noPrinter', { stations: out.unprinted.join(', ') }));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'NOTHING_TO_SEND')
        setMessage(t('order.nothingToSend'));
      else onError(e);
    },
  });

  const nav = useNavigate();
  const me = useMe();
  // "Print bill": the table's bill comes out for the customer, who pays later; the table stays taken until then
  const printBill = useMutation({
    mutationFn: () =>
      api<{ billId: string; token: number; tableCode: string | null; printers: number }>(
        `/orders/${id}/print-bill`,
        {
          method: 'POST',
          body: {},
          ifMatch: order.data?.version,
          headers: { 'idempotency-key': `ui-${crypto.randomUUID()}` },
        },
      ),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: ['order', id] });
      qc.removeQueries({ queryKey: ['floor'] });
      if (out.printers === 0) {
        // no thermal printer here (a cloud shop): the pay screen prints the bill from the browser
        nav(`/order/${id}/pay`);
        return;
      }
      toast(t('order.billPrinted', { token: out.token }));
      nav('/');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'UNSENT_ITEMS') setMessage(t('bill.unsent'));
      else onError(e);
    },
  });
  // "counter mode" (the Kitchen screen is switched off): the printed ticket IS the kitchen, so the button says what it
  // does (Print KOT) and a separate "Print token" slip is offered for the customer
  const counterMode = true; // Print KOT + Print token in every mode: the button never says "Send to kitchen"
  const printToken = useMutation({
    mutationFn: () =>
      api<{
        token: number;
        printers: number;
        browser: { doc: TokenSlipDoc; language: 'en' | 'ur' } | null;
      }>(`/orders/${id}/print-token`, {
        method: 'POST',
        body: {},
        headers: { 'idempotency-key': `ui-${crypto.randomUUID()}` },
      }),
    onSuccess: (out) => {
      if (out.browser)
        setSlip({ kind: 'token', doc: out.browser.doc, language: out.browser.language });
      else toast(t('order.tokenPrinted', { token: out.token }));
    },
    onError,
  });
  const makeBill = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/orders/${id}/bill`, {
        method: 'POST',
        ifMatch: order.data?.version,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', id] });
      qc.removeQueries({ queryKey: ['floor'] }); // not invalidate: no stale floor may flash up
      nav(`/order/${id}/pay`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'UNSENT_ITEMS') setMessage(t('bill.unsent'));
      else onError(e);
    },
  });

  const topCategories = (menu.data?.categories ?? []).filter((c) => c.parentId === null);
  const hueIndex = new Map(topCategories.map((c, n) => [c.id, n]));
  // in a main category with sub-categories (BBQ: Regular, Special) a second row of tabs appears
  const activeTop =
    category && category !== POPULAR ? topOfCat(menu.data?.categories ?? [], category) : null;
  const subTabs = (menu.data?.categories ?? []).filter(
    (c) => activeTop !== null && c.parentId === activeTop,
  );
  // a dish takes the colour of its main (top-level) category
  const topOf = (categoryId: string | null): string | null => {
    let cur = categoryId;
    for (let i = 0; cur && i < 10; i++) {
      const parent = menu.data?.categories.find((c) => c.id === cur)?.parentId ?? null;
      if (!parent) return cur;
      cur = parent;
    }
    return cur;
  };
  // the category rail: each main category with its dish count and a photo of one of its dishes
  const itemsByTop = new Map<string, MenuItem[]>();
  for (const it of menu.data?.items ?? []) {
    const top = topOf(it.categoryId);
    if (top) itemsByTop.set(top, [...(itemsByTop.get(top) ?? []), it]);
  }
  const categoryTiles: CategoryTile[] = topCategories.map((c, n) => {
    const mine = itemsByTop.get(c.id) ?? [];
    const cover = mine.find((i) => i.imageVer);
    return {
      id: c.id,
      name: localName(lang, c.name, c.nameUr),
      count: mine.length,
      hue: hueAt(n),
      cover: cover ? { itemId: cover.id, ver: cover.imageVer! } : null,
    };
  });
  // photo cards only when the restaurant has photos: without any, compact cards show more dishes at once
  const hasPhotos = (menu.data?.items ?? []).some((i) => !!i.imageVer);
  // only dishes that are on today's menu count; a short or empty list is not worth a tab
  const onMenu = new Set((menu.data?.items ?? []).map((i) => i.id));
  const popularIds = (popular.data?.items ?? [])
    .map((p) => p.itemId)
    .filter((id) => onMenu.has(id));
  const visibleItems = useMemo(() => {
    const items = menu.data?.items ?? [];
    const cats = menu.data?.categories ?? [];
    const inCategory = (catId: string | null): boolean => {
      if (!category) return true;
      let cur = catId;
      for (let i = 0; cur && i < 10; i++) {
        if (cur === category) return true;
        cur = cats.find((c) => c.id === cur)?.parentId ?? null;
      }
      return false;
    };
    // a search looks through the whole menu: nobody should have to guess which category a dish is in
    if (search.trim())
      return items.filter((i) => matchesQuery([i.name, i.nameUr, i.searchTerms, i.code], search));
    if (category === POPULAR) {
      const rank = new Map(popularIds.map((id, k) => [id, k]));
      return items.filter((i) => rank.has(i.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    }
    return items.filter(
      (i) =>
        inCategory(i.categoryId) && matchesQuery([i.name, i.nameUr, i.searchTerms, i.code], search),
    );
  }, [menu.data, category, search, popularIds]);

  if (order.isPending) return <Loader />;
  if (order.isError || !order.data) return <p className="p-4 text-rose-700">{t('common.error')}</p>;
  const o = order.data;
  const editable = o.status === 'OPEN' && !o.held;
  const lines = o.items.filter((l) => !l.parentId);
  const liveLines = lines.filter((l) => l.status !== 'VOID');
  const unsent = lines.filter((l) => l.status === 'NEW');
  const unsentCount = unsent.reduce((n, l) => n + l.qty, 0);
  // like a shopping cart: what is still to be sent on top, what the kitchen already has below
  const sentLines = lines.filter((l) => l.status !== 'NEW');
  const sumOf = (ls: OrderLine[]): number =>
    ls.filter((l) => l.status !== 'VOID').reduce((n, l) => n + l.lineTotalPaisa, 0);
  const groups = [
    { key: 'new', label: t('order.toSend'), lines: unsent, total: sumOf(unsent) },
    { key: 'sent', label: t('order.inKitchenGroup'), lines: sentLines, total: sumOf(sentLines) },
  ].filter((g) => g.lines.length > 0);

  function pick(item: MenuItem): void {
    if (!item.available || !editable) return;
    setMessage(null);
    if (needsSheet(item)) {
      setSheet(item);
      return;
    }
    const variantId = item.variants[0]!.id;
    // tapping the same plain item again adds one to the line that has not been sent yet
    const same = unsent.find(
      (l) =>
        l.itemId === item.id &&
        l.variantId === variantId &&
        !l.weightG &&
        l.modifiers.length === 0 &&
        !l.note,
    );
    if (same) changeQty.mutate({ line: same, qty: same.qty + 1 });
    else add.mutate({ itemId: item.id, variantId, qty: 1 });
  }

  /** "One more": the same dish, same size and extras, as a new line (or one more on the unsent plain line). */
  function again(line: OrderLine): void {
    if (!editable) return;
    setMessage(null);
    const modifierIds = line.modifiers.map((m) => m.id);
    if (modifierIds.length === 0 && !line.note) {
      const same = unsent.find(
        (l) =>
          l.itemId === line.itemId &&
          l.variantId === line.variantId &&
          !l.weightG &&
          l.modifiers.length === 0 &&
          !l.note,
      );
      if (same) {
        changeQty.mutate({ line: same, qty: same.qty + 1 });
        return;
      }
    }
    add.mutate({
      itemId: line.itemId,
      variantId: line.variantId,
      qty: 1,
      ...(modifierIds.length ? { modifierIds } : {}),
      ...(line.note ? { note: line.note } : {}),
    });
  }

  const title =
    o.type === 'DINE_IN'
      ? `${t('order.table')} ${ltr(o.tableCode ?? '')}`
      : t(o.type === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery');

  // The cart always offers exactly one next step, and says why.
  let helper: string;
  if (o.held) helper = t('order.helperHeld');
  else if (o.status === 'BILLED') helper = t('order.helperBilled');
  else if (o.status === 'SETTLED') helper = t('order.helperSettled');
  else if (pending.length > 0) helper = t('offline.pendingHelp');
  else if (liveLines.length === 0) helper = t('order.helperEmpty');
  else if (unsentCount > 0)
    helper = t(counterMode ? 'order.helperUnsentCounter' : 'order.helperUnsent', {
      count: unsentCount,
    });
  else helper = t('order.helperSent');

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── menu */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col md:border-e md:border-slate-300">
        <div className="flex items-center gap-2 p-3 pb-2">
          <Link
            to="/"
            className="btn-quiet shrink-0 whitespace-nowrap px-2"
            aria-label={t('common.back')}
          >
            <Icon name="chevronLeft" data-flip />
            {t('common.back')}
          </Link>
          <div className="relative flex-1">
            <Icon
              name="search"
              size={18}
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              className="input ps-10"
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <CategoryTabs
            tiles={categoryTiles}
            active={category === POPULAR ? POPULAR : activeTop}
            popular={{ count: popularIds.length, key: POPULAR }}
            labels={{
              all: t('common.all'),
              popular: t('order.popular'),
              aria: t('order.categories'),
            }}
            allCount={(menu.data?.items ?? []).length}
            onSelect={(id) => setCategory(id)}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-baseline gap-2 px-3 pb-1 pt-1 md:pt-3">
              <h2 className="truncate text-xl font-bold">
                {search.trim()
                  ? t('order.searchResults')
                  : category === POPULAR
                    ? t('order.popular')
                    : category === null
                      ? t('common.all')
                      : localName(
                          lang,
                          (menu.data?.categories ?? []).find((c) => c.id === category)?.name ?? '',
                          (menu.data?.categories ?? []).find((c) => c.id === category)?.nameUr ??
                            null,
                        )}
              </h2>
              <span className="shrink-0 text-sm text-slate-500">
                {t('floor.items', { count: visibleItems.length })}
              </span>
            </div>
            {subTabs.length > 0 && !search.trim() && (
              <div
                className="flex gap-1.5 overflow-x-auto px-3 pb-2"
                role="tablist"
                aria-label={t('admin.menuPage.subCategory')}
              >
                <button
                  role="tab"
                  aria-selected={category === activeTop}
                  className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white text-sm"
                  onClick={() => setCategory(activeTop)}
                >
                  {t('common.all')}
                </button>
                {subTabs.map((c) => (
                  <button
                    key={c.id}
                    role="tab"
                    aria-selected={category === c.id}
                    className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white text-sm"
                    onClick={() => setCategory(c.id)}
                  >
                    {localName(lang, c.name, c.nameUr)}
                  </button>
                ))}
              </div>
            )}
            <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(8.25rem,1fr))] content-start gap-2.5 overflow-auto p-3 pt-1">
              {visibleItems.length === 0 && (
                <p className="col-span-full p-6 text-center text-slate-600">{t('order.noMatch')}</p>
              )}
              {visibleItems.map((item) => {
                const inCart = unsent
                  .filter((l) => l.itemId === item.id)
                  .reduce((n, l) => n + l.qty, 0);
                // a plain dish already in the cart gets a − 2 + stepper right on its card, like a shopping app
                const plainLine = needsSheet(item)
                  ? undefined
                  : unsent.find(
                      (l) =>
                        l.itemId === item.id &&
                        l.variantId === item.variants[0]!.id &&
                        !l.weightG &&
                        l.modifiers.length === 0 &&
                        !l.note,
                    );
                return (
                  <ItemCard
                    key={item.id}
                    item={item}
                    lang={lang}
                    hue={hueAt(hueIndex.get(topOf(item.categoryId) ?? '') ?? 0)}
                    showPhoto={hasPhotos}
                    editable={editable}
                    inCart={inCart}
                    plainLine={plainLine}
                    busy={changeQty.isPending || voidLine.isPending}
                    labels={{
                      soldOut: t('order.soldOut'),
                      removeOne: t('order.removeOne'),
                      addOne: t('order.addOne'),
                    }}
                    onPick={() => pick(item)}
                    onMinus={() =>
                      plainLine &&
                      (plainLine.qty <= 1
                        ? voidLine.mutate({ line: plainLine })
                        : changeQty.mutate({ line: plainLine, qty: plainLine.qty - 1 }))
                    }
                    onPlus={() =>
                      plainLine && changeQty.mutate({ line: plainLine, qty: plainLine.qty + 1 })
                    }
                  />
                );
              })}
            </div>
          </div>
        </div>
        {liveLines.length > 0 && (
          <div className="border-t border-slate-300 bg-white p-2 md:hidden">
            <button
              className="btn-primary btn-lg w-full justify-between"
              onClick={() => setCartOpen(true)}
            >
              <span>
                {t('order.viewOrder', { count: liveLines.reduce((n, l) => n + l.qty, 0) })}
              </span>
              <span className="money">{ltr(formatRs(o.subtotalPaisa))}</span>
            </button>
          </div>
        )}
      </section>

      {/* ── cart */}
      <aside
        className={`${cartOpen ? 'fixed inset-0 z-30 flex' : 'hidden'} min-h-0 w-full flex-col bg-slate-50 md:static md:z-auto md:flex md:w-[25rem] md:border-s md:border-slate-200`}
      >
        {/* header: one dark block that says which order this is and where it stands */}
        <div
          className={`border-b-4 bg-slate-900 text-white ${o.status === 'BILLED' ? 'border-sky-500' : o.status === 'SETTLED' ? 'border-emerald-500' : 'border-amber-500'}`}
        >
          <div className="flex items-start gap-2 px-4 pt-3">
            <div className="me-auto min-w-0">
              <h1 className="flex flex-wrap items-baseline gap-x-2 truncate text-2xl font-semibold leading-tight">
                {title}
                <span className="rounded-md bg-white/10 px-2 py-0.5 text-lg font-bold text-emerald-300">
                  {o.orderNo > 0
                    ? `${t('order.token')} ${ltr(String(o.orderNo))}`
                    : t('offline.tokenPending')}
                </span>
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold ${o.status === 'BILLED' ? 'bg-sky-500 text-white' : o.status === 'SETTLED' ? 'bg-emerald-500 text-white' : 'bg-amber-400 text-slate-900'}`}
                >
                  {t(
                    o.status === 'BILLED'
                      ? 'order.stateBilled'
                      : o.status === 'SETTLED'
                        ? 'order.stateSettled'
                        : 'order.stateOpen',
                  )}
                </span>
                {o.type !== 'DINE_IN' && o.status === 'OPEN' && (
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-white/25 px-2 py-0.5 text-xs font-semibold text-slate-100 hover:bg-white/10"
                    onClick={() => setCustomerOpen(true)}
                  >
                    <Icon name="user" size={12} />
                    <span className="truncate">
                      {o.customerName || o.customerPhone
                        ? [o.customerName, o.customerPhone].filter(Boolean).join(' · ')
                        : t('order.addCustomer')}
                    </span>
                  </button>
                )}
                {o.held && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2 py-0.5 text-xs font-bold text-slate-100">
                    <Icon name="pause" size={12} /> {t('order.held')}
                  </span>
                )}
                {liveLines.length > 0 && (
                  <span className="text-xs text-slate-400">
                    {t('floor.items', { count: liveLines.reduce((n, l) => n + l.qty, 0) })}
                  </span>
                )}
              </div>
            </div>
            <button
              className="inline-flex size-10 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 md:hidden"
              aria-label={t('common.close')}
              onClick={() => setCartOpen(false)}
            >
              <Icon name="chevronDown" />
            </button>
            {o.status === 'OPEN' && (
              <OrderActions
                order={o}
                canTransfer={can(me.data, 'order.transfer')}
                canCancel={can(me.data, 'order.cancel')}
                holdBusy={hold.isPending}
                onHold={() => hold.mutate(!o.held)}
                onChanged={apply}
                onCancelled={() => {
                  qc.removeQueries({ queryKey: ['floor'] }); // not invalidate: no stale floor may flash up
                  nav('/');
                }}
              />
            )}
          </div>

          {o.status === 'OPEN' && !o.held && (
            <ol
              className="flex items-center gap-1 px-4 pb-3 pt-3 text-xs font-semibold"
              aria-label={t('order.steps.title')}
            >
              {(['add', 'send', 'bill'] as const).map((k, n) => {
                const at = liveLines.length === 0 ? 0 : unsent.length > 0 ? 1 : 2;
                const state = n < at ? 'done' : n === at ? 'now' : 'next';
                return (
                  <Fragment key={k}>
                    {n > 0 && (
                      <span
                        aria-hidden="true"
                        className={`h-0.5 flex-1 rounded ${n <= at ? 'bg-emerald-500' : 'bg-slate-700'}`}
                      />
                    )}
                    <li
                      aria-current={state === 'now' ? 'step' : undefined}
                      className={`flex items-center gap-1.5 whitespace-nowrap ${state === 'now' ? 'text-white' : state === 'done' ? 'text-emerald-300' : 'text-slate-500'}`}
                    >
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.7rem] ${
                          state === 'done'
                            ? 'bg-emerald-500 text-white'
                            : state === 'now'
                              ? 'bg-white text-slate-900'
                              : 'border border-slate-600'
                        }`}
                      >
                        {state === 'done' ? <Icon name="check" size={12} /> : n + 1}
                      </span>
                      {k === 'send' && counterMode
                        ? t('order.steps.printKot')
                        : t(`order.steps.${k}`)}
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          )}
        </div>

        {message && (
          <p role="alert" className="m-3 mb-0 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {message}
          </p>
        )}

        <ul className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
          {lines.length === 0 && pending.length === 0 && (
            <li className="flex flex-col items-center gap-3 p-10 text-center text-slate-500">
              <span className="flex size-16 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-slate-200">
                <Icon name="bag" size={28} />
              </span>
              {t('order.empty')}
            </li>
          )}
          {pending.length > 0 && (
            <>
              <li className="flex items-center gap-2 px-1 pt-1 text-xs font-bold uppercase tracking-wide text-amber-800">
                <span className="size-2 rounded-full bg-amber-500" />
                {t('offline.pendingTitle')}
              </li>
              {pending.map((c) => (
                <li
                  key={c.id}
                  className="space-y-1 rounded-xl border border-dashed border-amber-400 bg-amber-50 p-3"
                >
                  <div className="flex items-start gap-2">
                    <span className="me-auto font-semibold">
                      {c.kind === 'ADD' ? `${ltr(`${c.qty}×`)} ${c.label}` : c.label}
                    </span>
                    <button
                      className="btn-quiet min-h-9 px-2 text-rose-700"
                      aria-label={`${t('offline.forget')} ${c.label}`}
                      onClick={() => useOutbox.getState().remove(c.id)}
                    >
                      <Icon name="trash" size={18} />
                    </button>
                  </div>
                  {c.state === 'FAILED' ? (
                    <p className="text-sm font-medium text-rose-700">
                      {t('offline.failed')}: {c.error}
                    </p>
                  ) : (
                    <span className="chip-warn">
                      {c.kind === 'ADD' ? t('offline.notSaved') : t('offline.notSent')}
                    </span>
                  )}
                </li>
              ))}
            </>
          )}
          {groups.map((g) => (
            <Fragment key={g.key}>
              {groups.length > 1 && (
                <li className="flex items-center gap-2 px-1 pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <span
                    className={`size-2 rounded-full ${g.key === 'new' ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  />
                  <span>{g.label}</span>
                  <span className="money ms-auto text-slate-700">{ltr(formatRs(g.total))}</span>
                </li>
              )}
              {g.lines.map((line) => {
                const kids = o.items.filter((k) => k.parentId === line.id);
                const dead = line.status === 'VOID';
                const stepper = line.status === 'NEW' && !line.weightG && editable;
                return (
                  <li
                    key={line.id}
                    className={`rounded-xl border border-slate-200 border-s-4 bg-white p-3 shadow-sm ${
                      dead
                        ? 'border-s-slate-300 opacity-50'
                        : line.status === 'NEW'
                          ? 'border-s-amber-500'
                          : 'border-s-emerald-500'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {stepper ? (
                        <div className="inline-flex shrink-0 items-center rounded-lg bg-slate-100">
                          <button
                            className="btn-quiet min-h-10 min-w-10 px-0"
                            aria-label="minus"
                            disabled={line.qty <= 1 || changeQty.isPending}
                            onClick={() => changeQty.mutate({ line, qty: line.qty - 1 })}
                          >
                            <Icon name="minus" size={18} />
                          </button>
                          <span className="money w-7 text-center text-base font-bold">
                            {line.qty}
                          </span>
                          <button
                            className="btn-quiet min-h-10 min-w-10 px-0"
                            aria-label="plus"
                            disabled={changeQty.isPending}
                            onClick={() => changeQty.mutate({ line, qty: line.qty + 1 })}
                          >
                            <Icon name="plus" size={18} />
                          </button>
                        </div>
                      ) : (
                        <span className="money inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 px-2 text-base font-bold text-slate-800">
                          {ltr(`${line.qty}×`)}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className={`font-semibold leading-snug ${dead ? 'line-through' : ''}`}>
                          {localName(lang, line.name, line.nameUr)}
                          {line.weightG ? ` · ${ltr(`${line.weightG} g`)}` : ''}
                        </div>
                        {line.qty > 1 && !line.weightG && line.lineTotalPaisa % line.qty === 0 && (
                          <div className="text-sm text-slate-500">
                            {ltr(`${line.qty} × ${formatRs(line.lineTotalPaisa / line.qty)}`)}
                          </div>
                        )}
                        {line.modifiers.length > 0 && (
                          <div className="text-sm text-slate-600">
                            {line.modifiers.map((m) => m.name).join(', ')}
                          </div>
                        )}
                        {kids.length > 0 && (
                          <div className="text-sm text-slate-600">
                            {kids.map((k) => `${k.qty}× ${k.name}`).join(' · ')}
                          </div>
                        )}
                        {line.note && (
                          <div className="mt-1 inline-block rounded-md bg-amber-50 px-2 py-0.5 text-sm font-medium text-amber-900">
                            “{line.note}”
                          </div>
                        )}
                      </div>
                      <span
                        className={`money shrink-0 text-base font-semibold ${dead ? 'line-through' : ''}`}
                      >
                        {ltr(formatRs(line.lineTotalPaisa))}
                      </span>
                    </div>
                    {dead ? (
                      <span className="chip-mute mt-2">{t('order.voided')}</span>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2">
                        {line.status === 'NEW' ? (
                          <span className="chip-warn">{t('order.notSent')}</span>
                        ) : (
                          <span className="chip-ok">
                            <Icon name="check" size={14} /> {t('order.inKitchen')}
                          </span>
                        )}
                        {editable && line.status === 'NEW' && kids.length === 0 && (
                          <button
                            className="btn-quiet min-h-9 px-2 text-sm"
                            aria-label={`${line.note ? t('order.editNote') : t('order.addNote')} ${line.name}`}
                            onClick={() => setNoting(line)}
                          >
                            <Icon name="edit" size={16} />
                            {line.note ? t('order.editNote') : t('order.addNote')}
                          </button>
                        )}
                        {editable && !stepper && !line.weightG && kids.length === 0 && (
                          <button
                            className="btn-secondary min-h-9 px-3 text-sm"
                            disabled={add.isPending || changeQty.isPending}
                            aria-label={`${t('order.again')} ${line.name}`}
                            onClick={() => again(line)}
                          >
                            <Icon name="plus" size={16} />
                            {t('order.again')}
                          </button>
                        )}
                        {editable && (
                          <button
                            className="btn-quiet ms-auto min-h-9 px-2 text-sm text-rose-700"
                            aria-label={`${t('order.void')} ${line.name}`}
                            onClick={() =>
                              line.status === 'NEW' ? voidLine.mutate({ line }) : setVoiding(line)
                            }
                          >
                            <Icon name="trash" size={16} />
                            {t('order.void')}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>

        {/* footer: the total, one sentence about what to do next, and the one big button */}
        <div className="space-y-3 border-t border-slate-200 bg-white p-4 shadow-[0_-8px_16px_-12px_rgba(16,24,40,0.18)]">
          <div className="flex items-end justify-between">
            <span className="text-sm font-medium uppercase tracking-wide text-slate-500">
              {t('order.subtotal')}
            </span>
            <span className="money text-3xl font-bold leading-none">
              {ltr(formatRs(o.subtotalPaisa))}
            </span>
          </div>
          <p className="hint">{helper}</p>

          {o.status === 'OPEN' &&
            !o.held &&
            (unsentCount > 0 || pendingAdds > 0) &&
            !pendingSend && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-pressed={rush}
                  className={`btn min-h-primary border ${rush ? 'border-amber-500 bg-amber-100 text-amber-900' : 'border-slate-300 bg-white text-slate-800'}`}
                  onClick={() => setRush(!rush)}
                >
                  <Icon name="flame" size={18} />
                  {t('order.rush')}
                </button>
                {counterMode && (
                  <button
                    className="btn-secondary btn-lg flex-1"
                    disabled={printToken.isPending}
                    onClick={() => printToken.mutate()}
                  >
                    <Icon name="printer" size={20} />
                    {t('order.printToken')}
                  </button>
                )}
                <button
                  className="btn-send btn-lg flex-1"
                  disabled={send.isPending}
                  onClick={() => send.mutate()}
                >
                  {counterMode ? t('order.printKot') : t('order.send')}
                </button>
              </div>
            )}
          {o.status === 'OPEN' &&
            !o.held &&
            unsentCount === 0 &&
            pending.length === 0 &&
            liveLines.length > 0 &&
            can(me.data, 'bill.create') && (
              <div className="flex flex-wrap gap-2">
                {counterMode && (
                  <button
                    className="btn-secondary w-full"
                    disabled={printToken.isPending}
                    onClick={() => printToken.mutate()}
                  >
                    <Icon name="printer" size={18} />
                    {t('order.printToken')}
                  </button>
                )}
                <button
                  className={`btn-lg ${o.type === 'DINE_IN' ? 'btn-secondary' : 'btn-bill flex-1'}`}
                  disabled={makeBill.isPending || printBill.isPending}
                  onClick={() => makeBill.mutate()}
                >
                  {t('order.billIt')} · {ltr(formatRs(o.subtotalPaisa))}
                </button>
                <button
                  className={`btn-lg ${o.type === 'DINE_IN' ? 'btn-bill flex-1' : 'btn-secondary'}`}
                  disabled={makeBill.isPending || printBill.isPending}
                  onClick={() => printBill.mutate()}
                >
                  <Icon name="printer" size={20} />
                  {t('order.printBill')}
                </button>
              </div>
            )}
          {(o.status === 'BILLED' || o.status === 'SETTLED') && (
            <Link to={`/order/${id}/pay`} className="btn-primary btn-lg w-full">
              {t('order.payIt')}
            </Link>
          )}
        </div>
      </aside>

      {slip && (
        <SlipModal
          title={t(slip.kind === 'token' ? 'slip.tokenTitle' : 'slip.kotTitle')}
          hint={t('slip.noPrinter')}
          onClose={() => setSlip(null)}
        >
          {slip.kind === 'token' ? (
            <TokenSlip doc={slip.doc} language={slip.language} />
          ) : (
            <KotSlip doc={slip.doc} />
          )}
        </SlipModal>
      )}
      {customerOpen && (
        <CustomerDialog
          order={o}
          onClose={() => setCustomerOpen(false)}
          onSaved={(updated) => {
            apply(updated);
            setCustomerOpen(false);
          }}
        />
      )}
      {sheet && (
        <ItemSheet
          item={sheet}
          busy={add.isPending}
          error={message}
          onClose={() => setSheet(null)}
          onAdd={(b) => add.mutate(b)}
        />
      )}
      {noting && (
        <NoteDialog
          line={noting}
          busy={saveNote.isPending}
          onClose={() => setNoting(null)}
          onSave={(note) => saveNote.mutate({ line: noting, note })}
        />
      )}
      {voiding && (
        <VoidDialog
          line={voiding}
          busy={voidLine.isPending}
          onClose={() => setVoiding(null)}
          onSubmit={(reason) => voidLine.mutate({ line: voiding, reason })}
        />
      )}
    </div>
  );
}

/** Change the note on a dish that is still in the cart (not yet sent): one-tap chips or free text. */
function NoteDialog({
  line,
  busy,
  onClose,
  onSave,
}: {
  line: OrderLine;
  busy: boolean;
  onClose: () => void;
  onSave: (note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(line.note ?? '');
  const parts = note ? note.split(', ') : [];
  return (
    <Modal
      title={`${t('order.editNote')}: ${line.name}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => onSave(note)}>
            {t('admin.save')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('order.quickNotes')}>
          {QUICK_NOTES.map((k) => {
            const label = t(`order.qn.${k}`);
            const on = parts.includes(label);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                className={`min-h-touch rounded-full border px-3 text-sm font-medium ${on ? 'border-amber-500 bg-amber-100 text-amber-950' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'}`}
                onClick={() =>
                  setNote((on ? parts.filter((p) => p !== label) : [...parts, label]).join(', '))
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <textarea
          className="input min-h-20"
          aria-label={t('order.note')}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Modal>
  );
}

function VoidDialog({
  line,
  busy,
  onClose,
  onSubmit,
}: {
  line: OrderLine;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={`${t('order.void')}: ${line.name}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-danger"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onSubmit(reason.trim())}
          >
            {t('order.void')}
          </button>
        </>
      }
    >
      <p className="hint mb-2">{t('order.needReason')}</p>
      <input
        className="input"
        autoFocus
        placeholder={t('order.voidReason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}
