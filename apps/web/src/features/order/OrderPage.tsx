import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { localName } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { can, useMe, useMenu, useOrder } from '../../lib/queries';
import type { MenuItem, Order, OrderLine, SendResult } from '../../lib/types';
import { ItemSheet, type AddBody } from './ItemSheet';
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

  const add = useMutation({
    mutationFn: (body: AddBody) => api<Order>(`/orders/${id}/items`, { method: 'POST', body }),
    onSuccess: (o) => {
      apply(o);
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
    onSuccess: (o) => {
      apply(o);
      setVoiding(null);
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
  const send = useMutation({
    mutationFn: () =>
      api<SendResult>(`/orders/${id}/send`, { method: 'POST', body: rush ? { rush: true } : {} }),
    onSuccess: (out) => {
      apply(out.order);
      setRush(false);
      const stations = out.kots.map((k) => k.station).join(', ');
      toast(t('order.sentOk', { stations }));
      if (out.unprinted.length)
        setMessage(t('order.noPrinter', { stations: out.unprinted.join(', ') }));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'NOTHING_TO_SEND')
        setMessage(t('order.nothingToSend'));
      else if (e instanceof ApiError && e.code === 'STATION_MISSING')
        setMessage(t('order.missingStation', { items: String(e.body.items ?? '') }));
      else onError(e);
    },
  });

  const nav = useNavigate();
  const me = useMe();
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
    const q = search.trim().toLowerCase();
    if (category === POPULAR) {
      const rank = new Map(popularIds.map((id, k) => [id, k]));
      return items.filter((i) => rank.has(i.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    }
    return items.filter(
      (i) =>
        inCategory(i.categoryId) &&
        (!q || [i.name, i.nameUr, i.searchTerms, i.code].some((s) => s?.toLowerCase().includes(q))),
    );
  }, [menu.data, category, search, popularIds]);

  if (order.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (order.isError || !order.data) return <p className="p-4 text-rose-700">{t('common.error')}</p>;
  const o = order.data;
  const editable = o.status === 'OPEN' && !o.held;
  const lines = o.items.filter((l) => !l.parentId);
  const liveLines = lines.filter((l) => l.status !== 'VOID');
  const unsent = lines.filter((l) => l.status === 'NEW');
  const unsentCount = unsent.reduce((n, l) => n + l.qty, 0);

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

  const title =
    o.type === 'DINE_IN'
      ? `${t('order.table')} ${ltr(o.tableCode ?? '')}`
      : t(o.type === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery');

  // The cart always offers exactly one next step, and says why.
  let helper: string;
  if (o.held) helper = t('order.helperHeld');
  else if (o.status === 'BILLED') helper = t('order.helperBilled');
  else if (o.status === 'SETTLED') helper = t('order.helperSettled');
  else if (liveLines.length === 0) helper = t('order.helperEmpty');
  else if (unsentCount > 0) helper = t('order.helperUnsent', { count: unsentCount });
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
        <div
          className="flex gap-1.5 overflow-x-auto px-3 pb-2"
          role="tablist"
          aria-label={t('order.categories')}
        >
          <button
            role="tab"
            aria-selected={category === null}
            className="seg-item shrink-0 whitespace-nowrap border border-slate-300 bg-white"
            onClick={() => setCategory(null)}
          >
            {t('common.all')}
          </button>
          {popularIds.length >= 3 && (
            <button
              role="tab"
              aria-selected={category === POPULAR}
              className="seg-item shrink-0 whitespace-nowrap border border-amber-400 bg-amber-50 text-amber-900"
              onClick={() => setCategory(POPULAR)}
            >
              {t('order.popular')}
            </button>
          )}
          {topCategories.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={category === c.id}
              className="seg-item shrink-0 whitespace-nowrap border border-slate-300 bg-white"
              onClick={() => setCategory(c.id)}
            >
              {localName(lang, c.name, c.nameUr)}
            </button>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-auto p-3 pt-1 sm:grid-cols-3 lg:grid-cols-4">
          {visibleItems.length === 0 && (
            <p className="col-span-full p-6 text-center text-slate-600">{t('order.noMatch')}</p>
          )}
          {visibleItems.map((item) => {
            const inCart = unsent
              .filter((l) => l.itemId === item.id)
              .reduce((n, l) => n + l.qty, 0);
            return (
              <button
                key={item.id}
                disabled={!item.available || !editable}
                onClick={() => pick(item)}
                className="card relative flex min-h-24 flex-col items-start justify-between p-3 text-start transition-colors hover:border-slate-500 active:bg-slate-100 disabled:opacity-40"
              >
                <span className="font-semibold leading-snug">
                  {localName(lang, item.name, item.nameUr)}
                </span>
                <span className="money text-sm text-slate-700">
                  {item.available
                    ? item.variants.length > 1
                      ? ltr(`${formatRs(Math.min(...item.variants.map((v) => v.pricePaisa)))}+`)
                      : ltr(
                          formatRs(item.variants[0]!.pricePaisa) +
                            (item.kind === 'WEIGHT' ? '/kg' : ''),
                        )
                    : t('order.soldOut')}
                </span>
                {inCart > 0 && (
                  <span className="absolute end-2 top-2 flex size-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
                    {inCart}
                  </span>
                )}
              </button>
            );
          })}
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
        className={`${cartOpen ? 'fixed inset-0 z-30 flex' : 'hidden'} min-h-0 w-full flex-col bg-white md:static md:z-auto md:flex md:w-[24rem]`}
      >
        <div className="flex items-center gap-2 border-b border-slate-300 px-4 py-3">
          <div className="me-auto min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {title} <span className="font-normal text-slate-600">{ltr(`#${o.orderNo}`)}</span>
            </h1>
            {o.held && (
              <span className="chip-warn">
                <Icon name="pause" size={14} /> {t('order.held')}
              </span>
            )}
          </div>
          <button
            className="btn-quiet px-2 md:hidden"
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

        {message && (
          <p role="alert" className="m-3 mb-0 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {message}
          </p>
        )}

        <ul className="min-h-0 flex-1 divide-y divide-slate-200 overflow-auto">
          {lines.length === 0 && (
            <li className="flex flex-col items-center gap-2 p-8 text-center text-slate-600">
              <Icon name="bag" size={28} />
              {t('order.empty')}
            </li>
          )}
          {lines.map((line) => {
            const kids = o.items.filter((k) => k.parentId === line.id);
            const dead = line.status === 'VOID';
            const stepper = line.status === 'NEW' && !line.weightG && editable;
            return (
              <li key={line.id} className={`space-y-1.5 px-4 py-3 ${dead ? 'opacity-50' : ''}`}>
                <div className="flex items-start gap-2">
                  <span className={`me-auto font-medium ${dead ? 'line-through' : ''}`}>
                    {!stepper && <span className="text-slate-600">{ltr(`${line.qty}×`)} </span>}
                    {localName(lang, line.name, line.nameUr)}
                    {line.weightG ? ` · ${ltr(`${line.weightG} g`)}` : ''}
                  </span>
                  <span className={`money whitespace-nowrap ${dead ? 'line-through' : ''}`}>
                    {ltr(formatRs(line.lineTotalPaisa))}
                  </span>
                </div>
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
                {line.note && <div className="text-sm italic text-slate-600">“{line.note}”</div>}
                {dead ? (
                  <span className="chip-mute">{t('order.voided')}</span>
                ) : (
                  <div className="flex items-center gap-2">
                    {stepper ? (
                      <div className="inline-flex items-center rounded-lg border border-slate-400">
                        <button
                          className="btn-quiet min-w-touch px-0"
                          aria-label="minus"
                          disabled={line.qty <= 1 || changeQty.isPending}
                          onClick={() => changeQty.mutate({ line, qty: line.qty - 1 })}
                        >
                          <Icon name="minus" size={18} />
                        </button>
                        <span className="money w-8 text-center font-semibold">{line.qty}</span>
                        <button
                          className="btn-quiet min-w-touch px-0"
                          aria-label="plus"
                          disabled={changeQty.isPending}
                          onClick={() => changeQty.mutate({ line, qty: line.qty + 1 })}
                        >
                          <Icon name="plus" size={18} />
                        </button>
                      </div>
                    ) : null}
                    {line.status === 'NEW' ? (
                      <span className="chip-warn">{t('order.notSent')}</span>
                    ) : (
                      <span className="chip-ok">
                        <Icon name="check" size={14} /> {t('order.inKitchen')}
                      </span>
                    )}
                    {editable && (
                      <button
                        className="btn-quiet ms-auto px-2 text-rose-700"
                        aria-label={`${t('order.void')} ${line.name}`}
                        onClick={() =>
                          line.status === 'NEW' ? voidLine.mutate({ line }) : setVoiding(line)
                        }
                      >
                        <Icon name="trash" size={18} />
                        {t('order.void')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="space-y-2 border-t border-slate-300 bg-slate-50 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-slate-700">{t('order.subtotal')}</span>
            <span className="money text-2xl font-semibold">{ltr(formatRs(o.subtotalPaisa))}</span>
          </div>
          <p className="hint">{helper}</p>

          {o.status === 'OPEN' && !o.held && unsentCount > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-pressed={rush}
                className={`btn min-h-primary border ${rush ? 'border-amber-500 bg-amber-100 text-amber-900' : 'border-slate-400 bg-white text-slate-800'}`}
                onClick={() => setRush(!rush)}
              >
                <Icon name="flame" size={18} />
                {t('order.rush')}
              </button>
              <button
                className="btn-primary btn-lg flex-1"
                disabled={send.isPending}
                onClick={() => send.mutate()}
              >
                {t('order.send')}
              </button>
            </div>
          )}
          {o.status === 'OPEN' &&
            !o.held &&
            unsentCount === 0 &&
            liveLines.length > 0 &&
            can(me.data, 'bill.create') && (
              <button
                className="btn-primary btn-lg w-full"
                disabled={makeBill.isPending}
                onClick={() => makeBill.mutate()}
              >
                {t('order.billIt')} · {ltr(formatRs(o.subtotalPaisa))}
              </button>
            )}
          {(o.status === 'BILLED' || o.status === 'SETTLED') && (
            <Link to={`/order/${id}/pay`} className="btn-primary btn-lg w-full">
              {t('order.payIt')}
            </Link>
          )}
        </div>
      </aside>

      {sheet && (
        <ItemSheet
          item={sheet}
          busy={add.isPending}
          error={message}
          onClose={() => setSheet(null)}
          onAdd={(b) => add.mutate(b)}
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
