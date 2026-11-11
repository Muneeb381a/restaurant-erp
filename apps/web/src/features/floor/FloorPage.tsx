import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { can, useCounterOrders, useDay, useFloor, useMe, useShift } from '../../lib/queries';
import type { FloorTable, Order } from '../../lib/types';

type Filter = 'ALL' | FloorTable['status'];

const minutesSince = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

/** Tiles differ by shape and text as well as colour: free = plain, busy = amber bar, bill ready = filled. */
const TILE: Record<FloorTable['status'], string> = {
  FREE: 'border-slate-300 bg-white text-slate-900 hover:border-slate-500',
  OCCUPIED:
    'border-slate-300 border-s-[6px] border-s-amber-400 bg-amber-50 text-slate-900 hover:border-amber-500',
  BILLED: 'border-sky-700 bg-sky-600 text-white hover:bg-sky-700',
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
  const [error, setError] = useState<string | null>(null);
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
  const filters: { key: Filter; label: string; n: number }[] = [
    { key: 'ALL', label: t('common.all'), n: all.length },
    { key: 'FREE', label: t('floor.free'), n: count('FREE') },
    { key: 'OCCUPIED', label: t('floor.occupied'), n: count('OCCUPIED') },
    { key: 'BILLED', label: t('floor.billed'), n: count('BILLED') },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="page-title me-auto">{t('floor.title')}</h1>
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
      {!dayClosed && day.data && shift.isSuccess && !shift.data && (
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
                className={`flex min-h-28 flex-col items-start justify-between rounded-xl border p-3 text-start transition-colors disabled:opacity-50 ${TILE[table.status]}`}
              >
                <span className="flex w-full items-start justify-between gap-1">
                  <span className="text-2xl font-semibold">{ltr(table.code)}</span>
                  {table.order?.held && (
                    <span className="chip-warn">
                      <Icon name="pause" size={12} /> {t('order.held')}
                    </span>
                  )}
                </span>
                {table.order ? (
                  <span className="text-sm">
                    <span className="block font-semibold">
                      {table.status === 'BILLED' ? t('floor.billReady') : statusLabel(table.status)}{' '}
                      · {t('floor.minAgo', { count: minutesSince(table.order.openedAt) })}
                    </span>
                    <span className="money block text-lg font-semibold">
                      {ltr(formatRs(table.order.subtotalPaisa))}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-slate-600">
                    {statusLabel(table.status)} · {t('floor.seats', { count: table.seats })}
                  </span>
                )}
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
                      {t('floor.minAgo', { count: minutesSince(o.openedAt) })}
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
