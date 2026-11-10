import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { useDay, useFloor } from '../../lib/queries';
import type { FloorTable, Order } from '../../lib/types';

const COLORS: Record<FloorTable['status'], string> = {
  FREE: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  OCCUPIED: 'border-amber-400 bg-amber-50 text-amber-900',
  BILLED: 'border-sky-400 bg-sky-50 text-sky-900',
};

export function FloorPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const floor = useFloor();
  const day = useDay();
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: { type: Order['type']; tableId?: string }) =>
      api<Order>('/orders', { method: 'POST', body }),
    onSuccess: (order) => {
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

  const areaName = (id: string | null): string =>
    floor.data?.areas.find((a) => a.id === id)?.name ?? '';
  const groups = new Map<string, FloorTable[]>();
  for (const table of floor.data?.tables ?? []) {
    const key = areaName(table.areaId);
    groups.set(key, [...(groups.get(key) ?? []), table]);
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">{t('floor.title')}</h1>
        <button
          className="btn-primary"
          disabled={dayClosed || create.isPending}
          onClick={() => create.mutate({ type: 'TAKEAWAY' })}
        >
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
        <p className="rounded-lg bg-amber-100 p-3 text-amber-900">{t('floor.noDay')}</p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700">
          {error}
        </p>
      )}
      {floor.isPending && <p>{t('common.loading')}</p>}

      {[...groups.entries()].map(([area, tables]) => (
        <section key={area} className="space-y-2">
          {area && <h2 className="text-lg font-semibold text-slate-600">{area}</h2>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {tables.map((table) => (
              <button
                key={table.id}
                // cached data from before this visit may be out of date (a table just paid and freed):
                // only fresh data can be tapped
                disabled={dayClosed || create.isPending || !floor.isFetchedAfterMount}
                onClick={() => open(table)}
                className={`flex min-h-28 flex-col items-start justify-between rounded-xl border-2 p-3 text-start transition active:scale-95 disabled:opacity-50 ${COLORS[table.status]}`}
              >
                <span className="text-2xl font-bold">{ltr(table.code)}</span>
                <span className="text-sm font-medium">{statusLabel(table.status)}</span>
                {table.order ? (
                  <span className="text-sm">
                    {ltr(`#${table.order.orderNo}`)} ·{' '}
                    {t('floor.items', { count: table.order.itemCount })}
                    <br />
                    {ltr(formatRs(table.order.subtotalPaisa))}
                    {table.order.held ? ' ⏸' : ''}
                  </span>
                ) : (
                  <span className="text-sm text-slate-500">
                    {t('floor.seats', { count: table.seats })}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
