import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { formatRs, parseRs } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import { Dialog, EmptyRow, ErrorText, Field, PageHead } from './ui';

// ───────────────────────────────── types ─────────────────────────────────

interface Employee {
  id: string;
  code: string;
  fullName: string;
  fullNameUr: string | null;
  phone: string | null;
  cnic: string | null;
  address: string | null;
  emergencyContact: string | null;
  designation: string;
  department: string;
  joinDate: string;
  leftDate: string | null;
  status: 'ACTIVE' | 'ON_NOTICE' | 'LEFT';
  payType: 'MONTHLY' | 'DAILY' | 'HOURLY';
  basePayPaisa: number;
  payFrequency: 'MONTHLY' | 'WEEKLY' | 'DAILY';
  weeklyOff: number[];
  shiftStart: string | null;
  shiftEnd: string | null;
  payoutMethod: string | null;
  payoutAccount: string | null;
  hasPin: boolean;
  notes: string | null;
}
type Status = 'PRESENT' | 'ABSENT' | 'HALF_DAY' | 'LEAVE' | 'WEEKLY_OFF' | 'HOLIDAY';
interface SheetRow {
  employee: {
    id: string;
    code: string;
    fullName: string;
    designation: string;
    shiftStart: string | null;
    shiftEnd: string | null;
  };
  record: {
    status: Status;
    clockIn: string | null;
    clockOut: string | null;
    workedMinutes: number | null;
    lateMinutes: number;
    overtimeMinutes: number;
    source: string;
    note: string | null;
  } | null;
  calendar: 'WEEKLY_OFF' | 'HOLIDAY' | null;
}
interface MonthData {
  days: string[];
  holidays: string[];
  employees: {
    id: string;
    code: string;
    fullName: string;
    designation: string;
    days: { date: string; status: Status | null }[];
    summary: {
      present: number;
      halfDays: number;
      absent: number;
      leave: number;
      weeklyOff: number;
      holidays: number;
      unmarked: number;
      lateCount: number;
      lateMinutes: number;
      overtimeMinutes: number;
      workedMinutes: number;
    };
  }[];
}

const DEPARTMENTS = ['KITCHEN', 'FLOOR', 'COUNTER', 'DELIVERY', 'STORE', 'ADMIN', 'OTHER'] as const;
const STATUS_TONE: Record<Status, string> = {
  PRESENT: 'bg-emerald-100 text-emerald-800',
  ABSENT: 'bg-rose-100 text-rose-700',
  HALF_DAY: 'bg-amber-100 text-amber-800',
  LEAVE: 'bg-sky-100 text-sky-800',
  WEEKLY_OFF: 'bg-slate-100 text-slate-600',
  HOLIDAY: 'bg-violet-100 text-violet-700',
};
const STATUS_LETTER: Record<Status, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  HALF_DAY: 'H',
  LEAVE: 'L',
  WEEKLY_OFF: 'O',
  HOLIDAY: 'G',
};

/** "2 h 05 m" from whole minutes. */
const hours = (min: number | null): string =>
  min === null ? '–' : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
};
/** HH:MM on this device's clock for a moment given by the server. */
const clockText = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : '';

const nameOf = (e: { fullName: string; fullNameUr?: string | null }, lang: string): string =>
  lang === 'ur' && e.fullNameUr ? e.fullNameUr : e.fullName;

// ───────────────────────────────── staff list ─────────────────────────────────

/** The people who work here: details, how they are paid, usual hours and their own clock-in PIN. */
export function EmployeesAdmin() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = can(me.data, 'employee.manage');
  const [filter, setFilter] = useState<'CURRENT' | 'LEFT'>('CURRENT');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'new' | Employee | null>(null);
  const list = useQuery({
    queryKey: ['employees', filter],
    queryFn: async () => (await api<{ items: Employee[] }>(`/employees?status=${filter}`)).items,
  });
  const rows = (list.data ?? []).filter((e) => {
    const s = search.trim().toLowerCase();
    return (
      !s ||
      e.fullName.toLowerCase().includes(s) ||
      e.code.toLowerCase().includes(s) ||
      (e.phone ?? '').includes(s)
    );
  });

  return (
    <div className="max-w-6xl space-y-5 p-4 md:p-6">
      <PageHead title={t('hr.staff')} hint={t('hr.staffHint')}>
        {canManage && (
          <button className="btn-primary" onClick={() => setDialog('new')}>
            <Icon name="plus" size={18} />
            {t('hr.addStaff')}
          </button>
        )}
      </PageHead>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
          {(['CURRENT', 'LEFT'] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`min-h-9 rounded-md px-4 text-sm font-semibold ${filter === f ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              {t(f === 'CURRENT' ? 'hr.current' : 'hr.formerStaff')}
            </button>
          ))}
        </div>
        <input
          className="input max-w-xs"
          placeholder={t('admin.search')}
          aria-label={t('admin.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="dt">
        <table className="min-w-[48rem]">
          <thead>
            <tr>
              <th>{t('hr.number')}</th>
              <th>{t('admin.name')}</th>
              <th>{t('hr.designation')}</th>
              <th>{t('hr.pay')}</th>
              <th>{t('hr.hours')}</th>
              <th>{t('hr.clockPin')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <EmptyRow
                cols={7}
                icon="user"
                text={t(list.isPending ? 'common.loading' : 'hr.noStaff')}
              />
            )}
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="font-mono text-sm">{e.code}</td>
                <td>
                  <div className="font-semibold">{nameOf(e, i18n.language)}</div>
                  {e.phone && (
                    <div className="text-xs text-slate-500" dir="ltr">
                      {e.phone}
                    </div>
                  )}
                </td>
                <td>
                  {e.designation || '–'}
                  <div className="text-xs text-slate-500">{t(`hr.dept.${e.department}`)}</div>
                </td>
                <td>
                  <span dir="ltr">{formatRs(e.basePayPaisa)}</span>
                  <div className="text-xs text-slate-500">{t(`hr.payType.${e.payType}`)}</div>
                </td>
                <td dir="ltr" className="text-sm">
                  {e.shiftStart ? `${e.shiftStart}–${e.shiftEnd}` : '–'}
                </td>
                <td>
                  {e.hasPin ? (
                    <Icon
                      name="check"
                      size={18}
                      className="text-emerald-600"
                      aria-label={t('hr.hasPin')}
                    />
                  ) : (
                    '–'
                  )}
                </td>
                <td className="text-end">
                  {canManage && (
                    <button
                      className="btn-secondary min-h-9 px-3 text-sm"
                      onClick={() => setDialog(e)}
                    >
                      {t('admin.edit')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dialog && (
        <EmployeeDialog
          employee={dialog === 'new' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await qc.invalidateQueries({ queryKey: ['employees'] });
          }}
        />
      )}
    </div>
  );
}

function EmployeeDialog({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const e = employee;
  const [f, setF] = useState({
    fullName: e?.fullName ?? '',
    fullNameUr: e?.fullNameUr ?? '',
    phone: e?.phone ?? '',
    cnic: e?.cnic ?? '',
    address: e?.address ?? '',
    emergencyContact: e?.emergencyContact ?? '',
    designation: e?.designation ?? '',
    department: e?.department ?? 'KITCHEN',
    joinDate: e?.joinDate ?? localDate(),
    status: e?.status ?? 'ACTIVE',
    leftDate: e?.leftDate ?? '',
    payType: e?.payType ?? 'MONTHLY',
    pay: e ? String(e.basePayPaisa / 100) : '',
    weeklyOff: e?.weeklyOff ?? [5],
    shiftStart: e?.shiftStart ?? '',
    shiftEnd: e?.shiftEnd ?? '',
    payoutMethod: e?.payoutMethod ?? '',
    payoutAccount: e?.payoutAccount ?? '',
    notes: e?.notes ?? '',
  });
  const [pin, setPin] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]): void =>
    setF((p) => ({ ...p, [k]: v }));
  const days = [0, 1, 2, 3, 4, 5, 6];
  const payPaisa = parseRs(f.pay || '0');

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        fullName: f.fullName.trim(),
        fullNameUr: f.fullNameUr.trim() || null,
        phone: f.phone.trim() || null,
        cnic: f.cnic.trim() || null,
        address: f.address.trim() || null,
        emergencyContact: f.emergencyContact.trim() || null,
        designation: f.designation.trim(),
        department: f.department,
        joinDate: f.joinDate,
        status: f.status,
        leftDate: f.status === 'LEFT' ? f.leftDate || null : null,
        payType: f.payType,
        basePayPaisa: payPaisa ?? 0,
        weeklyOff: f.weeklyOff,
        shiftStart: f.shiftStart || null,
        shiftEnd: f.shiftEnd || null,
        payoutMethod: f.payoutMethod || null,
        payoutAccount: f.payoutAccount.trim() || null,
        notes: f.notes.trim() || null,
      };
      const saved = e
        ? await api<Employee>(`/employees/${e.id}`, { method: 'PATCH', body })
        : await api<Employee>('/employees', { method: 'POST', body });
      if (pin) await api(`/employees/${saved.id}/pin`, { method: 'PUT', body: { pin } });
    },
    onSuccess: onSaved,
  });
  const clearPin = useMutation({
    mutationFn: () => api(`/employees/${e!.id}/pin`, { method: 'DELETE' }),
    onSuccess: onSaved,
  });
  const valid =
    f.fullName.trim().length > 0 &&
    payPaisa !== null &&
    !!f.shiftStart === !!f.shiftEnd &&
    (f.status !== 'LEFT' || !!f.leftDate) &&
    (pin === '' || /^\d{4,8}$/.test(pin));

  return (
    <Dialog title={e ? t('hr.editStaff') : t('hr.addStaff')} onClose={onClose} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('admin.name')}>
          <input
            className="input"
            value={f.fullName}
            onChange={(x) => set('fullName', x.target.value)}
          />
        </Field>
        <Field label={t('admin.nameUr')}>
          <input
            className="input"
            dir="rtl"
            value={f.fullNameUr}
            onChange={(x) => set('fullNameUr', x.target.value)}
          />
        </Field>
        <Field label={t('hr.phone')}>
          <input
            className="input"
            dir="ltr"
            inputMode="tel"
            value={f.phone}
            onChange={(x) => set('phone', x.target.value)}
          />
        </Field>
        <Field label={t('hr.cnic')}>
          <input
            className="input"
            dir="ltr"
            placeholder="35202-1234567-1"
            value={f.cnic}
            onChange={(x) => set('cnic', x.target.value)}
          />
        </Field>
        <Field label={t('hr.designation')}>
          <input
            className="input"
            value={f.designation}
            onChange={(x) => set('designation', x.target.value)}
          />
        </Field>
        <Field label={t('hr.department')}>
          <select
            className="input"
            value={f.department}
            onChange={(x) => set('department', x.target.value)}
          >
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {t(`hr.dept.${d}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('hr.joinDate')}>
          <input
            type="date"
            className="input"
            value={f.joinDate}
            onChange={(x) => set('joinDate', x.target.value)}
          />
        </Field>
        <Field label={t('hr.status')}>
          <select
            className="input"
            value={f.status}
            onChange={(x) => set('status', x.target.value as Employee['status'])}
          >
            {(['ACTIVE', 'ON_NOTICE', 'LEFT'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`hr.statusName.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        {f.status === 'LEFT' && (
          <Field label={t('hr.leftDate')}>
            <input
              type="date"
              className="input"
              value={f.leftDate}
              onChange={(x) => set('leftDate', x.target.value)}
            />
          </Field>
        )}
      </div>

      <h3 className="mt-6 mb-2 font-semibold">{t('hr.payTerms')}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('hr.payTypeLabel')}>
          <select
            className="input"
            value={f.payType}
            onChange={(x) => set('payType', x.target.value as Employee['payType'])}
          >
            {(['MONTHLY', 'DAILY', 'HOURLY'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`hr.payType.${p}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t(`hr.rate.${f.payType}`)}>
          <input
            className="input"
            dir="ltr"
            inputMode="decimal"
            value={f.pay}
            onChange={(x) => set('pay', x.target.value)}
          />
        </Field>
        <Field label={t('hr.payoutMethod')}>
          <select
            className="input"
            value={f.payoutMethod}
            onChange={(x) => set('payoutMethod', x.target.value)}
          >
            <option value="">–</option>
            {['CASH', 'JAZZCASH', 'EASYPAISA', 'BANK'].map((m) => (
              <option key={m} value={m}>
                {t(`hr.payout.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        {f.payoutMethod && f.payoutMethod !== 'CASH' && (
          <Field label={t('hr.payoutAccount')}>
            <input
              className="input"
              dir="ltr"
              value={f.payoutAccount}
              onChange={(x) => set('payoutAccount', x.target.value)}
            />
          </Field>
        )}
      </div>

      <h3 className="mt-6 mb-2 font-semibold">{t('hr.workingTime')}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('hr.shiftStart')}>
          <input
            type="time"
            className="input"
            value={f.shiftStart}
            onChange={(x) => set('shiftStart', x.target.value)}
          />
        </Field>
        <Field label={t('hr.shiftEnd')}>
          <input
            type="time"
            className="input"
            value={f.shiftEnd}
            onChange={(x) => set('shiftEnd', x.target.value)}
          />
        </Field>
      </div>
      <p className="hint mt-1">{t('hr.shiftHint')}</p>
      <div className="mt-3">
        <span className="label">{t('hr.weeklyOff')}</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {days.map((d) => {
            const on = f.weeklyOff.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  set('weeklyOff', on ? f.weeklyOff.filter((x) => x !== d) : [...f.weeklyOff, d])
                }
                className={`min-h-10 rounded-lg border px-3 text-sm font-semibold ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
              >
                {t(`hr.day.${d}`)}
              </button>
            );
          })}
        </div>
      </div>

      <h3 className="mt-6 mb-2 font-semibold">{t('hr.clockPin')}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={e?.hasPin ? t('hr.newPin') : t('hr.setPin')}>
          <input
            className="input w-40"
            dir="ltr"
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(x) => setPin(x.target.value.replace(/\D/g, ''))}
          />
        </Field>
        {e?.hasPin && (
          <button
            className="btn-danger-quiet"
            disabled={clearPin.isPending}
            onClick={() => clearPin.mutate()}
          >
            {t('hr.removePin')}
          </button>
        )}
      </div>
      <p className="hint mt-1">{t('hr.pinHint')}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label={t('hr.address')}>
          <input
            className="input"
            value={f.address}
            onChange={(x) => set('address', x.target.value)}
          />
        </Field>
        <Field label={t('hr.emergency')}>
          <input
            className="input"
            value={f.emergencyContact}
            onChange={(x) => set('emergencyContact', x.target.value)}
          />
        </Field>
      </div>
      <Field label={t('hr.notes')}>
        <input className="input" value={f.notes} onChange={(x) => set('notes', x.target.value)} />
      </Field>

      <div className="mt-5 space-y-3">
        <ErrorText error={save.error ?? clearPin.error} />
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

// ───────────────────────────────── attendance ─────────────────────────────────

/** Who came: the day sheet (quick marks), the month at a glance, and the holidays. */
export function AttendanceAdmin() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'day' | 'month'>('day');
  return (
    <div className="max-w-6xl space-y-5 p-4 md:p-6">
      <PageHead title={t('hr.attendance')} hint={t('hr.attendanceHint')}>
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
          {(['day', 'month'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`min-h-9 rounded-md px-4 text-sm font-semibold ${tab === k ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
            >
              {t(k === 'day' ? 'hr.dayTab' : 'hr.monthTab')}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'day' ? <DaySheet /> : <MonthView />}
    </div>
  );
}

function DaySheet() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canMark = can(me.data, 'attendance.mark');
  const [date, setDate] = useState(localDate());
  const [detail, setDetail] = useState<SheetRow | null>(null);
  const sheet = useQuery({
    queryKey: ['attendance', date],
    queryFn: async () => (await api<{ items: SheetRow[] }>(`/attendance?date=${date}`)).items,
  });
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['attendance'] });
  const mark = useMutation({
    mutationFn: (v: { id: string; status: Status }) =>
      api(`/attendance/${v.id}/${date}`, { method: 'PUT', body: { status: v.status } }),
    onSuccess: refresh,
  });
  const everyone = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ marked: number }>('/attendance/bulk', {
        method: 'POST',
        body: { date, status: 'PRESENT', employeeIds: ids },
      }),
    onSuccess: async (r) => {
      toast(t('hr.markedN', { count: r.marked }));
      await refresh();
    },
  });
  const rows = sheet.data ?? [];
  const unmarked = rows.filter((r) => !r.record && !r.calendar);
  const count = (s: Status): number =>
    rows.filter((r) => (r.record?.status ?? r.calendar) === s).length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary min-h-10 px-3"
          aria-label={t('hr.prevDay')}
          onClick={() => setDate(addDays(date, -1))}
        >
          <Icon name="chevronLeft" size={18} className="rtl:rotate-180" />
        </button>
        <input
          type="date"
          className="input w-auto"
          aria-label={t('hr.date')}
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
        <button
          className="btn-secondary min-h-10 px-3"
          aria-label={t('hr.nextDay')}
          onClick={() => setDate(addDays(date, 1))}
        >
          <Icon name="chevronRight" size={18} className="rtl:rotate-180" />
        </button>
        {date !== localDate() && (
          <button className="btn-secondary min-h-10" onClick={() => setDate(localDate())}>
            {t('hr.today')}
          </button>
        )}
        <span className="ms-auto flex flex-wrap gap-2 text-sm">
          {(['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE'] as const).map((s) => (
            <span key={s} className={`rounded-full px-3 py-1 font-semibold ${STATUS_TONE[s]}`}>
              {t(`hr.st.${s}`)} {count(s)}
            </span>
          ))}
        </span>
        {canMark && unmarked.length > 0 && (
          <button
            className="btn-primary"
            disabled={everyone.isPending}
            onClick={() => everyone.mutate(unmarked.map((r) => r.employee.id))}
          >
            <Icon name="check" size={18} />
            {t('hr.allPresent', { count: unmarked.length })}
          </button>
        )}
      </div>
      <ErrorText error={mark.error ?? everyone.error ?? sheet.error} />
      <div className="dt">
        <table className="min-w-[52rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              <th>{t('hr.today')}</th>
              <th>{t('hr.inOut')}</th>
              <th>{t('hr.late')}</th>
              <th>{t('hr.overtime')}</th>
              <th>{t('hr.mark')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <EmptyRow
                cols={6}
                icon="user"
                text={t(sheet.isPending ? 'common.loading' : 'hr.noStaffThatDay')}
              />
            )}
            {rows.map((r) => {
              const shown = r.record?.status ?? r.calendar;
              return (
                <tr key={r.employee.id}>
                  <td>
                    <div className="font-semibold">{r.employee.fullName}</div>
                    <div className="text-xs text-slate-500">{r.employee.designation}</div>
                  </td>
                  <td>
                    {shown ? (
                      <span
                        className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_TONE[shown]}`}
                      >
                        {t(`hr.st.${shown}`)}
                      </span>
                    ) : (
                      <span className="text-slate-400">{t('hr.notMarked')}</span>
                    )}
                    {r.record?.source === 'KIOSK' && (
                      <span className="ms-2 text-xs text-slate-500">{t('hr.byPin')}</span>
                    )}
                  </td>
                  <td dir="ltr" className="text-sm">
                    {r.record?.clockIn
                      ? `${clockText(r.record.clockIn)} → ${clockText(r.record.clockOut) || '…'}`
                      : '–'}
                    {r.record?.workedMinutes != null && (
                      <div className="text-xs text-slate-500">
                        {hours(r.record.workedMinutes)} h
                      </div>
                    )}
                  </td>
                  <td>
                    {r.record?.lateMinutes ? (
                      <span className="font-semibold text-rose-700">
                        {r.record.lateMinutes} {t('hr.min')}
                      </span>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {r.record?.overtimeMinutes ? (
                      <span className="font-semibold text-emerald-700">
                        {r.record.overtimeMinutes} {t('hr.min')}
                      </span>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {canMark && (
                      <div className="flex flex-wrap gap-1.5">
                        {(['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE'] as const).map((s) => (
                          <button
                            key={s}
                            aria-label={`${r.employee.fullName}: ${t(`hr.st.${s}`)}`}
                            aria-pressed={r.record?.status === s}
                            disabled={mark.isPending}
                            onClick={() => mark.mutate({ id: r.employee.id, status: s })}
                            className={`min-h-10 min-w-10 rounded-lg border px-2 text-sm font-bold ${
                              r.record?.status === s
                                ? `${STATUS_TONE[s]} border-current`
                                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            {STATUS_LETTER[s]}
                          </button>
                        ))}
                        <button
                          className="min-h-10 rounded-lg border border-slate-300 bg-white px-2 text-slate-600 hover:bg-slate-50"
                          aria-label={t('hr.times')}
                          onClick={() => setDetail(r)}
                        >
                          <Icon name="clock" size={18} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">{t('hr.legend')}</p>
      {detail && (
        <TimesDialog
          row={detail}
          date={date}
          name={nameOf({ fullName: detail.employee.fullName }, i18n.language)}
          onClose={() => setDetail(null)}
          onSaved={async () => {
            setDetail(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function TimesDialog({
  row,
  date,
  name,
  onClose,
  onSaved,
}: {
  row: SheetRow;
  date: string;
  name: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const rec = row.record;
  const [status, setStatus] = useState<Status>(
    rec?.status === 'HALF_DAY' ? 'HALF_DAY' : (rec?.status ?? 'PRESENT'),
  );
  const [inAt, setInAt] = useState(
    clockText(rec?.clockIn ?? null) || row.employee.shiftStart || '',
  );
  const [outAt, setOutAt] = useState(clockText(rec?.clockOut ?? null));
  const [nextDay, setNextDay] = useState(
    !!row.employee.shiftStart &&
      !!row.employee.shiftEnd &&
      row.employee.shiftEnd <= row.employee.shiftStart,
  );
  const [note, setNote] = useState(rec?.note ?? '');
  const working = status === 'PRESENT' || status === 'HALF_DAY';
  const save = useMutation({
    mutationFn: () =>
      api(`/attendance/${row.employee.id}/${date}`, {
        method: 'PUT',
        body: {
          status,
          clockIn: working && inAt ? inAt : null,
          clockOut: working && inAt && outAt ? outAt : null,
          clockOutNextDay: nextDay,
          note: note.trim() || null,
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={`${name} · ${date}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('hr.today')}>
          <select
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            {(['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE', 'WEEKLY_OFF', 'HOLIDAY'] as const).map(
              (s) => (
                <option key={s} value={s}>
                  {t(`hr.st.${s}`)}
                </option>
              ),
            )}
          </select>
        </Field>
        {working && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('hr.cameAt')}>
                <input
                  type="time"
                  className="input"
                  value={inAt}
                  onChange={(e) => setInAt(e.target.value)}
                />
              </Field>
              <Field label={t('hr.leftAt')}>
                <input
                  type="time"
                  className="input"
                  value={outAt}
                  onChange={(e) => setOutAt(e.target.value)}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={nextDay}
                onChange={(e) => setNextDay(e.target.checked)}
              />
              {t('hr.nextMorning')}
            </label>
          </>
        )}
        <Field label={t('hr.notes')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function MonthView() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canMark = can(me.data, 'attendance.mark');
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const data = useQuery({
    queryKey: ['attendance-month', month],
    queryFn: () => api<MonthData>(`/attendance/month?month=${month}`),
  });
  const year = month.slice(0, 4);
  const holidays = useQuery({
    queryKey: ['holidays', year],
    queryFn: async () =>
      (
        await api<{ items: { id: string; holiday_date: string; name: string }[] }>(
          `/holidays?year=${year}`,
        )
      ).items,
  });
  const [hDate, setHDate] = useState('');
  const [hName, setHName] = useState('');
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['holidays'] });
    await qc.invalidateQueries({ queryKey: ['attendance'] });
    await qc.invalidateQueries({ queryKey: ['attendance-month'] });
  };
  const addHoliday = useMutation({
    mutationFn: () =>
      api('/holidays', { method: 'POST', body: { date: hDate, name: hName.trim() } }),
    onSuccess: async () => {
      setHDate('');
      setHName('');
      await refresh();
    },
  });
  const removeHoliday = useMutation({
    mutationFn: (id: string) => api(`/holidays/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const shift = (n: number): void => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const d = new Date(y, m - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  const days = data.data?.days ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary min-h-10 px-3"
          aria-label={t('hr.prevMonth')}
          onClick={() => shift(-1)}
        >
          <Icon name="chevronLeft" size={18} className="rtl:rotate-180" />
        </button>
        <input
          type="month"
          className="input w-auto"
          aria-label={t('hr.monthTab')}
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
        <button
          className="btn-secondary min-h-10 px-3"
          aria-label={t('hr.nextMonth')}
          onClick={() => shift(1)}
        >
          <Icon name="chevronRight" size={18} className="rtl:rotate-180" />
        </button>
      </div>
      <ErrorText error={data.error} />
      <div className="dt overflow-x-auto">
        <table className="min-w-max text-sm">
          <thead>
            <tr>
              <th className="sticky start-0 bg-white">{t('admin.name')}</th>
              {days.map((d) => (
                <th
                  key={d}
                  className={`px-1 text-center ${data.data?.holidays.includes(d) ? 'text-violet-700' : ''}`}
                >
                  {Number(d.slice(8))}
                </th>
              ))}
              <th title={t('hr.st.PRESENT')}>P</th>
              <th title={t('hr.st.HALF_DAY')}>H</th>
              <th title={t('hr.st.ABSENT')}>A</th>
              <th title={t('hr.st.LEAVE')}>L</th>
              <th>{t('hr.late')}</th>
              <th>{t('hr.overtime')}</th>
            </tr>
          </thead>
          <tbody>
            {(data.data?.employees ?? []).length === 0 && (
              <EmptyRow
                cols={days.length + 7}
                icon="user"
                text={t(data.isPending ? 'common.loading' : 'hr.noStaff')}
              />
            )}
            {(data.data?.employees ?? []).map((e) => (
              <tr key={e.id}>
                <td className="sticky start-0 bg-white font-semibold">{e.fullName}</td>
                {e.days.map((d) => (
                  <td key={d.date} className="px-0.5 text-center">
                    {d.status ? (
                      <span
                        title={`${d.date}: ${t(`hr.st.${d.status}`)}`}
                        className={`inline-flex size-6 items-center justify-center rounded text-xs font-bold ${STATUS_TONE[d.status]}`}
                      >
                        {STATUS_LETTER[d.status]}
                      </span>
                    ) : (
                      <span className="text-slate-300">·</span>
                    )}
                  </td>
                ))}
                <td className="text-center font-semibold">{e.summary.present}</td>
                <td className="text-center">{e.summary.halfDays}</td>
                <td className="text-center font-semibold text-rose-700">{e.summary.absent}</td>
                <td className="text-center">{e.summary.leave}</td>
                <td className="text-center">
                  {e.summary.lateCount ? `${e.summary.lateCount}× · ${e.summary.lateMinutes}` : '–'}
                </td>
                <td className="text-center">
                  {e.summary.overtimeMinutes ? hours(e.summary.overtimeMinutes) : '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">{t('hr.legend')}</p>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold">
          {t('hr.holidays')} {year}
        </h3>
        <p className="hint">{t('hr.holidaysHint')}</p>
        {canMark && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('hr.date')}>
              <input
                type="date"
                className="input w-auto"
                value={hDate}
                onChange={(e) => setHDate(e.target.value)}
              />
            </Field>
            <Field label={t('admin.name')}>
              <input className="input" value={hName} onChange={(e) => setHName(e.target.value)} />
            </Field>
            <button
              className="btn-primary"
              disabled={!hDate || !hName.trim() || addHoliday.isPending}
              onClick={() => addHoliday.mutate()}
            >
              {t('admin.add')}
            </button>
          </div>
        )}
        <ErrorText error={addHoliday.error ?? removeHoliday.error} />
        <ul className="divide-y divide-slate-100 text-sm">
          {(holidays.data ?? []).map((h) => (
            <li key={h.id} className="flex items-center gap-3 py-2">
              <span className="w-28 font-mono" dir="ltr">
                {h.holiday_date}
              </span>
              <span className="me-auto">{h.name}</span>
              {canMark && (
                <button
                  className="btn-danger-quiet min-h-9 px-3"
                  onClick={() => removeHoliday.mutate(h.id)}
                >
                  {t('admin.delete')}
                </button>
              )}
            </li>
          ))}
          {(holidays.data ?? []).length === 0 && (
            <li className="py-2 text-slate-500">{t('hr.noHolidays')}</li>
          )}
        </ul>
      </section>
    </>
  );
}

// ───────────────────────────────── clock-in screen ─────────────────────────────────

interface ClockPerson {
  id: string;
  code: string;
  fullName: string;
  designation: string;
  state: 'IN' | 'OUT';
  since: string | null;
}

/** Left open on a tablet at the door: staff tap their name and type their own PIN to clock in or out. */
export function ClockScreen() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const people = useQuery({
    queryKey: ['attendance-clock'],
    queryFn: async () => (await api<{ items: ClockPerson[] }>('/attendance-clock')).items,
    refetchInterval: 30_000,
  });
  const [who, setWho] = useState<ClockPerson | null>(null);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const go = useMutation({
    mutationFn: () =>
      api<{
        action: 'IN' | 'OUT';
        employee: string;
        lateMinutes: number;
        workedMinutes: number | null;
      }>('/attendance-clock', {
        method: 'POST',
        body: { employeeId: who!.id, pin },
      }),
    onSuccess: async (r) => {
      setResult(
        r.action === 'IN'
          ? t('hr.clockedIn', { name: r.employee }) +
              (r.lateMinutes ? ` ${t('hr.lateBy', { count: r.lateMinutes })}` : '')
          : t('hr.clockedOut', { name: r.employee, hours: hours(r.workedMinutes) }),
      );
      setWho(null);
      setPin('');
      await qc.invalidateQueries({ queryKey: ['attendance-clock'] });
      setTimeout(() => setResult(null), 6000);
    },
    onError: () => setPin(''),
  });
  const press = (d: string): void => setPin((p) => (p.length < 8 ? p + d : p));

  return (
    <div className="max-w-5xl space-y-5 p-4 md:p-6">
      <PageHead title={t('hr.clockTitle')} hint={t('hr.clockHint')} />
      {result && (
        <p
          role="status"
          className="rounded-xl bg-emerald-50 p-4 text-lg font-semibold text-emerald-800"
        >
          {result}
        </p>
      )}
      <ErrorText error={people.error} />
      {(people.data ?? []).length === 0 && !people.isPending && (
        <p className="text-slate-600">{t('hr.clockNobody')}</p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {(people.data ?? []).map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setWho(p);
              setPin('');
              go.reset();
            }}
            className={`flex min-h-24 flex-col items-start justify-between rounded-2xl border-2 p-4 text-start ${p.state === 'IN' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white hover:border-slate-400'}`}
          >
            <span className="text-lg font-bold">{p.fullName}</span>
            <span
              className={`text-sm font-semibold ${p.state === 'IN' ? 'text-emerald-700' : 'text-slate-500'}`}
            >
              {p.state === 'IN' ? `${t('hr.in')} · ${clockText(p.since)}` : t('hr.out')}
            </span>
          </button>
        ))}
      </div>
      {who && (
        <Dialog
          title={`${who.fullName} — ${t(who.state === 'IN' ? 'hr.clockOut' : 'hr.clockIn')}`}
          onClose={() => setWho(null)}
        >
          <div className="mx-auto max-w-xs space-y-4">
            <div
              dir="ltr"
              className="flex h-14 items-center justify-center rounded-xl bg-slate-100 text-3xl tracking-[0.5em]"
              aria-label={t('hr.yourPin')}
            >
              {'•'.repeat(pin.length) || (
                <span className="text-base tracking-normal text-slate-400">{t('hr.yourPin')}</span>
              )}
            </div>
            <div dir="ltr" className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} className="btn-secondary min-h-14 text-xl" onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button
                className="btn-secondary min-h-14"
                aria-label={t('hr.clear')}
                onClick={() => setPin('')}
              >
                <Icon name="x" size={20} />
              </button>
              <button className="btn-secondary min-h-14 text-xl" onClick={() => press('0')}>
                0
              </button>
              <button
                className="btn-secondary min-h-14"
                aria-label={t('hr.back')}
                onClick={() => setPin((p) => p.slice(0, -1))}
              >
                <Icon name="chevronLeft" size={20} />
              </button>
            </div>
            <ErrorText error={go.error} />
            <button
              className="btn-primary btn-lg w-full"
              disabled={pin.length < 4 || go.isPending}
              onClick={() => go.mutate()}
            >
              {t(who.state === 'IN' ? 'hr.clockOut' : 'hr.clockIn')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
