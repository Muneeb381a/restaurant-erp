import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Modal as SharedModal } from '../../components/Modal';
import { ApiError, api } from '../../lib/api';
import { Avatar } from '../shell/Shell';
import { formatRs, ltr, parseRs } from '../../lib/money';
import {
  can,
  useKhataAccount,
  useKhataAccounts,
  useMe,
  usePaymentMethods,
} from '../../lib/queries';

/** Khata accounts: who owes what, create accounts (managers), open one for its ledger. */
export function KhataPage() {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [owing, setOwing] = useState(false);
  const [creating, setCreating] = useState(false);
  const list = useKhataAccounts(search, owing);

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
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
              <th className="num">{t('khata.limit')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((a) => {
              const used =
                a.creditLimitPaisa > 0
                  ? Math.min(100, (Math.max(a.balancePaisa, 0) / a.creditLimitPaisa) * 100)
                  : 0;
              return (
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
                  <td className="w-40">
                    <div
                      className="h-2 overflow-hidden rounded-full bg-slate-200"
                      role="img"
                      aria-label={`${Math.round(used)}%`}
                    >
                      <div
                        className={`h-full rounded-full ${used >= 90 ? 'bg-rose-600' : used >= 70 ? 'bg-amber-500' : 'bg-emerald-600'}`}
                        style={{ width: `${used}%` }}
                      />
                    </div>
                  </td>
                  <td className="num !text-slate-600">{ltr(formatRs(a.creditLimitPaisa))}</td>
                </tr>
              );
            })}
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

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SharedModal title={title} size="sm" dismissible={false} onClose={() => undefined}>
      <div className="space-y-3">{children}</div>
    </SharedModal>
  );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
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
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.error')),
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

/** One account: balance, ledger, receive a payment, (managers) adjust, change the limit, switch off. */
export function KhataDetail() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const acct = useKhataAccount(id);
  const methods = usePaymentMethods();
  const [panel, setPanel] = useState<'none' | 'receive' | 'adjust' | 'limit'>('none');
  const [message, setMessage] = useState<string | null>(null);
  const [methodId, setMethodId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [direction, setDirection] = useState<'UP' | 'DOWN'>('UP');
  const [limit, setLimit] = useState('');
  const key = useRef(`khata-${crypto.randomUUID()}`);

  const refresh = async (msg: string): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['khata'] });
    setPanel('none');
    setAmount('');
    setReference('');
    setReason('');
    key.current = `khata-${crypto.randomUUID()}`;
    setMessage(msg);
  };
  const fail = (e: unknown): void => {
    if (e instanceof ApiError && e.code === 'KHATA_OVERPAYMENT') setMessage(t('khata.overpay'));
    else if (e instanceof ApiError && e.code === 'SHIFT_NOT_OPEN') setMessage(t('bill.noShift'));
    else setMessage(e instanceof ApiError ? e.message : t('common.error'));
  };

  const receive = useMutation({
    mutationFn: () =>
      api(`/khata/accounts/${id}/payments`, {
        method: 'POST',
        body: {
          methodId,
          amountPaisa: parseRs(amount) ?? 0,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: () => refresh(t('khata.saved')),
    onError: fail,
  });
  const adjust = useMutation({
    mutationFn: () =>
      api(`/khata/accounts/${id}/adjustments`, {
        method: 'POST',
        body: { direction, amountPaisa: parseRs(amount) ?? 0, reason: reason.trim() },
      }),
    onSuccess: () => refresh(t('khata.saved')),
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/khata/accounts/${id}`, { method: 'PATCH', body }),
    onSuccess: () => refresh(t('khata.saved')),
    onError: fail,
  });

  if (acct.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (acct.isError || !acct.data) return <p className="p-4 text-rose-700">{t('common.error')}</p>;
  const a = acct.data;
  const payMethods = (methods.data ?? []).filter((m) => m.code !== 'KHATA');
  const chosen = payMethods.find((m) => m.id === methodId);
  const manager = can(me.data, 'customer.manage');

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Link to="/khata" className="btn-quiet px-2" aria-label={t('common.back')}>
          <Icon name="chevronLeft" data-flip />
        </Link>
        <Avatar name={a.name} size={40} />
        <h1 className="page-title me-auto">
          {a.name}
          {!a.isActive && (
            <span className="ms-2 rounded bg-slate-200 px-1 text-xs">{t('khata.inactive')}</span>
          )}
        </h1>
      </div>
      <div className="card grid grid-cols-3 gap-2 p-4 text-start">
        <div>
          <div className="micro">{t('khata.owes')}</div>
          <div className="text-2xl font-bold" data-testid="khata-balance">
            {ltr(formatRs(a.balancePaisa))}
          </div>
        </div>
        <div>
          <div className="micro">{t('khata.limit')}</div>
          <div className="text-xl">{ltr(formatRs(a.creditLimitPaisa))}</div>
        </div>
        <div>
          <div className="micro">{t('khata.available')}</div>
          <div className="text-xl">{ltr(formatRs(a.availableCreditPaisa))}</div>
        </div>
      </div>

      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
          {message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          className="btn-primary"
          disabled={a.balancePaisa <= 0}
          onClick={() => {
            setMessage(null);
            setPanel('receive');
            setMethodId(payMethods[0]?.id ?? '');
          }}
        >
          {t('khata.receive')}
        </button>
        {manager && (
          <>
            <button
              className="btn-secondary"
              onClick={() => {
                setMessage(null);
                setPanel('adjust');
              }}
            >
              {t('khata.adjust')}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setMessage(null);
                setLimit(String(a.creditLimitPaisa / 100));
                setPanel('limit');
              }}
            >
              {t('khata.editLimit')}
            </button>
            <button
              className="btn-secondary"
              onClick={() => patch.mutate({ isActive: !a.isActive })}
            >
              {a.isActive ? t('khata.switchOff') : t('khata.switchOn')}
            </button>
          </>
        )}
      </div>

      {panel === 'receive' && (
        <div className="card space-y-2 p-3">
          <div className="flex flex-wrap gap-2">
            {payMethods.map((m) => (
              <button
                key={m.id}
                className={methodId === m.id ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setMethodId(m.id)}
              >
                {m.name}
              </button>
            ))}
          </div>
          <input
            className="input"
            inputMode="decimal"
            placeholder={t('khata.amount')}
            aria-label={t('khata.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {chosen?.needs_reference && (
            <input
              className="input"
              placeholder={t('khata.reference')}
              aria-label={t('khata.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          )}
          <button
            className="btn-primary w-full"
            disabled={
              receive.isPending ||
              !chosen ||
              (parseRs(amount) ?? 0) <= 0 ||
              (!!chosen.needs_reference && !reference.trim())
            }
            onClick={() => receive.mutate()}
          >
            {t('khata.save')}
          </button>
        </div>
      )}
      {panel === 'adjust' && (
        <div className="card space-y-2 p-3">
          <div className="flex gap-2">
            <button
              className={direction === 'UP' ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
              onClick={() => setDirection('UP')}
            >
              {t('khata.up')}
            </button>
            <button
              className={direction === 'DOWN' ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
              onClick={() => setDirection('DOWN')}
            >
              {t('khata.down')}
            </button>
          </div>
          <input
            className="input"
            inputMode="decimal"
            placeholder={t('khata.amount')}
            aria-label={t('khata.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className="input"
            placeholder={t('khata.reason')}
            aria-label={t('khata.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="btn-primary w-full"
            disabled={adjust.isPending || (parseRs(amount) ?? 0) <= 0 || reason.trim().length < 3}
            onClick={() => adjust.mutate()}
          >
            {t('khata.save')}
          </button>
        </div>
      )}
      {panel === 'limit' && (
        <div className="card space-y-2 p-3">
          <input
            className="input"
            inputMode="decimal"
            aria-label={t('khata.creditLimit')}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
          <button
            className="btn-primary w-full"
            disabled={patch.isPending || parseRs(limit) === null}
            onClick={() => patch.mutate({ creditLimitPaisa: parseRs(limit) ?? 0 })}
          >
            {t('khata.save')}
          </button>
        </div>
      )}

      <h2 className="text-lg font-semibold">{t('khata.ledger')}</h2>
      <div className="dt">
        <table className="min-w-[32rem]">
          <thead>
            <tr>
              <th>{t('khata.when')}</th>
              <th>{t('khata.what')}</th>
              <th className="num">{t('khata.change')}</th>
            </tr>
          </thead>
          <tbody>
            {a.entries.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap text-slate-700">
                  {ltr(new Date(e.createdAt).toLocaleString())}
                </td>
                <td>
                  <span className="font-medium">{t(`khata.kind.${e.kind}`)}</span>
                  {e.billNo !== null && (
                    <span className="ms-2 text-slate-600">{ltr(`#${e.billNo}`)}</span>
                  )}
                  {e.method && <span className="chip-mute ms-2">{e.method}</span>}
                  <span className="sub">
                    {e.by}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                </td>
                <td
                  className={`num font-semibold ${e.deltaPaisa > 0 ? '!text-rose-700' : '!text-emerald-700'}`}
                >
                  {ltr(`${e.deltaPaisa > 0 ? '+' : '−'}${formatRs(Math.abs(e.deltaPaisa))}`)}
                </td>
              </tr>
            ))}
            {a.entries.length === 0 && (
              <tr>
                <td colSpan={3} className="!py-8 text-center text-slate-600">
                  {t('khata.noEntries')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
