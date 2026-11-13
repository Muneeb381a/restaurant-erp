import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import { Modal as SharedModal } from '../../components/Modal';
import { ApiError, api } from '../../lib/api';
import { formatAge } from '../../lib/age';
import { formatRs, ltr, parseRs } from '../../lib/money';
import type { Shift } from '../../lib/types';
import { SummaryShare } from '../reports/SummaryShare';

/** What the till shows about an open shift. The expected cash is null for a cashier: the count is blind. */
interface ShiftOverview {
  shift: { cashier: string; openedAt: string };
  cash: {
    openingFloatPaisa: number;
    paidOutPaisa: number;
    cashInPaisa: number;
    dropsPaisa: number;
    noSaleCount: number;
  };
  expectedCashPaisa: number | null;
}
interface ShiftResult {
  expectedCashPaisa: number | null;
  countedCashPaisa: number | null;
  variancePaisa: number | null;
}
interface DayClosed {
  report: { sales: { totalPaisa: number; billCount: number }; varianceTotalPaisa: number };
}

const newKey = (): string => `ui-${crypto.randomUUID()}`;

function Modal({
  title,
  children,
  size = 'sm',
}: {
  title: string;
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  // these dialogs carry half-typed amounts and counts: they close only through their own buttons
  return (
    <SharedModal title={title} size={size} dismissible={false} onClose={() => undefined}>
      <div className="space-y-4">{children}</div>
    </SharedModal>
  );
}

type Kind = 'PAID_OUT' | 'CASH_IN' | 'DROP';
const MOVES: { kind: Kind; label: string; hint: string; icon: IconName }[] = [
  { kind: 'PAID_OUT', label: 'cash.paidOut', hint: 'cash.paidOutHint', icon: 'minus' },
  { kind: 'CASH_IN', label: 'cash.cashIn', hint: 'cash.cashInHint', icon: 'plus' },
  { kind: 'DROP', label: 'cash.drop', hint: 'cash.dropHint', icon: 'box' },
];

/** A figure of the shift so far. */
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-slate-600">
        {label}
      </div>
      <div className="money text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-slate-600">{sub}</div>}
    </div>
  );
}

/** A big touch target: what it does, and in one line when you would use it. */
function Action({
  icon,
  title,
  hint,
  tone,
  onClick,
}: {
  icon: IconName;
  title: string;
  hint: string;
  tone?: 'danger';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[4rem] w-full items-center gap-3 rounded-xl border p-3 text-start transition-colors ${
        tone === 'danger'
          ? 'border-rose-200 bg-rose-50 text-rose-900 hover:bg-rose-100'
          : 'border-slate-300 bg-white hover:bg-slate-50'
      }`}
    >
      <span
        className={`flex size-11 shrink-0 items-center justify-center rounded-xl text-white ${tone === 'danger' ? 'bg-rose-600' : 'bg-slate-900'}`}
      >
        <Icon name={icon} size={22} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm font-normal text-slate-600">{hint}</span>
      </span>
      <Icon name="chevronRight" size={18} data-flip className="text-slate-400" />
    </button>
  );
}

/** The cashier's drawer: what the shift looks like, paid-out / cash-in / drop, a no-sale open, closing the shift. */
export function ShiftDialog({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'menu' | 'move' | 'nosale' | 'close' | 'closed'>('menu');
  const [kind, setKind] = useState<Kind>('PAID_OUT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [result, setResult] = useState<ShiftResult | null>(null);
  const key = useRef(newKey()); // one key per form: a double tap can never record it twice
  const overview = useQuery({
    queryKey: ['shift', 'overview', shift.id],
    queryFn: () => api<ShiftOverview>(`/shifts/${shift.id}/report`),
    refetchInterval: 30_000,
  });

  const fail = (e: unknown): void => {
    const text =
      e instanceof ApiError && e.body.reason === 'DRAWER_INSUFFICIENT_CASH'
        ? t('cash.notEnough')
        : e instanceof ApiError && e.code === 'VARIANCE_NOTE_REQUIRED'
          ? t('cash.needNote')
          : e instanceof ApiError
            ? e.message
            : t('common.error');
    setMessage({ ok: false, text });
  };
  const done = (msg: string): void => {
    setMessage({ ok: true, text: msg });
    setAmount('');
    setReason('');
    key.current = newKey();
    setMode('menu');
    void qc.invalidateQueries({ queryKey: ['shift', 'overview'] });
  };

  const movement = useMutation({
    mutationFn: () =>
      api('/cash-movements', {
        method: 'POST',
        body: { kind, amountPaisa: parseRs(amount) ?? 0, reason: reason.trim() },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: () => done(t('cash.saved')),
    onError: fail,
  });
  const noSale = useMutation({
    mutationFn: () =>
      api('/drawer/open', {
        method: 'POST',
        body: { reason: reason.trim() },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: () => done(t('cash.drawerOpened')),
    onError: fail,
  });
  const close = useMutation({
    mutationFn: () =>
      api<{ report: ShiftResult }>(`/shifts/${shift.id}/close`, {
        method: 'POST',
        body: {
          countedCashPaisa: parseRs(counted) ?? 0,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      }),
    onSuccess: async (out) => {
      setResult(out.report);
      setMode('closed');
      setMessage(null);
      await qc.invalidateQueries({ queryKey: ['shift'] });
    },
    onError: fail,
  });

  const back = (
    <button
      className="btn-secondary flex-1"
      onClick={() => {
        setMessage(null);
        if (mode === 'menu') onClose();
        else setMode('menu');
      }}
    >
      {mode === 'menu' ? t('common.close') : t('cash.back')}
    </button>
  );
  const banner = message && (
    <p
      role={message.ok ? 'status' : 'alert'}
      className={`rounded-lg p-3 text-sm font-medium ${message.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}
    >
      {message.text}
    </p>
  );
  const go = (m: typeof mode) => () => {
    setMessage(null);
    setMode(m);
  };

  // ───── the shift is closed: how the count compared ─────
  if (mode === 'closed' && result) {
    const v = result.variancePaisa ?? 0;
    const tone = v === 0 ? 'ok' : v < 0 ? 'bad' : 'warn';
    return (
      <Modal title={t('cash.closedTitle')}>
        <div
          className={`flex items-center gap-3 rounded-xl p-4 ${tone === 'ok' ? 'bg-emerald-50 text-emerald-900' : tone === 'bad' ? 'bg-rose-50 text-rose-900' : 'bg-amber-50 text-amber-900'}`}
          data-testid="variance"
        >
          <span
            className={`flex size-11 shrink-0 items-center justify-center rounded-full text-white ${tone === 'ok' ? 'bg-emerald-600' : tone === 'bad' ? 'bg-rose-600' : 'bg-amber-500'}`}
          >
            <Icon name={v === 0 ? 'check' : 'alert'} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold">
              {v === 0 ? t('cash.matches') : v < 0 ? t('cash.short') : t('cash.over')}
            </div>
            {v !== 0 && <div className="money text-xl">{ltr(formatRs(Math.abs(v)))}</div>}
          </div>
        </div>
        <dl className="divide-y divide-slate-200 text-sm">
          <div className="flex justify-between py-2">
            <dt className="text-slate-600">{t('cash.expected')}</dt>
            <dd className="money font-medium">{ltr(formatRs(result.expectedCashPaisa ?? 0))}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-slate-600">{t('cash.countedLbl')}</dt>
            <dd className="money font-medium">{ltr(formatRs(result.countedCashPaisa ?? 0))}</dd>
          </div>
        </dl>
        <p className="text-sm text-slate-600">{t('cash.slipPrinted')}</p>
        <button className="btn-primary w-full" onClick={onClose}>
          {t('common.close')}
        </button>
      </Modal>
    );
  }

  // ───── paid out / cash in / drop, and "no sale": a reason is always recorded ─────
  if (mode === 'move' || mode === 'nosale') {
    const isMove = mode === 'move';
    const valid = reason.trim().length >= 3 && (!isMove || (parseRs(amount) ?? 0) > 0);
    const suggestions = t(isMove ? `cash.suggest.${kind}` : 'cash.suggest.NO_SALE', {
      returnObjects: true,
    }) as unknown;
    const chips = Array.isArray(suggestions) ? (suggestions as string[]) : [];
    return (
      <Modal title={isMove ? t('cash.move') : t('cash.noSale')}>
        {isMove && (
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('cash.move')}>
            {MOVES.map((m) => (
              <button
                key={m.kind}
                aria-pressed={kind === m.kind}
                className={`flex flex-col items-center gap-1 rounded-xl border p-2 text-center text-sm font-semibold ${kind === m.kind ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                onClick={() => setKind(m.kind)}
              >
                <Icon name={m.icon} size={20} />
                {t(m.label)}
              </button>
            ))}
          </div>
        )}
        {isMove && (
          <p className="hint -mt-2">{t(MOVES.find((m) => m.kind === kind)?.hint ?? '')}</p>
        )}
        {!isMove && <p className="hint">{t('cash.noSaleHint')}</p>}
        {isMove && (
          <input
            className="input text-2xl font-semibold"
            inputMode="decimal"
            placeholder={t('cash.amount')}
            aria-label={t('cash.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
        <div className="space-y-2">
          <input
            className="input"
            placeholder={t('cash.reason')}
            aria-label={t('cash.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip-mute cursor-pointer px-3 py-1.5 text-sm hover:bg-slate-200"
                  onClick={() => setReason(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
        {banner}
        <div className="flex gap-2">
          {back}
          <button
            className="btn-primary flex-1"
            disabled={!valid || movement.isPending || noSale.isPending}
            onClick={() => (isMove ? movement.mutate() : noSale.mutate())}
          >
            {t('cash.save')}
          </button>
        </div>
      </Modal>
    );
  }

  // ───── closing: count the drawer (blind: the expected amount is not shown) ─────
  if (mode === 'close') {
    return (
      <Modal title={t('cash.closeShift')}>
        <ol className="space-y-2 text-sm text-slate-700">
          {(['cash.closeStep1', 'cash.closeStep2', 'cash.closeStep3'] as const).map((k, i) => (
            <li key={k} className="flex items-start gap-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                {i + 1}
              </span>
              {t(k)}
            </li>
          ))}
        </ol>
        <p className="text-sm font-medium text-slate-800">{t('cash.count')}</p>
        <input
          className="input text-2xl font-semibold"
          inputMode="decimal"
          placeholder={t('cash.counted')}
          aria-label={t('cash.counted')}
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          autoFocus
        />
        <input
          className="input"
          placeholder={t('cash.notes')}
          aria-label={t('cash.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {banner}
        <div className="flex gap-2">
          {back}
          <button
            className="btn-danger flex-1"
            disabled={parseRs(counted) === null || close.isPending}
            onClick={() => close.mutate()}
          >
            {t('cash.closeShift')}
          </button>
        </div>
      </Modal>
    );
  }

  // ───── the drawer: the shift at a glance, then what you can do ─────
  const o = overview.data;
  const openedMs = o ? Date.parse(o.shift.openedAt) : NaN;
  const minutes = Number.isNaN(openedMs) ? null : (Date.now() - openedMs) / 60_000;
  return (
    <Modal title={t('cash.drawer')} size="md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="chip-ok">{t('shell.statusOpen')}</span>
        {o && (
          <span className="text-sm text-slate-700">
            {o.shift.cashier}
            {minutes !== null ? ` · ${t('cash.running', { time: formatAge(minutes, t) })}` : ''}
          </span>
        )}
      </div>
      {o && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label={t('cash.openingCash')} value={ltr(formatRs(o.cash.openingFloatPaisa))} />
          <Tile label={t('cash.paidOut')} value={ltr(formatRs(o.cash.paidOutPaisa))} />
          <Tile label={t('cash.cashIn')} value={ltr(formatRs(o.cash.cashInPaisa))} />
          <Tile label={t('cash.drop')} value={ltr(formatRs(o.cash.dropsPaisa))} />
        </div>
      )}
      {o && o.cash.noSaleCount > 0 && (
        <p className="text-sm text-slate-600">{t('cash.noSaleN', { count: o.cash.noSaleCount })}</p>
      )}
      {o && o.expectedCashPaisa !== null && (
        <div className="flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
          <span className="text-sm font-medium">{t('cash.shouldBeNow')}</span>
          <span className="money text-xl font-semibold">{ltr(formatRs(o.expectedCashPaisa))}</span>
        </div>
      )}
      {banner}
      <div className="space-y-2">
        <Action icon="swap" title={t('cash.move')} hint={t('cash.moveHint')} onClick={go('move')} />
        <Action
          icon="cash"
          title={t('cash.noSale')}
          hint={t('cash.noSaleCardHint')}
          onClick={go('nosale')}
        />
        <Action
          icon="logout"
          tone="danger"
          title={t('cash.closeShift')}
          hint={t('cash.closeHint')}
          onClick={go('close')}
        />
      </div>
      <div className="flex gap-2">{back}</div>
    </Modal>
  );
}

/** Manager: ends the trading day. The server lists anything still blocking (shifts, unsettled orders). */
export function DayCloseDialog({
  date,
  onClose,
}: {
  date?: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DayClosed['report'] | null>(null);

  const close = useMutation({
    mutationFn: () => api<DayClosed>('/business-days/close', { method: 'POST' }),
    onSuccess: async (out) => {
      setResult(out.report);
      await Promise.all(
        ['day', 'shift', 'floor'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
      );
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SHIFTS_STILL_OPEN')
        setMessage(t('cash.openShifts', { names: (e.body.cashiers as string[]).join(', ') }));
      else if (e instanceof ApiError && e.code === 'ORDERS_STILL_OPEN')
        setMessage(
          t('cash.openOrders', {
            orders: (e.body.orders as { orderNo: number }[]).map((o) => `#${o.orderNo}`).join(', '),
          }),
        );
      else setMessage(e instanceof ApiError ? e.message : t('common.error'));
    },
  });

  if (result)
    return (
      <Modal title={t('cash.dayDone')}>
        <div className="flex items-center gap-3 rounded-xl bg-emerald-50 p-4 text-emerald-900">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
            <Icon name="check" size={22} />
          </span>
          <div>
            <div className="text-sm font-medium">{t('cash.netSales')}</div>
            <div className="money text-2xl font-semibold" data-testid="day-total">
              {ltr(formatRs(result.sales.totalPaisa))}
            </div>
          </div>
        </div>
        <dl className="divide-y divide-slate-200 text-sm">
          <div className="flex justify-between py-2">
            <dt className="text-slate-600">{t('cash.totalVariance')}</dt>
            <dd className="money font-medium">{ltr(formatRs(result.varianceTotalPaisa))}</dd>
          </div>
        </dl>
        <p className="text-sm text-slate-600">{t('cash.slipPrinted')}</p>
        {date && (
          <div className="space-y-1 border-t border-slate-200 pt-3">
            <h3 className="font-semibold">{t('summary.title')}</h3>
            <SummaryShare date={date} />
          </div>
        )}
        <button className="btn-primary w-full" onClick={onClose}>
          {t('common.close')}
        </button>
      </Modal>
    );

  return (
    <Modal title={t('cash.dayTitle')}>
      <p className="rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900">
        {t('cash.dayWarn')}
      </p>
      <div>
        <div className="micro mb-1">{t('cash.dayBefore')}</div>
        <ul className="space-y-1.5 text-sm text-slate-700">
          {(['cash.dayCheck1', 'cash.dayCheck2'] as const).map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Icon name="check" size={16} className="mt-0.5 text-slate-500" />
              {t(k)}
            </li>
          ))}
        </ul>
      </div>
      {message && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {message}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn-secondary flex-1" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn-danger flex-1"
          disabled={close.isPending}
          onClick={() => close.mutate()}
        >
          {t('cash.closeDay')}
        </button>
      </div>
    </Modal>
  );
}
