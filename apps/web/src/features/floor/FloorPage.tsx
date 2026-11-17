import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetupStatus } from '../admin/SetupAdmin';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { can, useCounterOrders, useDay, useFloor, useMe, useShift } from '../../lib/queries';
import { formatAge } from '../../lib/age';
import type { FloorTable, Order } from '../../lib/types';

type Filter = 'ALL' | FloorTable['status'];

const minutesSince = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

/**
 * A table says its state three ways: a coloured band with the word, the tile's border and fill, and
 * what it shows inside (a free table is empty and dashed; a busy one carries amount, time, captain).
 */
const TILE: Record<
  FloorTable['status'],
  { box: string; band: string; dot: string; ink: string; soft: string }
> = {
  // nobody is seated: an empty outline, nothing to read
  FREE: {
    box: 'border-2 border-dashed border-slate-400 bg-transparent hover:border-emerald-600 hover:bg-white',
    band: 'bg-slate-200 text-slate-800',
    dot: 'bg-emerald-600',
    ink: 'text-slate-900',
    soft: 'text-slate-600',
  },
  // seated and ordering: saffron, the colour of "Send to kitchen"
  OCCUPIED: {
    box: 'border-2 border-amber-500 bg-amber-100 hover:bg-amber-200/70',
    band: 'bg-amber-500 text-slate-900',
    dot: 'bg-amber-500',
    ink: 'text-slate-900',
    soft: 'text-amber-950/80',
  },
  // the guest asked for the bill: a solid blue block, the only one on the floor. The cashier looks
  // for blue, and blue is also the colour of the "Bill" button that put it there
  BILLED: {
    box: 'border-2 border-sky-900 bg-sky-700 hover:bg-sky-800',
    band: 'bg-sky-900 text-white',
    dot: 'bg-sky-700',
    ink: 'text-white',
    soft: 'text-sky-100',
  },
};

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
    mutationFn: (body: { type: Order['type']; tableId?: string }) =>
      api<Order>('/orders', { method: 'POST', body }),
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

  const dayClosed = day.isSuccess && !day.data;
  const statusLabel = (s: FloorTable['status']): string => t(`floor.${s.toLowerCase()}`);

  function open(table: FloorTable): void {
    if (table.order) nav(`/order/${table.order.id}`);
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
      {floor.isPending && <p className="text-slate-600">{t('common.loading')}</p>}

      {all.length > 0 && (
        <div className="seg flex-wrap" role="group" aria-label={t('floor.filter')}>
          {filters.map((f) => (
            <button
              key={f.key}
              className="seg-item gap-2"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.key !== 'ALL' && (
                <span className={`size-2.5 rounded-full ring-2 ring-white ${TILE[f.key].dot}`} />
              )}
              {f.label}
              <span className="money opacity-70">{f.n}</span>
            </button>
          ))}
        </div>
      )}

      {[...groups.entries()].map(([area, tables]) => (
        <section key={area} className="space-y-2">
          {area && <h2 className="micro">{area}</h2>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {tables.map((table) => (
              <button
                key={table.id}
                // cached data from before this visit may be out of date (a table just paid and freed):
                // only fresh data can be tapped
                disabled={dayClosed || create.isPending || !floor.isFetchedAfterMount}
                onClick={() => open(table)}
                aria-label={`${table.code} ${statusLabel(table.status)}`}
                className={`flex min-h-32 flex-col overflow-hidden rounded-xl p-0 text-start transition-colors disabled:opacity-50 ${TILE[table.status].box} ${table.order?.ticketsReady ? 'ring-4 ring-emerald-500/70' : ''} ${flash.has(table.id) ? 'animate-flash' : ''}`}
              >
                <span
                  className={`flex w-full items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wide ${TILE[table.status].band}`}
                >
                  <Icon
                    name={
                      table.status === 'BILLED'
                        ? 'receipt'
                        : table.status === 'OCCUPIED'
                          ? 'user'
                          : 'check'
                    }
                    size={14}
                  />
                  {table.status === 'BILLED' ? t('floor.billReady') : statusLabel(table.status)}
                  {table.order?.held && (
                    <span className="ms-auto inline-flex items-center gap-1">
                      <Icon name="pause" size={12} /> {t('order.held')}
                    </span>
                  )}
                </span>
                <span
                  className={`flex flex-1 flex-col justify-between gap-1 p-3 ${TILE[table.status].ink}`}
                >
                  <span className="text-2xl font-semibold">{ltr(table.code)}</span>
                  {table.order ? (
                    <span className="text-sm">
                      <span className="money block text-lg font-semibold">
                        {ltr(formatRs(table.order.subtotalPaisa))}
                      </span>
                      <span
                        className={`flex items-center gap-1 whitespace-nowrap ${minutesSince(table.order.openedAt) > 90 ? (table.status === 'BILLED' ? 'font-bold text-amber-200' : 'font-semibold text-rose-700') : TILE[table.status].soft}`}
                      >
                        <Icon name="clock" size={14} />
                        {formatAge(minutesSince(table.order.openedAt), t)}
                      </span>
                      {table.order.ticketsReady > 0 && (
                        <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">
                          <Icon name="check" size={12} /> {t('floor.foodReady')}
                        </span>
                      )}
                      {table.order.waiterName && (
                        <span className={`block truncate text-xs ${TILE[table.status].soft}`}>
                          {table.order.waiterName}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className={`text-sm ${TILE[table.status].soft}`}>
                      {t('floor.seats', { count: table.seats })}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {floor.isSuccess && groups.size === 0 && (
        <p className="p-6 text-center text-slate-600">{t('floor.noTables')}</p>
      )}

      <section className="space-y-2">
        <h2 className="micro">{t('floor.counterTitle')}</h2>
        {(counter.data ?? []).length === 0 ? (
          <p className="hint">{t('floor.noCounter')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(counter.data ?? []).map((o) => (
              <li key={o.id}>
                <Link
                  to={`/order/${o.id}`}
                  className="card flex min-h-touch items-center gap-3 p-3 hover:border-slate-500"
                >
                  <span className="me-auto">
                    <span className="block font-semibold">
                      {t(o.type === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery')}{' '}
                      {ltr(`#${o.orderNo}`)}
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
