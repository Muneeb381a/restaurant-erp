import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Modal as SharedModal } from '../../components/Modal';
import { api } from '../../lib/api';
import { Avatar } from '../shell/Shell';
import { formatRs, ltr, parseRs } from '../../lib/money';
import { can, useKhataAccounts, useKhataSummary, useMe } from '../../lib/queries';
import { AgeChip, rs, UsageBar, useExplain } from './parts';

function SumCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: 'book' | 'user' | 'alert';
  label: string;
  value: string;
  sub: string;
  tone?: 'warn';
}) {
  return (
    <div className="card flex items-center gap-4 p-4">
      <span
        className={`flex size-11 shrink-0 items-center justify-center rounded-xl text-white ${tone === 'warn' ? 'bg-amber-500' : 'bg-slate-900'}`}
      >
        <Icon name={icon} size={22} />
      </span>
      <div className="min-w-0">
        <div className="micro">{label}</div>
        <div className="money truncate text-2xl font-semibold tracking-tight">{value}</div>
        <div className="truncate text-xs text-slate-600">{sub}</div>
      </div>
    </div>
  );
}

/** Khata accounts: who owes what and since when, create accounts (managers), open one for its ledger. */
export function KhataPage() {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [owing, setOwing] = useState(false);
  const [sort, setSort] = useState<'owed' | 'name'>('owed');
  const [creating, setCreating] = useState(false);
  const list = useKhataAccounts(search, owing, sort);
  const sum = useKhataSummary();

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="me-auto">
          <h1 className="page-title">{t('khata.title')}</h1>
          <p className="hint max-w-xl">{t('khata.hint')}</p>
        </div>
        {can(me.data, 'customer.manage') && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            {t('khata.newAccount')}
          </button>
        )}
      </div>

      {sum.data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <SumCard
            icon="book"
            label={t('khata.sumOwed')}
            value={rs(sum.data.owedPaisa)}
            sub={t('khata.sumOwedSub')}
          />
          <SumCard
            icon="user"
            label={t('khata.sumOwing')}
            value={ltr(String(sum.data.accountsOwing))}
            sub={t('khata.sumOwingSub', { n: sum.data.accounts })}
          />
          <SumCard
            icon="alert"
            tone={sum.data.nearLimit > 0 ? 'warn' : undefined}
            label={t('khata.sumNear')}
            value={ltr(String(sum.data.nearLimit))}
            sub={t('khata.sumNearSub')}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('khata.search')}
            aria-label={t('khata.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="seg" role="group" aria-label={t('khata.sortLabel')}>
          {(
            [
              ['owed', t('khata.sortOwed')],
              ['name', t('khata.sortName')],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className="seg-item"
              aria-pressed={sort === k}
              onClick={() => setSort(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="seg-item border border-slate-400 bg-white"
          aria-pressed={owing}
          onClick={() => setOwing(!owing)}
        >
          {t('khata.onlyOwing')}
        </button>
      </div>

      <div className="dt">
        <table className="min-w-[36rem]">
          <thead>
            <tr>
              <th>{t('khata.customer')}</th>
              <th className="num">{t('khata.owes')}</th>
              <th>{t('khata.usage')}</th>
              <th>{t('khata.owingFor')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((a) => (
              <tr key={a.id} className={a.isActive ? '' : 'opacity-60'}>
                <td>
                  <Link to={`/khata/${a.id}`} className="flex items-center gap-3">
                    <Avatar name={a.name} size={36} />
                    <span className="name">
                      {a.name}
                      <span className="sub">
                        {a.phone ? ltr(a.phone) : ''}
                        {!a.isActive ? ` · ${t('khata.inactive')}` : ''}
                      </span>
                    </span>
                  </Link>
                </td>
                <td
                  className={`num font-semibold ${a.balancePaisa > 0 ? '!text-rose-700' : '!text-slate-500'}`}
                >
                  {ltr(formatRs(a.balancePaisa))}
                </td>
                <td className="w-52">
                  <UsageBar a={a} />
                </td>
                <td>
                  <AgeChip a={a} />
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="!py-10 text-center text-slate-600">
                  {t('khata.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['khata'] });
          }}
        />
      )}
    </div>
  );
}

function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SharedModal title={title} size="sm" dismissible={false} onClose={() => undefined}>
      <div className="space-y-3">{children}</div>
    </SharedModal>
  );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const explain = useExplain();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api('/khata/accounts', {
        method: 'POST',
        body: {
          name: name.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          creditLimitPaisa: parseRs(limit) ?? 0,
        },
      }),
    onSuccess: onDone,
    onError: (e) => setError(explain(e)),
  });
  return (
    <Modal title={t('khata.newAccount')}>
      <input
        className="input"
        placeholder={t('khata.name')}
        aria-label={t('khata.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        className="input"
        placeholder={t('khata.phone')}
        aria-label={t('khata.phone')}
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <input
        className="input"
        inputMode="decimal"
        placeholder={t('khata.creditLimit')}
        aria-label={t('khata.creditLimit')}
        value={limit}
        onChange={(e) => setLimit(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn-secondary flex-1" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn-primary flex-1"
          disabled={!name.trim() || parseRs(limit) === null || create.isPending}
          onClick={() => create.mutate()}
        >
          {t('khata.create')}
        </button>
      </div>
    </Modal>
  );
}
