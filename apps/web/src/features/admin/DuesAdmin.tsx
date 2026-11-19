import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { formatRs, parseRs } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import { Dialog, EmptyRow, ErrorText, Field, PageHead } from './ui';

interface Due {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  kind: 'ADVANCE' | 'LOAN' | 'FINE';
  reason: string;
  principalPaisa: number;
  installmentPaisa: number;
  recoveredPaisa: number;
  writtenOffPaisa: number;
  balancePaisa: number;
  installmentsLeft: number | null;
  paused: boolean;
  closed: boolean;
}

const KIND_TONE: Record<Due['kind'], string> = {
  ADVANCE: 'bg-sky-100 text-sky-800',
  LOAN: 'bg-violet-100 text-violet-700',
  FINE: 'bg-rose-100 text-rose-700',
};
const newKey = (): string => `ui-${crypto.randomUUID()}`;

/** What staff owe the restaurant (advances, loans, fines) and how it is taken back from their pay. */
export function DuesAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [writeOff, setWriteOff] = useState<Due | null>(null);
  const list = useQuery({
    queryKey: ['staff-dues', open],
    queryFn: async () => (await api<{ items: Due[] }>(`/staff-dues?open=${open}`)).items,
  });
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['staff-dues'] });
  const pause = useMutation({
    mutationFn: (v: { id: string; paused: boolean }) =>
      api(`/staff-dues/${v.id}`, { method: 'PATCH', body: { paused: v.paused } }),
    onSuccess: refresh,
  });
  const rows = list.data ?? [];
  const total = rows.reduce((n, d) => n + d.balancePaisa, 0);

  return (
    <div className="max-w-6xl space-y-5 p-4 md:p-6">
      <PageHead title={t('dues.title')} hint={t('dues.hint')}>
        {can(me.data, 'payroll.manage') && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            {t('dues.new')}
          </button>
        )}
      </PageHead>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              aria-pressed={open === v}
              onClick={() => setOpen(v)}
              className={`min-h-9 rounded-md px-4 text-sm font-semibold ${open === v ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              {t(v ? 'dues.stillOwed' : 'dues.all')}
            </button>
          ))}
        </div>
        {open && rows.length > 0 && (
          <span className="ms-auto text-sm text-slate-600">
            {t('dues.totalOwed')}: <b dir="ltr">{formatRs(total)}</b>
          </span>
        )}
      </div>
      <ErrorText error={pause.error ?? list.error} />
      <div className="dt">
        <table className="min-w-[52rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              <th>{t('dues.what')}</th>
              <th>{t('dues.given')}</th>
              <th>{t('dues.perRun')}</th>
              <th>{t('dues.balance')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <EmptyRow cols={6} icon="cash" loading={list.isPending} text={t('dues.none')} />
            )}
            {rows.map((d) => {
              const done =
                d.principalPaisa > 0
                  ? Math.round(((d.principalPaisa - d.balancePaisa) / d.principalPaisa) * 100)
                  : 0;
              return (
                <tr key={d.id}>
                  <td>
                    <div className="font-semibold">{d.employeeName}</div>
                    <div className="text-xs text-slate-500">{d.employeeCode}</div>
                  </td>
                  <td>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${KIND_TONE[d.kind]}`}
                    >
                      {t(`dues.kind.${d.kind}`)}
                    </span>
                    <div className="mt-1 text-sm text-slate-600">{d.reason}</div>
                  </td>
                  <td dir="ltr">{formatRs(d.principalPaisa)}</td>
                  <td dir="ltr">
                    {d.installmentPaisa > 0 ? formatRs(d.installmentPaisa) : '–'}
                    {d.installmentsLeft !== null && d.balancePaisa > 0 && (
                      <div className="text-xs text-slate-500">
                        {t('dues.left', { count: d.installmentsLeft })}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="font-bold" dir="ltr">
                      {formatRs(d.balancePaisa)}
                    </div>
                    <div
                      className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-200"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full bg-emerald-500"
                        style={{ width: `${done}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {d.closed
                        ? t('dues.writtenOff')
                        : d.balancePaisa === 0
                          ? t('dues.settled')
                          : d.paused
                            ? t('dues.paused')
                            : `${t('dues.recovered')} ${formatRs(d.recoveredPaisa)}`}
                    </div>
                  </td>
                  <td className="text-end">
                    {!d.closed && d.balancePaisa > 0 && (
                      <div className="flex justify-end gap-2">
                        {can(me.data, 'payroll.manage') && (
                          <button
                            className="btn-secondary min-h-9 px-3 text-sm"
                            onClick={() => pause.mutate({ id: d.id, paused: !d.paused })}
                          >
                            {t(d.paused ? 'dues.resume' : 'dues.pause')}
                          </button>
                        )}
                        {can(me.data, 'payroll.approve') && (
                          <button
                            className="btn-danger-quiet min-h-9 px-3 text-sm"
                            onClick={() => setWriteOff(d)}
                          >
                            {t('dues.writeOff')}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">{t('dues.recoveryHint')}</p>
      {creating && (
        <NewDue
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {writeOff && (
        <WriteOff
          due={writeOff}
          onClose={() => setWriteOff(null)}
          onDone={async () => {
            setWriteOff(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function NewDue({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const me = useMe();
  const staff = useQuery({
    queryKey: ['employees', 'CURRENT'],
    queryFn: async () =>
      (
        await api<{ items: { id: string; code: string; fullName: string }[] }>(
          '/employees?status=CURRENT',
        )
      ).items,
  });
  const canGive = can(me.data, 'payroll.pay');
  const [kind, setKind] = useState<Due['kind']>(canGive ? 'ADVANCE' : 'FINE');
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [installment, setInstallment] = useState('');
  const [reason, setReason] = useState('');
  const [paidFrom, setPaidFrom] = useState<'OWNER_CASH' | 'BANK' | 'DRAWER_CASH'>('OWNER_CASH');
  const key = useRef(newKey());
  const paisa = parseRs(amount);
  const inst = installment.trim() ? parseRs(installment) : undefined;
  const save = useMutation({
    mutationFn: () =>
      api('/staff-dues', {
        method: 'POST',
        body: {
          employeeId,
          kind,
          amountPaisa: paisa,
          ...(inst ? { installmentPaisa: inst } : {}),
          reason: reason.trim(),
          ...(kind !== 'FINE' ? { paidFrom } : {}),
        },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: onSaved,
  });
  const valid =
    !!employeeId &&
    !!paisa &&
    reason.trim().length > 0 &&
    (kind !== 'LOAN' || !!inst) &&
    (!inst || !paisa || inst <= paisa);
  return (
    <Dialog title={t('dues.new')} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          {(['ADVANCE', 'LOAN', 'FINE'] as const).map((k) => (
            <button
              key={k}
              aria-pressed={kind === k}
              disabled={k !== 'FINE' && !canGive}
              onClick={() => setKind(k)}
              className={`min-h-11 flex-1 rounded-lg border font-semibold disabled:opacity-40 ${kind === k ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
            >
              {t(`dues.kind.${k}`)}
            </button>
          ))}
        </div>
        <p className="hint">{t(`dues.kindHint.${kind}`)}</p>
        <Field label={t('admin.name')}>
          <select
            className="input"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">–</option>
            {(staff.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.code} · {e.fullName}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('payroll.amount')}>
            <input
              className="input"
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={t('dues.perRunLabel')}>
            <input
              className="input"
              dir="ltr"
              inputMode="decimal"
              placeholder={kind === 'LOAN' ? '' : t('dues.allAtOnce')}
              value={installment}
              onChange={(e) => setInstallment(e.target.value)}
            />
          </Field>
        </div>
        <Field label={t('dues.reason')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {kind !== 'FINE' && (
          <Field label={t('payroll.paidFrom')}>
            <select
              className="input"
              value={paidFrom}
              onChange={(e) => setPaidFrom(e.target.value as typeof paidFrom)}
            >
              {(['OWNER_CASH', 'BANK', 'DRAWER_CASH'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`payroll.source.${s}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function WriteOff({
  due,
  onClose,
  onDone,
}: {
  due: Due;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const go = useMutation({
    mutationFn: () =>
      api(`/staff-dues/${due.id}/write-off`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: onDone,
  });
  return (
    <Dialog title={`${due.employeeName} · ${t('dues.writeOff')}`} onClose={onClose}>
      <div className="space-y-4">
        <p>{t('dues.writeOffText', { amount: formatRs(due.balancePaisa) })}</p>
        <Field label={t('leave.why')}>
          <input
            className="input"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <ErrorText error={go.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!reason.trim() || go.isPending}
            onClick={() => go.mutate()}
          >
            {t('leave.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
