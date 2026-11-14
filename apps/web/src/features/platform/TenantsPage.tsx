import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { platformApi, type Tenant, type TenantStatus } from '../../lib/platform-api';
import { PageHead } from '../admin/ui';
import { NewTenantDialog } from './NewTenantDialog';
import { StatusChip } from './parts';

const FILTERS: (TenantStatus | 'ALL')[] = ['ALL', 'ACTIVE', 'SUSPENDED', 'FAILED', 'ARCHIVED'];

/** Every restaurant on the platform, newest first, with the one thing each needs from you. */
export function TenantsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: async () => (await platformApi<{ items: Tenant[] }>('/tenants')).items,
  });
  const all = list.data ?? [];
  const count = (s: (typeof FILTERS)[number]): number =>
    s === 'ALL' ? all.length : all.filter((x) => x.status === s).length;
  const q = search.trim().toLowerCase();
  const shown = all.filter(
    (x) =>
      (filter === 'ALL' || x.status === filter) &&
      (!q || x.name.toLowerCase().includes(q) || x.slug.includes(q)),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <PageHead title={t('platform.restaurants')} hint={t('platform.restaurantsHint')}>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={18} />
          {t('platform.new')}
        </button>
      </PageHead>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('platform.search')}
            aria-label={t('platform.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div
          className="seg max-w-full overflow-x-auto"
          role="group"
          aria-label={t('platform.status.label')}
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              className="seg-item shrink-0 whitespace-nowrap"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'ALL' ? t('platform.all') : t(`platform.status.${f}`)} {count(f)}
            </button>
          ))}
        </div>
      </div>

      <div className="dt">
        <table className="min-w-[34rem]">
          <thead>
            <tr>
              <th>{t('platform.restaurant')}</th>
              <th>{t('platform.status.label')}</th>
              <th>{t('platform.owner')}</th>
              <th>{t('platform.createdOn')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.id}>
                <td>
                  <Link to={`/restaurants/${x.id}`} className="name">
                    {x.name}
                    <span className="sub" dir="ltr">
                      /r/{x.slug}
                    </span>
                  </Link>
                </td>
                <td>
                  <StatusChip status={x.status} />
                </td>
                <td>
                  {x.ownerName}
                  <span className="sub">{x.contactPhone ?? ''}</span>
                </td>
                <td className="whitespace-nowrap text-slate-700">
                  {new Date(x.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {list.isSuccess && shown.length === 0 && (
              <tr>
                <td colSpan={4} className="!py-10 text-center text-slate-600">
                  {all.length === 0 ? t('platform.noneYet') : t('platform.noMatch')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {list.isError && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700">
          {t('common.error')}
        </p>
      )}
      {creating && (
        <NewTenantDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['platform'] });
          }}
        />
      )}
    </div>
  );
}
