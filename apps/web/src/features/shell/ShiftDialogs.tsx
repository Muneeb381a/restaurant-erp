import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal as SharedModal } from '../../components/Modal';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr, parseRs } from '../../lib/money';
import type { Shift } from '../../lib/types';

interface ShiftReport {
  expectedCashPaisa: number | null;
  countedCashPaisa: number | null;
  variancePaisa: number | null;
}
interface DayClosed {
  report: { sales: { totalPaisa: number; billCount: number }; varianceTotalPaisa: number };
}

const newKey = (): string => `ui-${crypto.randomUUID()}`;

function Modal({ title, children }: { title: string; children: React.ReactNode }) {
  // these dialogs carry half-typed amounts and counts: they close only through their own buttons
  return (
    <SharedModal title={title} size="sm" dismissible={false} onClose={() => undefined}>
      <div className="space-y-3">{children}</div>
    </SharedModal>
  );
}

const MOVES = [
  ['PAID_OUT', 'cash.paidOut'],
  ['CASH_IN', 'cash.cashIn'],
  ['DROP', 'cash.drop'],
] as const;

/** The cashier's drawer: paid-out / cash-in / drop, a no-sale open, and closing the shift. */
export function ShiftDialog({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'menu' | 'move' | 'nosale' | 'close' | 'closed'>('menu');
  const [kind, setKind] = useState<(typeof MOVES)[number][0]>('PAID_OUT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ShiftReport | null>(null);
  const key = useRef(newKey()); // one key per form: a double tap can never record it twice

  const fail = (e: unknown): void => {
    if (e instanceof ApiError && e.body.reason === 'DRAWER_INSUFFICIENT_CASH')
      setMessage(t('cash.notEnough'));
    else if (e instanceof ApiError && e.code === 'VARIANCE_NOTE_REQUIRED')
      setMessage(t('cash.needNote'));
    else setMessage(e instanceof ApiError ? e.message : t('common.error'));
  };
  const done = (msg: string): void => {
    setMessage(msg);
    setAmount('');
    setReason('');
    key.current = newKey();
    setMode('menu');
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
      api<{ report: ShiftReport }>(`/shifts/${shift.id}/close`, {
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
      onClick={() => (mode === 'menu' ? onClose() : setMode('menu'))}
    >
      {mode === 'menu' ? t('common.close') : t('cash.back')}
    </button>
  );
  const err = message && (
    <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
      {message}
    </p>
  );

  if (mode === 'closed' && result) {
    const v = result.variancePaisa ?? 0;
    return (
      <Modal title={t('cash.closedTitle')}>
        <dl className="space-y-1">
          <div className="flex justify-between">
            <dt>{t('cash.expected')}</dt>
            <dd>{ltr(formatRs(result.expectedCashPaisa ?? 0))}</dd>
          </div>
          <div className="flex justify-between">
            <dt>{t('cash.countedLbl')}</dt>
            <dd>{ltr(formatRs(result.countedCashPaisa ?? 0))}</dd>
          </div>
          <div className="flex justify-between text-lg font-bold" data-testid="variance">
            <dt>{v === 0 ? t('cash.matches') : v < 0 ? t('cash.short') : t('cash.over')}</dt>
            <dd>{v === 0 ? '✓' : ltr(formatRs(Math.abs(v)))}</dd>
          </div>
        </dl>
        <p className="text-sm text-slate-600">{t('cash.slipPrinted')}</p>
        <button className="btn-primary w-full" onClick={onClose}>
          {t('common.close')}
        </button>
      </Modal>
    );
  }

  if (mode === 'move' || mode === 'nosale') {
    const isMove = mode === 'move';
    const valid = reason.trim().length >= 3 && (!isMove || (parseRs(amount) ?? 0) > 0);
    return (
      <Modal title={isMove ? t('cash.move') : t('cash.noSale')}>
        {isMove && (
          <div className="flex gap-2">
            {MOVES.map(([k, label]) => (
              <button
                key={k}
                className={kind === k ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
                onClick={() => setKind(k)}
              >
                {t(label)}
              </button>
            ))}
          </div>
        )}
        {isMove && (
          <input
            className="input"
            inputMode="decimal"
            placeholder={t('cash.amount')}
            aria-label={t('cash.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
        <input
          className="input"
          placeholder={t('cash.reason')}
          aria-label={t('cash.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {err}
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

  if (mode === 'close') {
    return (
      <Modal title={t('cash.closeShift')}>
        <p className="text-sm text-slate-600">{t('cash.count')}</p>
        <input
          className="input"
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
        {err}
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

  return (
    <Modal title={t('cash.drawer')}>
      {err}
      <button
        className="btn-secondary w-full"
        onClick={() => {
          setMessage(null);
          setMode('move');
        }}
      >
        {t('cash.move')}
      </button>
      <button
        className="btn-secondary w-full"
        onClick={() => {
          setMessage(null);
          setMode('nosale');
        }}
      >
        {t('cash.noSale')}
      </button>
      <button
        className="btn-danger-quiet w-full"
        onClick={() => {
          setMessage(null);
          setMode('close');
        }}
      >
        {t('cash.closeShift')}
      </button>
      <div className="flex gap-2">{back}</div>
    </Modal>
  );
}

/** Manager: ends the trading day. The server lists anything still blocking (shifts, unsettled orders). */
export function DayCloseDialog({ onClose }: { onClose: () => void }) {
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
        <dl className="space-y-1">
          <div className="flex justify-between">
            <dt>{t('cash.netSales')}</dt>
            <dd data-testid="day-total">{ltr(formatRs(result.sales.totalPaisa))}</dd>
          </div>
          <div className="flex justify-between">
            <dt>{t('cash.totalVariance')}</dt>
            <dd>{ltr(formatRs(result.varianceTotalPaisa))}</dd>
          </div>
        </dl>
        <p className="text-sm text-slate-600">{t('cash.slipPrinted')}</p>
        <button className="btn-primary w-full" onClick={onClose}>
          {t('common.close')}
        </button>
      </Modal>
    );

  return (
    <Modal title={t('cash.dayTitle')}>
      <p className="text-sm text-slate-600">{t('cash.dayWarn')}</p>
      {message && (
        <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
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
