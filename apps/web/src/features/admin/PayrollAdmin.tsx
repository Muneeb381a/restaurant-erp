import { formatLeaveDays } from '@erp/domain';
import { Loader } from '../../components/Loader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { formatRs, parseRs } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import { Dialog, EmptyRow, ErrorText, Field, PageHead } from './ui';

interface RunRow {
  id: string;
  runNo: number;
  frequency: 'MONTHLY' | 'WEEKLY' | 'DAILY';
  from: string;
  to: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  people: number;
  grossPaisa: number;
  netPaisa: number;
  paidPaisa: number;
}
interface Line {
  id: string;
  kind: 'EARNING' | 'DEDUCTION';
  code: string;
  label: string;
  detail: string | null;
  amountPaisa: number;
  source: 'COMPUTED' | 'ITEM' | 'MANUAL';
}
interface Slip {
  id: string;
  code: string;
  fullName: string;
  designation: string;
  payType: 'MONTHLY' | 'DAILY' | 'HOURLY';
  ratePaisa: number;
  tally: Record<string, number>;
  lateCount: number;
  overtimeMinutes: number;
  warnings: string[];
  grossPaisa: number;
  deductionsPaisa: number;
  netPaisa: number;
  paidPaisa: number;
  lines: Line[];
}
interface RunDetail {
  id: string;
  runNo: number;
  frequency: RunRow['frequency'];
  from: string;
  to: string;
  status: RunRow['status'];
  slips: Slip[];
}

const STATUS_TONE: Record<RunRow['status'], string> = {
  DRAFT: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-slate-100 text-slate-600',
};
const newKey = (): string => `ui-${crypto.randomUUID()}`;
const money = (p: number): string => formatRs(p);

/** Pay runs: work out everybody's pay for a period, fix it, approve (locks it), then record the payments. */
export function PayrollAdmin() {
  const { t } = useTranslation();
  const me = useMe();
  const [tab, setTab] = useState<'runs' | 'rules'>('runs');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="max-w-6xl space-y-5 p-4 md:p-6">
      <PageHead title={t('payroll.title')} hint={t('payroll.hint')}>
        {can(me.data, 'settings.manage') && !open && (
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
            {(['runs', 'rules'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`min-h-9 rounded-md px-4 text-sm font-semibold ${tab === k ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
              >
                {t(`payroll.tab.${k}`)}
              </button>
            ))}
          </div>
        )}
      </PageHead>
      {open ? (
        <RunView id={open} onBack={() => setOpen(null)} />
      ) : tab === 'runs' ? (
        <Runs onOpen={setOpen} />
      ) : (
        <Rules />
      )}
    </div>
  );
}

// ───────────────────────────── list of runs ─────────────────────────────

function Runs({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const runs = useQuery({
    queryKey: ['payroll-runs'],
    queryFn: async () => (await api<{ items: RunRow[] }>('/payroll-runs')).items,
  });
  return (
    <>
      {can(me.data, 'payroll.manage') && (
        <div>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            {t('payroll.newRun')}
          </button>
        </div>
      )}
      <ErrorText error={runs.error} />
      <div className="dt">
        <table className="min-w-[44rem]">
          <thead>
            <tr>
              <th>{t('payroll.period')}</th>
              <th>{t('hr.status')}</th>
              <th>{t('payroll.people')}</th>
              <th>{t('payroll.net')}</th>
              <th>{t('payroll.paid')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).length === 0 && (
              <EmptyRow cols={6} icon="cash" loading={runs.isPending} text={t('payroll.noRuns')} />
            )}
            {(runs.data ?? []).map((r) => (
              <tr key={r.id} className={r.status === 'CANCELLED' ? 'opacity-50' : ''}>
                <td dir="ltr" className="font-semibold">
                  {r.from === r.to ? r.from : `${r.from} → ${r.to}`}
                  <div className="text-xs font-normal text-slate-500">
                    #{r.runNo} · {t(`payroll.freq.${r.frequency}`)}
                  </div>
                </td>
                <td>
                  <span
                    className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_TONE[r.status]}`}
                  >
                    {t(`payroll.st.${r.status}`)}
                  </span>
                </td>
                <td>{r.people}</td>
                <td>{money(r.netPaisa)}</td>
                <td
                  className={
                    r.status === 'APPROVED' && r.paidPaisa < r.netPaisa ? 'text-amber-700' : ''
                  }
                >
                  {r.status === 'APPROVED' ? money(r.paidPaisa) : '–'}
                </td>
                <td className="text-end">
                  <button
                    className="btn-secondary min-h-9 px-3 text-sm"
                    onClick={() => onOpen(r.id)}
                  >
                    {t('payroll.open')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <NewRun
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onOpen(id);
          }}
        />
      )}
    </>
  );
}

function NewRun({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const lastMonth = (): string => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return localDate(d).slice(0, 7);
  };
  const [frequency, setFrequency] = useState<'MONTHLY' | 'WEEKLY' | 'DAILY'>('MONTHLY');
  const [month, setMonth] = useState(lastMonth());
  const [from, setFrom] = useState(localDate());
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/payroll-runs', {
        method: 'POST',
        body: frequency === 'MONTHLY' ? { frequency, month } : { frequency, from },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['payroll-runs'] });
      onCreated(r.id);
    },
  });
  return (
    <Dialog title={t('payroll.newRun')} onClose={onClose}>
      <div className="space-y-4">
        <Field label={t('payroll.frequency')}>
          <select
            className="input"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as typeof frequency)}
          >
            {(['MONTHLY', 'WEEKLY', 'DAILY'] as const).map((f) => (
              <option key={f} value={f}>
                {t(`payroll.freq.${f}`)}
              </option>
            ))}
          </select>
        </Field>
        {frequency === 'MONTHLY' ? (
          <Field label={t('payroll.month')}>
            <input
              type="month"
              className="input"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </Field>
        ) : (
          <Field label={frequency === 'WEEKLY' ? t('payroll.weekFrom') : t('hr.date')}>
            <input
              type="date"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
        )}
        <p className="hint">{t('payroll.newHint')}</p>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('payroll.calculate')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── one run ─────────────────────────────

function RunView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const run = useQuery({
    queryKey: ['payroll-run', id],
    queryFn: () => api<RunDetail>(`/payroll-runs/${id}`),
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<Slip | null>(null);
  const [payFor, setPayFor] = useState<Slip | null>(null);
  const [slipView, setSlipView] = useState<Slip | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [problems, setProblems] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['payroll-run', id] });
    await qc.invalidateQueries({ queryKey: ['payroll-runs'] });
  };
  const recalc = useMutation({
    mutationFn: () => api(`/payroll-runs/${id}/recalculate`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () => api(`/payroll-runs/${id}/approve`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setProblems(null);
      await refresh();
    },
    onError: (e) => setProblems(e instanceof ApiError ? e.message : t('common.error')),
  });
  const removeLine = useMutation({
    mutationFn: (lineId: string) => api(`/payslip-lines/${lineId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const d = run.data;
  if (!d) return <Loader />;
  const draft = d.status === 'DRAFT';
  const canManage = can(me.data, 'payroll.manage');
  const net = d.slips.reduce((n, s) => n + s.netPaisa, 0);
  const paid = d.slips.reduce((n, s) => n + s.paidPaisa, 0);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-secondary min-h-10 px-3"
          onClick={onBack}
          aria-label={t('payroll.back')}
        >
          <Icon name="chevronLeft" size={18} className="rtl:rotate-180" />
        </button>
        <div className="me-auto">
          <div className="text-lg font-semibold" dir="ltr">
            {d.from === d.to ? d.from : `${d.from} → ${d.to}`}
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_TONE[d.status]}`}>
            {t(`payroll.st.${d.status}`)}
          </span>
        </div>
        <div className="text-end">
          <div className="text-sm text-slate-500">{t('payroll.net')}</div>
          <div className="text-xl font-bold">{money(net)}</div>
          {d.status === 'APPROVED' && (
            <div className="text-xs text-slate-500">
              {t('payroll.paid')}: {money(paid)}
            </div>
          )}
        </div>
        {draft && canManage && (
          <>
            <button
              className="btn-secondary"
              disabled={recalc.isPending}
              onClick={() => recalc.mutate()}
            >
              {t('payroll.recalc')}
            </button>
            <button className="btn-danger-quiet" onClick={() => setCancelling(true)}>
              {t('payroll.cancelRun')}
            </button>
          </>
        )}
        {draft && can(me.data, 'payroll.approve') && (
          <button
            className="btn-primary"
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
          >
            <Icon name="check" size={18} />
            {t('payroll.approve')}
          </button>
        )}
      </div>
      {draft && <p className="hint">{t('payroll.draftHint')}</p>}
      {problems && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {problems}
        </p>
      )}
      <ErrorText error={recalc.error ?? removeLine.error} />

      <div className="dt">
        <table className="min-w-[48rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              <th>{t('payroll.days')}</th>
              <th>{t('payroll.gross')}</th>
              <th>{t('payroll.deductions')}</th>
              <th>{t('payroll.net')}</th>
              {!draft && <th>{t('payroll.paid')}</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {d.slips.length === 0 && <EmptyRow cols={7} icon="user" text={t('payroll.noSlips')} />}
            {d.slips.map((s) => {
              const tl = s.tally;
              const open = expanded === s.id;
              return (
                <Fragment key={s.id}>
                  <tr>
                    <td>
                      <button
                        className="text-start font-semibold underline-offset-2 hover:underline"
                        onClick={() => setExpanded(open ? null : s.id)}
                      >
                        {s.fullName}
                      </button>
                      <div className="text-xs text-slate-500">
                        {s.code} · {t(`hr.payType.${s.payType}`)}
                      </div>
                      {s.warnings.length > 0 && (
                        <div className="text-xs font-semibold text-amber-700">
                          {t('payroll.warn.' + s.warnings[0])}
                        </div>
                      )}
                    </td>
                    <td className="text-sm">
                      <span title={t('hr.st.PRESENT')}>P {formatLeaveDays(tl.workHalf ?? 0)}</span>
                      {' · '}
                      <span
                        title={t('hr.st.ABSENT')}
                        className={(tl.absentHalf ?? 0) > 0 ? 'text-rose-700' : ''}
                      >
                        A {formatLeaveDays(tl.absentHalf ?? 0)}
                      </span>
                      {' · '}
                      <span title={t('hr.st.LEAVE')}>
                        L {formatLeaveDays((tl.paidLeaveHalf ?? 0) + (tl.unpaidLeaveHalf ?? 0))}
                      </span>
                      {(tl.unmarkedHalf ?? 0) > 0 && (
                        <span className="ms-1 font-semibold text-amber-700">
                          ? {formatLeaveDays(tl.unmarkedHalf ?? 0)}
                        </span>
                      )}
                    </td>
                    <td>{money(s.grossPaisa)}</td>
                    <td>{money(s.deductionsPaisa)}</td>
                    <td className={s.netPaisa < 0 ? 'font-bold text-rose-700' : 'font-bold'}>
                      {money(s.netPaisa)}
                    </td>
                    {!draft && (
                      <td
                        className={s.paidPaisa < s.netPaisa ? 'text-amber-700' : 'text-emerald-700'}
                      >
                        {money(s.paidPaisa)}
                      </td>
                    )}
                    <td className="text-end">
                      <div className="flex justify-end gap-2">
                        {draft && canManage && (
                          <button
                            className="btn-secondary min-h-9 px-3 text-sm"
                            onClick={() => setAddFor(s)}
                          >
                            {t('payroll.addLine')}
                          </button>
                        )}
                        {d.status === 'APPROVED' &&
                          can(me.data, 'payroll.pay') &&
                          s.paidPaisa < s.netPaisa && (
                            <button
                              className="btn-primary min-h-9 px-3 text-sm"
                              onClick={() => setPayFor(s)}
                            >
                              {t('payroll.pay')}
                            </button>
                          )}
                        {d.status !== 'CANCELLED' && (
                          <button
                            className="btn-secondary min-h-9 px-3 text-sm"
                            onClick={() => setSlipView(s)}
                          >
                            {t('payroll.payslip')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={7} className="bg-slate-50">
                        <ul className="space-y-1 py-1 text-sm">
                          {s.lines.map((l) => (
                            <li key={l.id} className="flex items-center gap-3">
                              <span
                                className={`w-5 text-center font-bold ${l.kind === 'EARNING' ? 'text-emerald-700' : 'text-rose-700'}`}
                              >
                                {l.kind === 'EARNING' ? '+' : '−'}
                              </span>
                              <span className="me-auto">
                                {l.label}
                                {l.detail && (
                                  <span className="ms-2 text-xs text-slate-500">{l.detail}</span>
                                )}
                              </span>
                              <span dir="ltr">{money(l.amountPaisa)}</span>
                              {draft && canManage && l.source === 'MANUAL' && (
                                <button
                                  className="btn-danger-quiet min-h-8 px-2 text-xs"
                                  onClick={() => removeLine.mutate(l.id)}
                                >
                                  {t('admin.delete')}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {d.status === 'APPROVED' && <p className="hint">{t('payroll.lockedHint')}</p>}

      {addFor && (
        <AddLine
          slip={addFor}
          onClose={() => setAddFor(null)}
          onSaved={async () => {
            setAddFor(null);
            await refresh();
          }}
        />
      )}
      {payFor && (
        <PayDialog
          slip={payFor}
          onClose={() => setPayFor(null)}
          onSaved={async () => {
            setPayFor(null);
            await refresh();
          }}
        />
      )}
      {slipView && <PayslipView run={d} slip={slipView} onClose={() => setSlipView(null)} />}
      {cancelling && (
        <CancelDialog
          id={id}
          onClose={() => setCancelling(false)}
          onDone={async () => {
            setCancelling(false);
            await refresh();
            onBack();
          }}
        />
      )}
    </>
  );
}

function AddLine({
  slip,
  onClose,
  onSaved,
}: {
  slip: Slip;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'EARNING' | 'DEDUCTION'>('EARNING');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const paisa = parseRs(amount);
  const save = useMutation({
    mutationFn: () =>
      api(`/payslips/${slip.id}/lines`, {
        method: 'POST',
        body: { kind, label: label.trim(), amountPaisa: paisa },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={`${slip.fullName} · ${t('payroll.addLine')}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          {(['EARNING', 'DEDUCTION'] as const).map((k) => (
            <button
              key={k}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-11 flex-1 rounded-lg border font-semibold ${kind === k ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'}`}
            >
              {t(`payroll.kind.${k}`)}
            </button>
          ))}
        </div>
        <Field label={t('payroll.lineWhy')}>
          <input
            className="input"
            placeholder={t('payroll.lineExample')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label={t('payroll.amount')}>
          <input
            className="input"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <p className="hint">{t('payroll.lineHint')}</p>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!label.trim() || !paisa || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function PayDialog({
  slip,
  onClose,
  onSaved,
}: {
  slip: Slip;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const remaining = slip.netPaisa - slip.paidPaisa;
  const [amount, setAmount] = useState(String(remaining / 100));
  const [paidFrom, setPaidFrom] = useState<'BANK' | 'OWNER_CASH' | 'DRAWER_CASH'>('OWNER_CASH');
  const [note, setNote] = useState('');
  const key = useRef(newKey());
  const paisa = parseRs(amount);
  const save = useMutation({
    mutationFn: () =>
      api(`/payslips/${slip.id}/pay`, {
        method: 'POST',
        body: { amountPaisa: paisa, paidFrom, ...(note.trim() ? { note: note.trim() } : {}) },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={`${slip.fullName} · ${t('payroll.pay')}`} onClose={onClose}>
      <div className="space-y-4">
        <p>{t('payroll.owed', { amount: money(remaining) })}</p>
        <Field label={t('payroll.amount')}>
          <input
            className="input"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
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
        <Field label={t('hr.notes')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="hint">{t('payroll.payHint')}</p>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!paisa || paisa > remaining || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('payroll.recordPayment')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function CancelDialog({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const go = useMutation({
    mutationFn: () =>
      api(`/payroll-runs/${id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: onDone,
  });
  return (
    <Dialog title={t('payroll.cancelRun')} onClose={onClose}>
      <div className="space-y-4">
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

/** The slip as the person would get it: printable, with a WhatsApp text for sending it on. */
function PayslipView({ run, slip, onClose }: { run: RunDetail; slip: Slip; onClose: () => void }) {
  const { t } = useTranslation();
  const earn = slip.lines.filter((l) => l.kind === 'EARNING');
  const ded = slip.lines.filter((l) => l.kind === 'DEDUCTION');
  const text = [
    `${t('payroll.payslip')} ${run.from} → ${run.to}`,
    `${slip.fullName} (${slip.code})`,
    ...earn.map((l) => `+ ${l.label}: ${money(l.amountPaisa)}`),
    ...ded.map((l) => `− ${l.label}: ${money(l.amountPaisa)}`),
    `${t('payroll.net')}: ${money(slip.netPaisa)}`,
  ].join('\n');
  return (
    <Dialog title={t('payroll.payslip')} onClose={onClose}>
      <div className="payslip-print space-y-3 text-sm">
        <div className="flex justify-between gap-3">
          <div>
            <div className="text-lg font-bold">{slip.fullName}</div>
            <div className="text-slate-600">
              {slip.code} · {slip.designation}
            </div>
          </div>
          <div className="text-end text-slate-600" dir="ltr">
            {run.from === run.to ? run.from : `${run.from} → ${run.to}`}
          </div>
        </div>
        <table className="w-full">
          <tbody>
            {earn.map((l) => (
              <tr key={l.id}>
                <td className="py-0.5">
                  {l.label}
                  {l.detail && <span className="ms-2 text-xs text-slate-500">{l.detail}</span>}
                </td>
                <td className="text-end" dir="ltr">
                  {money(l.amountPaisa)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-slate-300 font-semibold">
              <td className="py-1">{t('payroll.gross')}</td>
              <td className="text-end" dir="ltr">
                {money(slip.grossPaisa)}
              </td>
            </tr>
            {ded.map((l) => (
              <tr key={l.id} className="text-rose-700">
                <td className="py-0.5">
                  − {l.label}
                  {l.detail && <span className="ms-2 text-xs">{l.detail}</span>}
                </td>
                <td className="text-end" dir="ltr">
                  {money(l.amountPaisa)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-900 text-base font-bold">
              <td className="py-1.5">{t('payroll.net')}</td>
              <td className="text-end" dir="ltr">
                {money(slip.netPaisa)}
              </td>
            </tr>
            {run.status === 'APPROVED' && (
              <tr className="text-slate-600">
                <td>{t('payroll.paid')}</td>
                <td className="text-end" dir="ltr">
                  {money(slip.paidPaisa)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {run.status === 'DRAFT' && (
          <p className="text-xs font-semibold text-amber-700">{t('payroll.draftSlip')}</p>
        )}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <a
          className="btn-secondary"
          href={`https://wa.me/?text=${encodeURIComponent(text)}`}
          target="_blank"
          rel="noreferrer"
        >
          {t('payroll.whatsapp')}
        </a>
        <button className="btn-primary" onClick={() => window.print()}>
          <Icon name="printer" size={18} />
          {t('payroll.print')}
        </button>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── the owner's rules ─────────────────────────────

type Settings = Record<string, unknown>;

/** Payroll rules the owner types. None is a legal default: see OPEN-QUESTIONS #46. */
function Rules() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const save = useMutation({
    mutationFn: (v: { key: string; value: unknown }) =>
      api(`/settings/${v.key}`, { method: 'PUT', body: { value: v.value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const d = s.data ?? {};
  const bool = (k: string, dflt = false): boolean =>
    typeof d[k] === 'boolean' ? (d[k] as boolean) : dflt;
  const num = (k: string, dflt: number): number =>
    typeof d[k] === 'number' ? (d[k] as number) : dflt;
  const set = (key: string, value: unknown): void => save.mutate({ key, value });
  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('payroll.rulesNote')}</p>
      <ErrorText error={save.error} />
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <Field label={t('payroll.rule.divisor')}>
          <select
            className="input max-w-sm"
            value={String(d['payroll.divisor'] ?? 'THIRTY')}
            onChange={(e) => set('payroll.divisor', e.target.value)}
          >
            <option value="THIRTY">{t('payroll.rule.thirty')}</option>
            <option value="CALENDAR">{t('payroll.rule.calendar')}</option>
          </select>
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={bool('payroll.overtime_enabled')}
            onChange={(e) => set('payroll.overtime_enabled', e.target.checked)}
          />
          {t('payroll.rule.overtime')}
        </label>
        <Field label={t('payroll.rule.multiplier')}>
          <select
            className="input max-w-sm"
            disabled={!bool('payroll.overtime_enabled')}
            value={num('payroll.overtime_multiplier_bps', 10_000)}
            onChange={(e) => set('payroll.overtime_multiplier_bps', Number(e.target.value))}
          >
            {[10_000, 12_500, 15_000, 20_000].map((v) => (
              <option key={v} value={v}>
                {v / 10_000}×
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('payroll.rule.lates')}>
          <input
            className="input w-28"
            dir="ltr"
            inputMode="numeric"
            defaultValue={num('payroll.lates_per_deduction_day', 0)}
            key={String(d['payroll.lates_per_deduction_day'])}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (
                Number.isInteger(n) &&
                n >= 0 &&
                n <= 31 &&
                n !== num('payroll.lates_per_deduction_day', 0)
              )
                set('payroll.lates_per_deduction_day', n);
            }}
          />
          <span className="hint block">{t('payroll.rule.latesHint')}</span>
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={bool('payroll.daily_paid_off_days')}
            onChange={(e) => set('payroll.daily_paid_off_days', e.target.checked)}
          />
          {t('payroll.rule.offDays')}
        </label>
      </div>
    </div>
  );
}
