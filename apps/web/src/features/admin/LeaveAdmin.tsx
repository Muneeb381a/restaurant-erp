import { formatLeaveDays } from '@erp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { can, useMe } from '../../lib/queries';
import { Dialog, EmptyRow, ErrorText, Field, PageHead, Toggle } from './ui';

interface LeaveType {
  id: string;
  code: string;
  name: string;
  nameUr: string | null;
  paid: boolean;
  allowanceHalfDays: number | null;
  allowNegative: boolean;
  isActive: boolean;
}
interface Request {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  typeName: string;
  typeCode: string;
  paid: boolean;
  from: string;
  to: string;
  isHalfDay: boolean;
  halfDays: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reason: string | null;
  decisionNote: string | null;
}
interface Balance {
  allowance: number | null;
  used: number;
  pending: number;
  remaining: number | null;
}
interface Balances {
  year: number;
  types: LeaveType[];
  employees: { id: string; code: string; fullName: string; balances: Record<string, Balance> }[];
}
interface EmployeeLite {
  id: string;
  code: string;
  fullName: string;
}

const STATUS_TONE: Record<Request['status'], string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
};
const typeName = (t: LeaveType, lang: string): string =>
  lang === 'ur' && t.nameUr ? t.nameUr : t.name;

/** Leave: requests and decisions, who has how much left, and the kinds of leave this restaurant gives. */
export function LeaveAdmin() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'requests' | 'balances' | 'types'>('requests');
  return (
    <div className="max-w-6xl space-y-5 p-4 md:p-6">
      <PageHead title={t('leave.title')} hint={t('leave.hint')}>
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
          {(['requests', 'balances', 'types'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`min-h-9 rounded-md px-4 text-sm font-semibold ${tab === k ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              {t(`leave.tab.${k}`)}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'requests' && <Requests />}
      {tab === 'balances' && <Balances />}
      {tab === 'types' && <Types />}
    </div>
  );
}

function useTypes() {
  return useQuery({
    queryKey: ['leave-types'],
    queryFn: async () => (await api<{ items: LeaveType[] }>('/leave-types')).items,
  });
}

// ───────────────────────────── requests ─────────────────────────────

function Requests() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = can(me.data, 'leave.manage');
  const [status, setStatus] = useState<'PENDING' | ''>('PENDING');
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<{ r: Request; kind: 'reject' | 'cancel' } | null>(null);
  const list = useQuery({
    queryKey: ['leave-requests', status],
    queryFn: async () =>
      (await api<{ items: Request[] }>(`/leave-requests${status ? `?status=${status}` : ''}`))
        .items,
  });
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['leave-requests'] });
    await qc.invalidateQueries({ queryKey: ['leave-balances'] });
    await qc.invalidateQueries({ queryKey: ['attendance'] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => api(`/leave-requests/${id}/approve`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  const rows = list.data ?? [];
  const lang = i18n.language;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(['PENDING', ''] as const).map((s) => (
            <button
              key={s || 'all'}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`min-h-9 rounded-md px-4 text-sm font-semibold ${status === s ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              {t(s ? 'leave.waiting' : 'leave.all')}
            </button>
          ))}
        </div>
        {canManage && (
          <button className="btn-primary ms-auto" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            {t('leave.new')}
          </button>
        )}
      </div>
      <ErrorText error={approve.error} />
      <div className="dt">
        <table className="min-w-[48rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              <th>{t('leave.kind')}</th>
              <th>{t('leave.dates')}</th>
              <th>{t('leave.days')}</th>
              <th>{t('hr.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <EmptyRow
                cols={6}
                icon="clock"
                text={t(list.isPending ? 'common.loading' : 'leave.none')}
              />
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="font-semibold">{r.employeeName}</div>
                  <div className="text-xs text-slate-500">{r.employeeCode}</div>
                </td>
                <td>
                  {r.typeName}
                  {!r.paid && (
                    <span className="ms-2 text-xs text-slate-500">{t('leave.unpaid')}</span>
                  )}
                </td>
                <td dir="ltr" className="text-sm">
                  {r.from === r.to ? r.from : `${r.from} → ${r.to}`}
                  {r.reason && <div className="text-xs text-slate-500">{r.reason}</div>}
                </td>
                <td>{formatLeaveDays(r.halfDays)}</td>
                <td>
                  <span
                    className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_TONE[r.status]}`}
                  >
                    {t(`leave.st.${r.status}`)}
                  </span>
                  {r.decisionNote && (
                    <div className="mt-1 text-xs text-slate-500">{r.decisionNote}</div>
                  )}
                </td>
                <td className="text-end">
                  {canManage && r.status === 'PENDING' && (
                    <div className="flex justify-end gap-2">
                      <button
                        className="btn-primary min-h-9 px-3 text-sm"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(r.id)}
                      >
                        {t('leave.approve')}
                      </button>
                      <button
                        className="btn-secondary min-h-9 px-3 text-sm"
                        onClick={() => setActing({ r, kind: 'reject' })}
                      >
                        {t('leave.reject')}
                      </button>
                    </div>
                  )}
                  {canManage && r.status === 'APPROVED' && (
                    <button
                      className="btn-danger-quiet min-h-9 px-3 text-sm"
                      onClick={() => setActing({ r, kind: 'cancel' })}
                    >
                      {t('leave.cancel')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <NewRequest
          lang={lang}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {acting && (
        <NoteDialog
          title={t(acting.kind === 'reject' ? 'leave.rejectTitle' : 'leave.cancelTitle', {
            name: acting.r.employeeName,
          })}
          path={`/leave-requests/${acting.r.id}/${acting.kind}`}
          onClose={() => setActing(null)}
          onDone={async () => {
            setActing(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function NoteDialog({
  title,
  path,
  onClose,
  onDone,
}: {
  title: string;
  path: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const go = useMutation({
    mutationFn: () => api(path, { method: 'POST', body: { note: note.trim() } }),
    onSuccess: onDone,
  });
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('leave.why')}>
          <input
            className="input"
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <ErrorText error={go.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!note.trim() || go.isPending}
            onClick={() => go.mutate()}
          >
            {t('leave.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function NewRequest({
  lang,
  onClose,
  onSaved,
}: {
  lang: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const types = useTypes();
  const staff = useQuery({
    queryKey: ['employees', 'CURRENT'],
    queryFn: async () => (await api<{ items: EmployeeLite[] }>('/employees?status=CURRENT')).items,
  });
  const [employeeId, setEmployeeId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [from, setFrom] = useState(localDate());
  const [to, setTo] = useState(localDate());
  const [half, setHalf] = useState(false);
  const [reason, setReason] = useState('');
  const [approve, setApprove] = useState(true);
  const active = (types.data ?? []).filter((x) => x.isActive);
  const save = useMutation({
    mutationFn: () =>
      api('/leave-requests', {
        method: 'POST',
        body: {
          employeeId,
          leaveTypeId: leaveTypeId || active[0]?.id,
          from,
          to: half ? from : to,
          half,
          reason: reason.trim() || null,
          approve,
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={t('leave.new')} onClose={onClose}>
      <div className="space-y-4">
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
        <Field label={t('leave.kind')}>
          <select
            className="input"
            value={leaveTypeId || active[0]?.id || ''}
            onChange={(e) => setLeaveTypeId(e.target.value)}
          >
            {active.map((x) => (
              <option key={x.id} value={x.id}>
                {typeName(x, lang)}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('leave.from')}>
            <input
              type="date"
              className="input"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                if (to < e.target.value) setTo(e.target.value);
              }}
            />
          </Field>
          <Field label={t('leave.to')}>
            <input
              type="date"
              className="input"
              disabled={half}
              value={half ? from : to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} />
          {t('leave.halfDay')}
        </label>
        <Field label={t('leave.reason')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
          {t('leave.approveNow')}
        </label>
        <p className="hint">{t('leave.countHint')}</p>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!employeeId || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── balances ─────────────────────────────

function Balances() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = can(me.data, 'leave.manage');
  const [year, setYear] = useState(Number(localDate().slice(0, 4)));
  const [adjust, setAdjust] = useState<{ id: string; name: string } | null>(null);
  const data = useQuery({
    queryKey: ['leave-balances', year],
    queryFn: () => api<Balances>(`/leave-balances?year=${year}`),
  });
  const types = data.data?.types ?? [];
  return (
    <>
      <div className="flex items-center gap-2">
        <button
          className="btn-secondary min-h-10 px-3"
          aria-label={t('leave.prevYear')}
          onClick={() => setYear(year - 1)}
        >
          <Icon name="chevronLeft" size={18} className="rtl:rotate-180" />
        </button>
        <span className="min-w-16 text-center text-lg font-semibold" dir="ltr">
          {year}
        </span>
        <button
          className="btn-secondary min-h-10 px-3"
          aria-label={t('leave.nextYear')}
          onClick={() => setYear(year + 1)}
        >
          <Icon name="chevronRight" size={18} className="rtl:rotate-180" />
        </button>
      </div>
      <ErrorText error={data.error} />
      <div className="dt overflow-x-auto">
        <table className="min-w-[40rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              {types.map((x) => (
                <th key={x.id}>{typeName(x, i18n.language)}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {(data.data?.employees ?? []).length === 0 && (
              <EmptyRow
                cols={types.length + 2}
                icon="user"
                text={t(data.isPending ? 'common.loading' : 'hr.noStaff')}
              />
            )}
            {(data.data?.employees ?? []).map((e) => (
              <tr key={e.id}>
                <td className="font-semibold">{e.fullName}</td>
                {types.map((x) => {
                  const b = e.balances[x.id]!;
                  return (
                    <td key={x.id}>
                      {b.remaining === null ? (
                        <span className="text-slate-500">
                          {t('leave.taken', { days: formatLeaveDays(b.used) })}
                        </span>
                      ) : (
                        <span
                          className={
                            b.remaining < 0 ? 'font-semibold text-rose-700' : 'font-semibold'
                          }
                        >
                          {formatLeaveDays(Math.abs(b.remaining))}
                          {b.remaining < 0 && ' −'}
                        </span>
                      )}
                      {b.remaining !== null && (
                        <div className="text-xs text-slate-500">
                          {t('leave.usedOf', {
                            used: formatLeaveDays(b.used),
                            of: formatLeaveDays(b.allowance ?? 0),
                          })}
                        </div>
                      )}
                      {b.pending > 0 && (
                        <div className="text-xs text-amber-700">
                          {t('leave.pendingN', { days: formatLeaveDays(b.pending) })}
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="text-end">
                  {canManage && (
                    <button
                      className="btn-secondary min-h-9 px-3 text-sm"
                      onClick={() => setAdjust({ id: e.id, name: e.fullName })}
                    >
                      {t('leave.adjust')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">{t('leave.balanceHint')}</p>
      {adjust && (
        <AdjustDialog
          who={adjust}
          year={year}
          types={types}
          lang={i18n.language}
          onClose={() => setAdjust(null)}
          onSaved={async () => {
            setAdjust(null);
            await qc.invalidateQueries({ queryKey: ['leave-balances'] });
          }}
        />
      )}
    </>
  );
}

function AdjustDialog({
  who,
  year,
  types,
  lang,
  onClose,
  onSaved,
}: {
  who: { id: string; name: string };
  year: number;
  types: LeaveType[];
  lang: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const half = Math.round(Number(days) * 2);
  const valid =
    Number.isFinite(half) &&
    half !== 0 &&
    Number.isInteger(Number(days) * 2) &&
    reason.trim().length > 0;
  const save = useMutation({
    mutationFn: () =>
      api('/leave-adjustments', {
        method: 'POST',
        body: {
          employeeId: who.id,
          leaveTypeId: typeId,
          year,
          halfDays: half,
          reason: reason.trim(),
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={`${who.name} · ${year}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('leave.kind')}>
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {typeName(x, lang)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('leave.addDays')}>
          <input
            className="input"
            dir="ltr"
            inputMode="decimal"
            placeholder="+5  /  -1.5"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>
        <Field label={t('leave.why')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="hint">{t('leave.adjustHint')}</p>
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

// ───────────────────────────── kinds of leave ─────────────────────────────

function Types() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = can(me.data, 'leave.manage');
  const types = useTypes();
  const [adding, setAdding] = useState(false);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['leave-types'] });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      api(`/leave-types/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: refresh,
  });
  return (
    <>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('leave.legalNote')}</p>
      {canManage && (
        <div>
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
            {t('leave.addKind')}
          </button>
        </div>
      )}
      <ErrorText error={patch.error} />
      <div className="dt">
        <table className="min-w-[40rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              <th>{t('leave.paidLeave')}</th>
              <th>{t('leave.allowance')}</th>
              <th>{t('leave.mayGoNegative')}</th>
              <th>{t('admin.active')}</th>
            </tr>
          </thead>
          <tbody>
            {(types.data ?? []).map((x) => (
              <tr key={x.id}>
                <td>
                  <div className="font-semibold">{typeName(x, i18n.language)}</div>
                  <div className="font-mono text-xs text-slate-500">{x.code}</div>
                </td>
                <td>
                  <Toggle
                    on={x.paid}
                    label={t('leave.paidLeave')}
                    disabled={!canManage}
                    onChange={(v) => patch.mutate({ id: x.id, body: { paid: v } })}
                  />
                </td>
                <td>
                  <AllowanceInput
                    value={x.allowanceHalfDays}
                    disabled={!canManage}
                    onSave={(v) => patch.mutate({ id: x.id, body: { allowanceHalfDays: v } })}
                  />
                </td>
                <td>
                  <Toggle
                    on={x.allowNegative}
                    label={t('leave.mayGoNegative')}
                    disabled={!canManage}
                    onChange={(v) => patch.mutate({ id: x.id, body: { allowNegative: v } })}
                  />
                </td>
                <td>
                  <Toggle
                    on={x.isActive}
                    label={t('admin.active')}
                    disabled={!canManage}
                    onChange={(v) => patch.mutate({ id: x.id, body: { isActive: v } })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <AddKind
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}

/** Days per year typed by the owner ("" = not limited). Saved when the box is left. */
function AllowanceInput({
  value,
  disabled,
  onSave,
}: {
  value: number | null;
  disabled: boolean;
  onSave: (halfDays: number | null) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value === null ? '' : formatLeaveDays(value));
  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') return value === null ? undefined : onSave(null);
    const n = Number(trimmed) * 2;
    if (!Number.isInteger(n) || n < 0) return setText(value === null ? '' : formatLeaveDays(value));
    if (n !== value) onSave(n);
  };
  return (
    <input
      className="input w-28"
      dir="ltr"
      inputMode="decimal"
      disabled={disabled}
      placeholder={t('leave.noLimit')}
      aria-label={t('leave.allowance')}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
}

function AddKind({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [nameUr, setNameUr] = useState('');
  const [paid, setPaid] = useState(true);
  const save = useMutation({
    mutationFn: () =>
      api('/leave-types', {
        method: 'POST',
        body: {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          nameUr: nameUr.trim() || null,
          paid,
        },
      }),
    onSuccess: onSaved,
  });
  const valid = /^[A-Z0-9_]{1,20}$/.test(code.trim().toUpperCase()) && name.trim().length > 0;
  return (
    <Dialog title={t('leave.addKind')} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('admin.name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('admin.nameUr')}>
          <input
            className="input"
            dir="rtl"
            value={nameUr}
            onChange={(e) => setNameUr(e.target.value)}
          />
        </Field>
        <Field label={t('admin.code')}>
          <input
            className="input"
            dir="ltr"
            placeholder="HAJJ"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          {t('leave.paidLeave')}
        </label>
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
