import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader } from '../../components/Loader';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import {
  platformApi,
  type AuditEntry,
  type ServerError,
  type Tenant,
  type TenantHealth,
} from '../../lib/platform-api';
import { Credentials } from './NewTenantDialog';
import { formatBytes, Stat, StatusChip } from './parts';

type Action = 'edit' | 'suspend' | 'archive' | 'reset' | null;

/** One restaurant: who it is, whether it is healthy, and the few things the platform admin may do to it. */
export function TenantDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [action, setAction] = useState<Action>(null);
  const [credentials, setCredentials] = useState<{ username: string; password: string } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const tenant = useQuery({
    queryKey: ['platform', 'tenant', id],
    queryFn: () => platformApi<Tenant>(`/tenants/${id}`),
  });
  const health = useQuery({
    queryKey: ['platform', 'health', id],
    queryFn: () => platformApi<TenantHealth>(`/tenants/${id}/health`),
    enabled: tenant.data?.status === 'ACTIVE' || tenant.data?.status === 'SUSPENDED',
  });
  const trail = useQuery({
    queryKey: ['platform', 'audit', id],
    queryFn: async () =>
      (await platformApi<{ items: AuditEntry[] }>(`/audit?tenantId=${id}&limit=30`)).items,
  });

  const errors = useQuery({
    queryKey: ['platform', 'errors', id],
    queryFn: async () =>
      (await platformApi<{ items: ServerError[] }>(`/errors?tenantId=${id}&hours=24`)).items,
  });

  const refresh = async (msg?: string): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['platform'] });
    setAction(null);
    if (msg) setMessage(msg);
  };
  const fail = (e: unknown): void => {
    setAction(null);
    setMessage(e instanceof ApiError ? e.message : t('common.error'));
  };

  const run = useMutation({
    mutationFn: (p: { path: string; body?: unknown }) =>
      platformApi<unknown>(`/tenants/${id}/${p.path}`, { method: 'POST', body: p.body ?? {} }),
    onSuccess: async (out, p) => {
      if (p.path === 'reset-owner') {
        const r = out as { username: string; temporaryPassword: string };
        setCredentials({ username: r.username, password: r.temporaryPassword });
      } else if (p.path === 'retry') {
        const r = out as { owner: { username: string; temporaryPassword: string } };
        setCredentials({ username: r.owner.username, password: r.owner.temporaryPassword });
      }
      await refresh(
        p.path === 'migrate'
          ? t('platform.updated', { n: (out as { applied: string[] }).applied.length })
          : undefined,
      );
    },
    onError: fail,
  });

  if (tenant.isPending) return <Loader />;
  if (tenant.isError || !tenant.data)
    return <p className="p-6 text-rose-700">{t('common.error')}</p>;
  const x = tenant.data;
  const live = x.status === 'ACTIVE';
  const h = health.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="btn-quiet -ms-2 px-2" aria-label={t('common.back')}>
          <Icon name="chevronLeft" data-flip />
        </Link>
        <div className="me-auto min-w-0">
          <h1 className="page-title flex flex-wrap items-center gap-3">
            {x.name} <StatusChip status={x.status} />
          </h1>
          <p className="hint" dir="ltr">
            /r/{x.slug}
          </p>
        </div>
        {live && (
          <a className="btn-primary" href={`/r/${x.slug}`} target="_blank" rel="noreferrer">
            {t('platform.open')}
          </a>
        )}
      </div>

      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-900">
          {message}
        </p>
      )}
      {x.status === 'SUSPENDED' && x.suspendedReason && (
        <p className="rounded-lg bg-amber-50 p-3 text-amber-900">
          {t('platform.suspendedBecause', { reason: x.suspendedReason })}
        </p>
      )}
      {(x.status === 'FAILED' || x.status === 'PROVISIONING') && (
        <div className="space-y-2 rounded-xl border border-rose-300 bg-rose-50 p-4 text-rose-900">
          <div className="font-semibold">
            {x.status === 'FAILED' ? t('platform.failedTitle') : t('platform.provisioningTitle')}
          </div>
          {x.lastError && <p className="text-sm">{x.lastError}</p>}
          <p className="text-sm">{t('platform.retryHint')}</p>
          <button
            className="btn-primary"
            disabled={run.isPending}
            onClick={() => run.mutate({ path: 'retry' })}
          >
            {run.isPending ? t('platform.creating') : t('platform.retry')}
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card space-y-3 p-4 lg:col-span-2">
          <h2 className="text-base font-semibold">{t('platform.details')}</h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Info label={t('platform.owner')} value={`${x.ownerName} (${x.ownerUsername})`} />
            <Info label={t('platform.phone')} value={x.contactPhone ?? '–'} ltr />
            <Info label={t('platform.plan')} value={x.plan} />
            <Info
              label={t('platform.database')}
              value={`${x.provider === 'NEON' ? 'Neon' : t('platform.localDb')}${x.region ? ` · ${x.region}` : ''}`}
            />
            <Info label={t('platform.createdOn')} value={new Date(x.createdAt).toLocaleString()} />
            <Info
              label={t('platform.activatedOn')}
              value={x.activatedAt ? new Date(x.activatedAt).toLocaleString() : '–'}
            />
            {x.notes && <Info label={t('platform.notes')} value={x.notes} wide />}
          </dl>
          <button className="btn-secondary" onClick={() => setAction('edit')}>
            {t('platform.edit')}
          </button>
        </section>

        <section className="card space-y-3 p-4">
          <div className="flex items-center gap-2">
            <h2 className="me-auto text-base font-semibold">{t('platform.health')}</h2>
            <button
              className="btn-quiet px-2 text-sm"
              disabled={health.isFetching || !(live || x.status === 'SUSPENDED')}
              onClick={() => void health.refetch()}
            >
              {t('platform.checkNow')}
            </button>
          </div>
          {!h && <p className="hint">{health.isFetching ? <Loader size="sm" inline /> : '–'}</p>}
          {h && (
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label={t('platform.reachable')}
                value={h.reachable ? t('platform.yes') : t('platform.no')}
                sub={h.latencyMs !== null ? `${h.latencyMs} ms` : (h.error ?? '')}
              />
              <Stat label={t('platform.size')} value={formatBytes(h.databaseBytes)} />
              <div className="col-span-2">
                <Stat
                  label={t('platform.version')}
                  value={
                    h.migrations.upToDate
                      ? t('platform.upToDate')
                      : t('platform.behind', {
                          n: h.migrations.available - h.migrations.applied,
                        })
                  }
                  sub={`${h.migrations.applied}/${h.migrations.available}`}
                />
              </div>
            </div>
          )}
          {h && !h.migrations.upToDate && (
            <button
              className="btn-secondary w-full"
              disabled={run.isPending}
              onClick={() => run.mutate({ path: 'migrate' })}
            >
              {t('platform.runUpdates')}
            </button>
          )}
          <p className="hint">{t('platform.healthHint')}</p>
        </section>
      </div>

      {(live || x.status === 'SUSPENDED') && (
        <section className="card divide-y divide-slate-200">
          <h2 className="px-4 py-3 text-base font-semibold">{t('platform.manage')}</h2>
          <Row
            title={t('platform.resetOwner')}
            hint={t('platform.resetOwnerHint')}
            button={
              <button className="btn-secondary" onClick={() => setAction('reset')}>
                {t('platform.reset')}
              </button>
            }
          />
          {live ? (
            <Row
              title={t('platform.suspend')}
              hint={t('platform.suspendHint')}
              button={
                <button className="btn-danger-quiet" onClick={() => setAction('suspend')}>
                  {t('platform.suspend')}
                </button>
              }
            />
          ) : (
            <Row
              title={t('platform.activate')}
              hint={t('platform.activateHint')}
              button={
                <button
                  className="btn-primary"
                  disabled={run.isPending}
                  onClick={() => run.mutate({ path: 'activate' })}
                >
                  {t('platform.activate')}
                </button>
              }
            />
          )}
          <Row
            title={t('platform.archive')}
            hint={t('platform.archiveHint')}
            button={
              <button className="btn-danger-quiet" onClick={() => setAction('archive')}>
                {t('platform.archive')}
              </button>
            }
          />
        </section>
      )}

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-200 px-4 py-3 text-base font-semibold">
          {t('platform.errors')}
        </h2>
        <p className="hint px-4 pt-2">{t('platform.errorsHint')}</p>
        <div className="dt">
          <table className="min-w-[34rem]">
            <thead>
              <tr>
                <th>{t('platform.errWhen')}</th>
                <th>{t('platform.errWhat')}</th>
                <th>{t('platform.errCode')}</th>
                <th>{t('platform.errId')}</th>
              </tr>
            </thead>
            <tbody>
              {(errors.data ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{new Date(e.at).toLocaleString()}</td>
                  <td dir="ltr">
                    {e.method} {e.route}
                  </td>
                  <td dir="ltr">
                    {e.status} {e.code ?? ''}
                  </td>
                  <td dir="ltr" className="text-slate-600">
                    {e.requestId ?? '–'}
                  </td>
                </tr>
              ))}
              {errors.isSuccess && errors.data.length === 0 && (
                <tr>
                  <td colSpan={4} className="!py-6 text-center text-slate-600">
                    {t('platform.errorsNone')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-200 px-4 py-3 text-base font-semibold">
          {t('platform.activity')}
        </h2>
        <ul className="divide-y divide-slate-200 text-sm">
          {(trail.data ?? []).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2.5">
              <span className="font-medium">{t(`platform.action.${e.action}`, e.action)}</span>
              <span className="text-slate-600">{e.admin ?? '–'}</span>
              <span className="ms-auto text-slate-600">{new Date(e.at).toLocaleString()}</span>
            </li>
          ))}
          {trail.isSuccess && trail.data.length === 0 && (
            <li className="px-4 py-6 text-center text-slate-600">–</li>
          )}
        </ul>
      </section>

      {action === 'suspend' && (
        <ReasonDialog
          title={t('platform.suspend')}
          busy={run.isPending}
          onClose={() => setAction(null)}
          onSave={(reason) => run.mutate({ path: 'suspend', body: { reason } })}
        />
      )}
      {action === 'archive' && (
        <ConfirmDialog
          title={t('platform.archive')}
          text={t('platform.archiveConfirm', { name: x.name })}
          confirm={t('platform.archive')}
          busy={run.isPending}
          onClose={() => setAction(null)}
          onConfirm={() => run.mutate({ path: 'archive' })}
        />
      )}
      {action === 'reset' && (
        <ConfirmDialog
          title={t('platform.resetOwner')}
          text={t('platform.resetConfirm', { owner: x.ownerUsername })}
          confirm={t('platform.reset')}
          busy={run.isPending}
          onClose={() => setAction(null)}
          onConfirm={() => run.mutate({ path: 'reset-owner' })}
        />
      )}
      {action === 'edit' && (
        <EditDialog
          tenant={x}
          onClose={() => setAction(null)}
          onDone={() => void refresh(t('platform.saved'))}
        />
      )}
      {credentials && (
        <Modal
          title={t('platform.newPasswordFor', { name: x.name })}
          size="md"
          dismissible={false}
          onClose={() => undefined}
          footer={
            <button className="btn-primary" onClick={() => setCredentials(null)}>
              {t('platform.iSaved')}
            </button>
          }
        >
          <Credentials
            name={x.name}
            slug={x.slug}
            username={credentials.username}
            password={credentials.password}
          />
        </Modal>
      )}
    </div>
  );
}

function Info({
  label,
  value,
  ltr,
  wide,
}: {
  label: string;
  value: string;
  ltr?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="micro">{label}</dt>
      <dd dir={ltr ? 'ltr' : undefined} className="font-medium">
        {value}
      </dd>
    </div>
  );
}

function Row({ title, hint, button }: { title: string; hint: string; button: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-60">
        <div className="font-medium">{title}</div>
        <p className="hint">{hint}</p>
      </div>
      {button}
    </div>
  );
}

function ConfirmDialog(p: {
  title: string;
  text: string;
  confirm: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      title={p.title}
      size="sm"
      onClose={p.onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={p.onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-danger" disabled={p.busy} onClick={p.onConfirm}>
            {p.confirm}
          </button>
        </>
      }
    >
      <p>{p.text}</p>
    </Modal>
  );
}

function ReasonDialog(p: {
  title: string;
  busy: boolean;
  onClose: () => void;
  onSave: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={p.title}
      size="sm"
      onClose={p.onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={p.onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-danger"
            disabled={p.busy || reason.trim().length < 3}
            onClick={() => p.onSave(reason.trim())}
          >
            {p.title}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-700">{t('platform.suspendWarn')}</p>
        <input
          className="input"
          placeholder={t('platform.reason')}
          aria-label={t('platform.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
      </div>
    </Modal>
  );
}

function EditDialog({
  tenant,
  onClose,
  onDone,
}: {
  tenant: Tenant;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(tenant.name);
  const [plan, setPlan] = useState(tenant.plan);
  const [phone, setPhone] = useState(tenant.contactPhone ?? '');
  const [notes, setNotes] = useState(tenant.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      platformApi(`/tenants/${tenant.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          plan: plan.trim(),
          contactPhone: phone.trim() || null,
          notes: notes.trim() || null,
        },
      }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.error')),
  });
  return (
    <Modal
      title={t('platform.edit')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || name.trim().length < 2 || !plan.trim()}
            onClick={() => save.mutate()}
          >
            {t('platform.save')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="label">{t('platform.restaurantName')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('platform.plan')}</span>
          <input className="input" value={plan} onChange={(e) => setPlan(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('platform.phone')}</span>
          <input
            className="input"
            dir="ltr"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('platform.notes')}</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
