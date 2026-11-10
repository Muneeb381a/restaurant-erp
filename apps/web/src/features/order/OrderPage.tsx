import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState<MenuItem | null>(null);
  const [voiding, setVoiding] = useState<OrderLine | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage(
        out.unprinted.length
          ? `${t('order.sentOk', { stations })} · ${t('order.noPrinter', { stations: out.unprinted.join(', ') })}`
          : t('order.sentOk', { stations }),
      );
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
    return items.filter(
      (i) =>
        inCategory(i.categoryId) &&
        (!q || [i.name, i.nameUr, i.searchTerms, i.code].some((s) => s?.toLowerCase().includes(q))),
    );
  }, [menu.data, category, search]);

  if (order.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (order.isError || !order.data) return <p className="p-4 text-rose-700">{t('common.error')}</p>;
  const o = order.data;
  const editable = o.status === 'OPEN' && !o.held;
  const lines = o.items.filter((l) => !l.parentId);

  function pick(item: MenuItem): void {
    if (!item.available || !editable) return;
    setMessage(null);
    if (needsSheet(item)) setSheet(item);
    else add.mutate({ itemId: item.id, variantId: item.variants[0]!.id, qty: 1 });
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* ── menu */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-slate-200 md:border-e">
        <div className="flex items-center gap-2 p-2">
          <Link to="/" className="btn-secondary shrink-0 whitespace-nowrap">
            {lang === 'ur' ? '→' : '←'} {t('common.back')}
          </Link>
          <input
            className="input"
            placeholder={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2 overflow-x-auto px-2 pb-2">
          <button
            className={`shrink-0 whitespace-nowrap ${category === null ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setCategory(null)}
          >
            {t('common.all')}
          </button>
          {topCategories.map((c) => (
            <button
              key={c.id}
              className={`shrink-0 whitespace-nowrap ${category === c.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setCategory(c.id)}
            >
              {localName(lang, c.name, c.nameUr)}
            </button>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-auto p-2 sm:grid-cols-3 lg:grid-cols-4">
          {visibleItems.map((item) => (
            <button
              key={item.id}
              disabled={!item.available || !editable}
              onClick={() => pick(item)}
              className="card flex min-h-24 flex-col items-start justify-between p-3 text-start transition active:scale-95 disabled:opacity-40"
            >
              <span className="font-semibold leading-tight">
                {localName(lang, item.name, item.nameUr)}
              </span>
              <span className="text-sm text-slate-600">
                {item.available
                  ? item.variants.length > 1
                    ? ltr(`${formatRs(Math.min(...item.variants.map((v) => v.pricePaisa)))}+`)
                    : ltr(
                        formatRs(item.variants[0]!.pricePaisa) +
                          (item.kind === 'WEIGHT' ? '/kg' : ''),
                      )
                  : t('order.soldOut')}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── cart */}
      <aside className="flex max-h-[45vh] min-h-0 w-full flex-col bg-white md:max-h-none md:w-96">
        <div className="flex items-center gap-2 border-b border-slate-200 p-3">
          <div className="me-auto">
            <div className="text-lg font-bold">
              {o.type === 'DINE_IN'
                ? `${t('order.table')} ${ltr(o.tableCode ?? '')}`
                : t(o.type === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery')}
              <span className="ms-2 text-slate-500">{ltr(`#${o.orderNo}`)}</span>
            </div>
            {o.held && <span className="text-sm text-amber-700">⏸ {t('order.held')}</span>}
          </div>
          {o.status === 'OPEN' && (
            <button
              className="btn-secondary"
              disabled={hold.isPending}
              onClick={() => hold.mutate(!o.held)}
            >
              {o.held ? t('order.resume') : t('order.hold')}
            </button>
          )}
        </div>

        {o.status === 'OPEN' &&
          (can(me.data, 'order.transfer') || can(me.data, 'order.cancel')) && (
            <OrderActions
              order={o}
              canTransfer={can(me.data, 'order.transfer')}
              canCancel={can(me.data, 'order.cancel')}
              onChanged={apply}
              onCancelled={() => {
                qc.removeQueries({ queryKey: ['floor'] }); // not invalidate: no stale floor may flash up
                nav('/');
              }}
            />
          )}

        {message && (
          <p role="alert" className="m-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {message}
          </p>
        )}

        <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-auto">
          {lines.length === 0 && <li className="p-4 text-slate-500">{t('order.empty')}</li>}
          {lines.map((line) => {
            const kids = o.items.filter((k) => k.parentId === line.id);
            const dead = line.status === 'VOID';
            return (
              <li
                key={line.id}
                className={`space-y-1 p-3 ${dead ? 'opacity-40 line-through' : ''}`}
              >
                <div className="flex items-start gap-2">
                  <span className="me-auto font-medium">
                    {localName(lang, line.name, line.nameUr)}
                    {line.weightG ? ` · ${ltr(`${line.weightG} g`)}` : ''}
                  </span>
                  <span className="whitespace-nowrap">{ltr(formatRs(line.lineTotalPaisa))}</span>
                </div>
                {line.modifiers.length > 0 && (
                  <div className="text-sm text-slate-500">
                    {line.modifiers.map((m) => m.name).join(', ')}
                  </div>
                )}
                {kids.length > 0 && (
                  <div className="text-sm text-slate-500">
                    {kids.map((k) => `${k.qty}× ${k.name}`).join(' · ')}
                  </div>
                )}
                {line.note && <div className="text-sm italic text-slate-500">“{line.note}”</div>}
                {!dead && (
                  <div className="flex items-center gap-2">
                    {line.status === 'NEW' && !line.weightG && editable ? (
                      <>
                        <button
                          className="btn-secondary"
                          aria-label="minus"
                          disabled={line.qty <= 1 || changeQty.isPending}
                          onClick={() => changeQty.mutate({ line, qty: line.qty - 1 })}
                        >
                          −
                        </button>
                        <span className="w-8 text-center">{line.qty}</span>
                        <button
                          className="btn-secondary"
                          aria-label="plus"
                          disabled={changeQty.isPending}
                          onClick={() => changeQty.mutate({ line, qty: line.qty + 1 })}
                        >
                          +
                        </button>
                      </>
                    ) : (
                      <span className="rounded bg-slate-100 px-2 py-1 text-sm">
                        {line.status === 'NEW'
                          ? `× ${line.qty}`
                          : `${t('order.sent')} · × ${line.qty}`}
                      </span>
                    )}
                    {editable && (
                      <button
                        className="btn-secondary ms-auto text-rose-700"
                        onClick={() =>
                          line.status === 'NEW' ? voidLine.mutate({ line }) : setVoiding(line)
                        }
                      >
                        {t('order.void')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="space-y-2 border-t border-slate-200 p-3">
          <div className="flex items-center justify-between text-xl font-bold">
            <span>{t('order.subtotal')}</span>
            <span>{ltr(formatRs(o.subtotalPaisa))}</span>
          </div>
          {o.status === 'OPEN' && !o.held && (
            <div className="flex items-center gap-2">
              <label className="flex min-h-touch items-center gap-2 px-2">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={rush}
                  onChange={(e) => setRush(e.target.checked)}
                />
                {t('order.rush')}
              </label>
              <button
                className="btn-primary h-14 flex-1 text-lg"
                disabled={send.isPending || !lines.some((l) => l.status === 'NEW')}
                onClick={() => send.mutate()}
              >
                {t('order.send')}
              </button>
            </div>
          )}
          {o.status === 'OPEN' &&
            !o.held &&
            can(me.data, 'bill.create') &&
            lines.some((l) => l.status !== 'VOID') && (
              <button
                className="btn-secondary h-14 w-full text-lg"
                disabled={makeBill.isPending || lines.some((l) => l.status === 'NEW')}
                onClick={() => makeBill.mutate()}
              >
                {t('order.billIt')}
              </button>
            )}
          {(o.status === 'BILLED' || o.status === 'SETTLED') && (
            <Link to={`/order/${id}/pay`} className="btn-primary h-14 w-full text-lg">
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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-sm space-y-3 p-5">
        <h2 className="text-lg font-bold">
          {t('order.void')}: {line.name}
        </h2>
        <p className="text-sm text-slate-600">{t('order.needReason')}</p>
        <input
          className="input"
          autoFocus
          placeholder={t('order.voidReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-danger flex-1"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onSubmit(reason.trim())}
          >
            {t('order.void')}
          </button>
        </div>
      </div>
    </div>
  );
}
