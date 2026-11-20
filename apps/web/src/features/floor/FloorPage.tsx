import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader } from '../../components/Loader';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetupStatus } from '../admin/SetupAdmin';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { useOutbox } from '../../lib/outbox';
import { can, useCounterOrders, useDay, useFloor, useMe, useShift } from '../../lib/queries';
import { formatAge } from '../../lib/age';
import type { FloorTable, Menu, Order } from '../../lib/types';

type Filter = 'ALL' | FloorTable['status'];

const minutesSince = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

/**
 * A table is drawn as a table: a top surface with chairs around it (as many as it has seats). The state
 * shows three ways: the surface colour, the word on it, and what it carries (amount, time, captain).
 * Free = white with a green rim, occupied = saffron, bill ready = solid blue (the one the cashier looks for).
 */
const TILE: Record<
  FloorTable['status'],
  {
    surface: string;
    chair: string;
    dot: string;
    soft: string;
    chip: string;
    label: string;
    avatar: string;
  }
> = {
  FREE: {
    surface: 'border-2 border-emerald-500 bg-white text-slate-900 group-hover:bg-emerald-50',
    chair: 'bg-slate-300 group-hover:bg-emerald-300',
    dot: 'bg-emerald-600',
    soft: 'text-slate-500',
    chip: 'bg-emerald-100 text-emerald-700',
    label: 'text-emerald-700',
    avatar: 'bg-slate-100 text-slate-700',
  },
  OCCUPIED: {
    surface: 'border-2 border-amber-500 bg-amber-50 text-slate-900',
    chair: 'bg-amber-400',
    dot: 'bg-amber-500',
    soft: 'text-amber-900/70',
    chip: 'bg-amber-100 text-amber-800',
    label: 'text-amber-800',
    avatar: 'bg-amber-100 text-amber-900',
  },
  BILLED: {
    surface: 'border-2 border-sky-900 bg-sky-700 text-white shadow-md',
    chair: 'bg-sky-400',
    dot: 'bg-sky-700',
    soft: 'text-sky-100',
    chip: 'bg-sky-100 text-sky-700',
    label: 'text-sky-100',
    avatar: 'bg-sky-100 text-sky-900',
  },
};

/** Round for a two-seater, a square for four, a long table for more: the shape tells the size at a glance. */
const shapeOf = (seats: number): string =>
  seats <= 2
    ? 'size-32 rounded-full'
    : seats <= 4
      ? 'h-32 w-full max-w-44 rounded-2xl'
      : 'h-32 w-full rounded-2xl';

/** A row of chairs (at most 5 so a big table stays tidy). */
function ChairRow({ n, className }: { n: number; className: string }) {
  return (
    <span className="flex h-2 justify-center gap-2" aria-hidden="true">
      {Array.from({ length: Math.min(5, n) }, (_, i) => (
        <span key={i} className={`h-2 w-7 rounded-full transition-colors ${className}`} />
      ))}
    </span>
  );
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function FloorPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const floor = useFloor();
  const counter = useCounterOrders();
  const day = useDay();
  const me = useMe();
  const shift = useShift();
  const openDay = useMutation({
    mutationFn: () => api('/business-days/open', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['day'] }),
  });
  const setup = useSetupStatus(can(me.data, 'settings.manage'));
  const [error, setError] = useState<string | null>(null);
  const kitchenOnly = can(me.data, 'kitchen.update') && !can(me.data, 'order.create');
  const [filter, setFilter] = useState<Filter>('ALL');

  const create = useMutation({
    mutationFn: async (body: { type: Order['type']; tableId?: string }): Promise<Order> => {
      try {
        return await api<Order>('/orders', { method: 'POST', body });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'OFFLINE') throw e;
        return startOffline(body);
      }
    },
    onSuccess: (order) => {
      void qc.cancelQueries({ queryKey: ['order', order.id] });
      qc.setQueryData(['order', order.id], order);
      void qc.invalidateQueries({ queryKey: ['floor'] });
      nav(`/order/${order.id}`);
    },
    onError: async (e) => {
      // someone just took that table: jump to their order instead of failing
      if (
        e instanceof ApiError &&
        e.code === 'TABLE_OCCUPIED' &&
        typeof e.body.orderId === 'string'
      ) {
        nav(`/order/${e.body.orderId}`);
        return;
      }
      setError(e instanceof ApiError ? e.message : t('common.error'));
    },
  });

  const printBill = useMutation({
    mutationFn: (table: FloorTable) =>
      api<{ token: number; printers: number }>(`/orders/${table.order!.id}/print-bill`, {
        method: 'POST',
        body: {},
        ifMatch: table.order!.version,
        headers: { 'idempotency-key': `ui-${crypto.randomUUID()}` },
      }),
    onSuccess: (out, table) => {
      void qc.invalidateQueries({ queryKey: ['floor'] });
      if (out.printers === 0) {
        nav(`/order/${table.order!.id}/pay`); // no thermal printer: print it from the pay screen
        return;
      }
      toast(t('floor.billPrinted', { table: table.code, token: out.token }));
    },
    onError: (e, table) =>
      setError(
        e instanceof ApiError && e.code === 'UNSENT_ITEMS'
          ? t('floor.sendFirst', { table: table.code })
          : e instanceof ApiError
            ? e.message
            : t('common.error'),
      ),
  });

  /**
   * No internet: the order is made on this device with an id of its own, shown at once, and sent to the server when
   * the connection is back (the token number is given then). Only the day being open is assumed (the cached day).
   */
  function startOffline(body: { type: Order['type']; tableId?: string }): Order {
    const id = crypto.randomUUID();
    const table = floor.data?.tables.find((x) => x.id === body.tableId);
    useOutbox.getState().enqueue({
      orderId: id,
      kind: 'CREATE',
      body: { id, ...body },
      label: table ? table.code : t(body.type === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery'),
      qty: 0,
    });
    toast(t('offline.keptOrder'), 'warn');
    return {
      id,
      orderNo: 0,
      type: body.type,
      status: 'OPEN',
      held: false,
      tableId: body.tableId ?? null,
      tableCode: table?.code ?? null,
      guests: null,
      notes: null,
      version: 1,
      items: [],
      subtotalPaisa: 0,
    };
  }

  // keep every menu on this device while online, so an order can be taken after the internet goes
  useEffect(() => {
    if (!floor.isSuccess) return;
    for (const list of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
      void qc.prefetchQuery({
        queryKey: ['menu', list],
        queryFn: () => api<Menu>(`/menu?priceList=${list}`),
        staleTime: 5 * 60_000,
      });
  }, [floor.isSuccess, qc]);

  const dayClosed = day.isSuccess && !day.data;
  const statusLabel = (s: FloorTable['status']): string => t(`floor.${s.toLowerCase()}`);

  function open(table: FloorTable): void {
    // a table whose bill is printed is waiting for payment: go straight to it
    const queued = useOutbox
      .getState()
      .items.find((c) => c.kind === 'CREATE' && c.body.tableId === table.id);
    if (queued) nav(`/order/${queued.orderId}`);
    else if (table.order)
      nav(table.status === 'BILLED' ? `/order/${table.order.id}/pay` : `/order/${table.order.id}`);
    else create.mutate({ type: 'DINE_IN', tableId: table.id });
  }

  const all = floor.data?.tables ?? [];
  const count = (s: FloorTable['status']): number => all.filter((x) => x.status === s).length;
  const areaName = (id: string | null): string =>
    floor.data?.areas.find((a) => a.id === id)?.name ?? '';
  const groups = new Map<string, FloorTable[]>();
  for (const table of all) {
    if (filter !== 'ALL' && table.status !== filter) continue;
    const key = areaName(table.areaId);
    groups.set(key, [...(groups.get(key) ?? []), table]);
  }
  // a tile that just changed state pulses for a moment, so staff notice a table freeing up or asking for the bill
  const seen = useRef<Map<string, string> | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!floor.data) return;
    const stateOf = (x: FloorTable): string =>
      `${x.status}|${x.order?.ticketsReady ? 'ready' : ''}`;
    const now = new Map(floor.data.tables.map((x) => [x.id, stateOf(x)] as const));
    const prev = seen.current;
    seen.current = now;
    if (!prev) return;
    const changed = floor.data.tables
      .filter((x) => prev.get(x.id) !== undefined && prev.get(x.id) !== stateOf(x))
      .map((x) => x.id);
    if (changed.length === 0) return;
    setFlash(new Set(changed));
    const id = setTimeout(() => setFlash(new Set()), 2400);
    return () => clearTimeout(id);
  }, [floor.data]);

  const openTotal = all.reduce((n, x) => n + (x.order?.subtotalPaisa ?? 0), 0);
  const filters: { key: Filter; label: string; n: number }[] = [
    { key: 'ALL', label: t('common.all'), n: all.length },
    { key: 'FREE', label: t('floor.free'), n: count('FREE') },
    { key: 'OCCUPIED', label: t('floor.occupied'), n: count('OCCUPIED') },
    { key: 'BILLED', label: t('floor.billed'), n: count('BILLED') },
  ];

  if (kitchenOnly && me.isSuccess) return <Navigate to="/kitchen" replace />;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      {setup.data && !setup.data.ready && (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <Icon name="info" size={20} className="text-amber-800" />
          <p className="me-auto min-w-0 text-sm font-medium text-amber-950">
            {t('setup.banner', { done: setup.data.requiredDone, total: setup.data.requiredTotal })}
          </p>
          <Link to="/admin/setup" className="btn-secondary">
            {t('setup.continue')}
          </Link>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="me-auto">
          <h1 className="page-title">{t('floor.title')}</h1>
          <p className="hint">{t('floor.hint')}</p>
        </div>
        <TokenFinder />
        <button
          className="btn-primary"
          disabled={dayClosed || create.isPending}
          onClick={() => create.mutate({ type: 'TAKEAWAY' })}
        >
          <Icon name="bag" size={20} />
          {t('floor.takeaway')}
        </button>
        <button
          className="btn-secondary"
          disabled={dayClosed || create.isPending}
          onClick={() => create.mutate({ type: 'DELIVERY' })}
        >
          {t('floor.delivery')}
        </button>
      </div>

      {dayClosed && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400 bg-amber-50 p-4 text-amber-900">
          <Icon name="info" />
          <div className="me-auto">
            <p className="font-semibold">{t('floor.noDay')}</p>
            <p className="text-sm">{t('floor.noDayHint')}</p>
          </div>
          {can(me.data, 'day.open') && (
            <button
              className="btn-primary"
              disabled={openDay.isPending}
              onClick={() => openDay.mutate()}
            >
              {t('shell.openDay')}
            </button>
          )}
        </div>
      )}
      {!dayClosed && day.data && shift.isSuccess && !shift.data && can(me.data, 'shift.open') && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-400 bg-amber-50 p-4 text-amber-900">
          <Icon name="info" />
          <p className="text-sm font-medium">{t('shell.startShiftHint')}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700">
          {error}
        </p>
      )}
      {floor.isPending && <Loader />}

      {all.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('floor.filter')}
        >
          {filters.map((f) => (
            <button
              key={f.key}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className="inline-flex min-h-touch items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 aria-pressed:border-slate-900 aria-pressed:bg-slate-900 aria-pressed:text-white"
            >
              {f.key !== 'ALL' && (
                <span className={`size-2.5 rounded-full ${TILE[f.key].dot} ring-2 ring-white`} />
              )}
              {f.label}
              <span className="money opacity-70">{f.n}</span>
            </button>
          ))}
          <span className="ms-auto text-sm text-slate-600">
            {t('floor.onTables')}{' '}
            <span className="money font-semibold text-slate-900">{ltr(formatRs(openTotal))}</span>
          </span>
        </div>
      )}

      {[...groups.entries()].map(([area, tables]) => {
        const free = tables.filter((x) => x.status === 'FREE').length;
        const busy = tables.length - free;
        return (
          <section
            key={area}
            className="space-y-4 rounded-2xl border border-slate-200 bg-slate-100/70 p-4 [background-image:radial-gradient(circle,rgba(152,162,179,.35)_1px,transparent_1px)] [background-size:20px_20px] md:p-5"
          >
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                {area || t('floor.otherTables')}
              </h2>
              <span className="chip bg-white text-slate-700 shadow-sm">
                {t('floor.freeOf', { free, total: tables.length })}
              </span>
              <span
                aria-hidden="true"
                className="ms-auto hidden h-1.5 w-32 overflow-hidden rounded-full bg-white sm:block"
              >
                <span
                  className="block h-full rounded-full bg-amber-500"
                  style={{ width: `${tables.length ? (busy / tables.length) * 100 : 0}%` }}
                />
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {tables.map((table) => {
                const tile = TILE[table.status];
                const mins = table.order ? minutesSince(table.order.openedAt) : 0;
                const slow = mins > 90;
                const lateInk =
                  table.status === 'BILLED'
                    ? 'font-bold text-amber-200'
                    : 'font-semibold text-rose-700';
                return (
                  <div key={table.id} className="flex flex-col items-center gap-2">
                    <button
                      // cached data from before this visit may be out of date (a table just paid and freed):
                      // only fresh data can be tapped
                      disabled={dayClosed || create.isPending || !floor.isFetchedAfterMount}
                      onClick={() => open(table)}
                      aria-label={`${table.code} ${statusLabel(table.status)}`}
                      className={`group flex flex-col items-center gap-1.5 rounded-2xl p-1 text-center outline-offset-4 transition disabled:opacity-50 ${flash.has(table.id) ? 'animate-flash' : ''}`}
                    >
                      <ChairRow
                        n={Math.ceil(Math.max(table.seats, 1) / 2)}
                        className={tile.chair}
                      />
                      <span
                        className={`relative flex flex-col items-center justify-center gap-0.5 px-3 transition group-hover:-translate-y-0.5 group-active:translate-y-0 ${shapeOf(table.seats)} ${tile.surface} ${table.order?.ticketsReady ? 'ring-4 ring-emerald-500/60' : ''}`}
                      >
                        <span
                          className={`text-[0.65rem] font-bold uppercase tracking-wider ${tile.label}`}
                        >
                          {table.status === 'BILLED'
                            ? t('floor.billReady')
                            : statusLabel(table.status)}
                        </span>
                        <span className="text-3xl font-semibold leading-none">
                          {ltr(table.code)}
                        </span>
                        {table.order ? (
                          <>
                            <span className="money text-base font-semibold leading-tight">
                              {ltr(formatRs(table.order.subtotalPaisa))}
                            </span>
                            <span
                              className={`flex items-center gap-1 text-xs ${slow ? lateInk : tile.soft}`}
                            >
                              <Icon name="clock" size={12} />
                              {formatAge(mins, t)}
                            </span>
                          </>
                        ) : (
                          <span className={`flex items-center gap-1 text-xs ${tile.soft}`}>
                            <Icon name="user" size={12} />
                            {t('floor.seats', { count: table.seats })}
                          </span>
                        )}
                        {table.order?.ticketsReady ? (
                          <span
                            className="absolute -end-2 -top-2 flex size-7 items-center justify-center rounded-full bg-emerald-600 text-white shadow-md"
                            title={t('floor.foodReady')}
                          >
                            <Icon name="check" size={16} />
                            <span className="sr-only">{t('floor.foodReady')}</span>
                          </span>
                        ) : null}
                        {table.order?.held && (
                          <span className="absolute -start-2 -top-2 flex size-7 items-center justify-center rounded-full bg-slate-700 text-white shadow-md">
                            <Icon name="pause" size={14} />
                            <span className="sr-only">{t('order.held')}</span>
                          </span>
                        )}
                      </span>
                      <ChairRow
                        n={Math.floor(Math.max(table.seats, 1) / 2)}
                        className={tile.chair}
                      />
                      {table.order?.waiterName ? (
                        <span className="flex max-w-full items-center gap-1.5 text-xs text-slate-600">
                          <span
                            aria-hidden="true"
                            className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-bold ${tile.avatar}`}
                          >
                            {initials(table.order.waiterName)}
                          </span>
                          <span className="truncate">{table.order.waiterName}</span>
                        </span>
                      ) : (
                        <span className="h-5" aria-hidden="true" />
                      )}
                    </button>
                    {table.order && !dayClosed && (
                      <div className="flex w-full flex-wrap justify-center gap-1.5">
                        {table.status === 'OCCUPIED' &&
                          table.order.itemCount > 0 &&
                          can(me.data, 'bill.create') && (
                            <button
                              className="btn-secondary min-h-10 px-3 text-sm"
                              disabled={printBill.isPending}
                              onClick={() => printBill.mutate(table)}
                            >
                              <Icon name="printer" size={16} />
                              {t('floor.printBill')}
                            </button>
                          )}
                        {table.status === 'BILLED' && (
                          <>
                            <button
                              className="btn-bill min-h-10 px-3 text-sm"
                              onClick={() => nav(`/order/${table.order!.id}/pay`)}
                            >
                              {t('floor.takePayment')}
                            </button>
                            {can(me.data, 'bill.create') && (
                              <button
                                className="btn-secondary min-h-10 px-3"
                                aria-label={t('floor.printBill')}
                                title={t('floor.printBill')}
                                disabled={printBill.isPending}
                                onClick={() => printBill.mutate(table)}
                              >
                                <Icon name="printer" size={16} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {floor.isSuccess && groups.size === 0 && (
        <p className="p-6 text-center text-slate-600">{t('floor.noTables')}</p>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-900">{t('floor.counterTitle')}</h2>
          <span className="chip-mute">{(counter.data ?? []).length}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-slate-200" />
        </div>
        {(counter.data ?? []).length === 0 ? (
          <p className="hint">{t('floor.noCounter')}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(counter.data ?? []).map((o) => (
              <li key={o.id}>
                <Link
                  to={`/order/${o.id}`}
                  className={`card flex min-h-touch items-center gap-3 border-s-4 p-3 transition-shadow hover:shadow-md ${o.status === 'BILLED' ? 'border-s-sky-600' : 'border-s-amber-500'}`}
                >
                  <span
                    className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${o.status === 'BILLED' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'}`}
                  >
                    <Icon name="bag" size={20} />
                  </span>
                  <span className="me-auto min-w-0">
                    <span className="block font-semibold">
                      {t(o.type === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery')}{' '}
                      {t('order.token')} {ltr(String(o.orderNo))}
                    </span>
                    <span className="text-sm text-slate-600">
                      {t('floor.items', { count: o.itemCount })} ·{' '}
                      {formatAge(minutesSince(o.openedAt), t)}
                    </span>
                  </span>
                  <span className="text-end">
                    <span className="money block font-semibold">
                      {ltr(formatRs(o.subtotalPaisa))}
                    </span>
                    <span className={o.status === 'BILLED' ? 'chip-info' : 'chip-warn'}>
                      {o.status === 'BILLED' ? t('floor.billReady') : t('floor.inProgress')}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The token printed on the kitchen ticket and the bill. The customer comes to the counter holding it: type the
 * number and land on that order (to add, to bill, or to see the paid bill).
 */
function TokenFinder() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const find = useMutation({
    mutationFn: (n: number) =>
      api<{ id: string; status: string; bill: { id: string; status: string } | null }>(
        `/orders/by-token/${n}`,
      ),
    onSuccess: (o) => {
      setProblem(null);
      setValue('');
      // a bill waiting for payment, or a paid one, opens on the payment screen; otherwise the order itself
      nav(o.bill && o.bill.status !== 'VOID' ? `/order/${o.id}/pay` : `/order/${o.id}`);
    },
    onError: (e) =>
      setProblem(
        e instanceof ApiError && e.status === 404 ? t('floor.tokenNotFound') : t('common.error'),
      ),
  });
  const n = Number(value);
  const valid = /^\d{1,5}$/.test(value) && n > 0;
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) find.mutate(n);
      }}
    >
      <label className="sr-only" htmlFor="token-find">
        {t('floor.findToken')}
      </label>
      <input
        id="token-find"
        className="input w-32"
        dir="ltr"
        inputMode="numeric"
        placeholder={t('floor.tokenPlaceholder')}
        value={value}
        onChange={(e) => {
          setValue(e.target.value.replace(/\D/g, '').slice(0, 5));
          setProblem(null);
        }}
      />
      <button type="submit" className="btn-secondary" disabled={!valid || find.isPending}>
        {t('floor.findToken')}
      </button>
      {problem && (
        <span role="alert" className="text-sm font-medium text-rose-700">
          {problem}
        </span>
      )}
    </form>
  );
}
