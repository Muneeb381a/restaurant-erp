import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr, parseRs } from '../../lib/money';
import { can, useBill, useMe, usePaymentMethods } from '../../lib/queries';
import type { Bill, PaymentMethod, SettleResult } from '../../lib/types';

interface TenderRow {
  key: number;
  methodId: string;
  amount: string;
  tendered: string;
  reference: string;
}

const QUICK_CASH = [500, 1000, 5000];

/** Pre-bill review → discount → tenders → settle → change due. All totals come from the server. */
export function PayPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useMe();
  const bill = useBill(id, true);
  const methods = usePaymentMethods();

  const [rows, setRows] = useState<TenderRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SettleResult | null>(null);
  const [needApprover, setNeedApprover] = useState<{ percentBps: number; reason: string } | null>(
    null,
  );
  const [approverWrong, setApproverWrong] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const seq = useRef(0);
  // One key per payment attempt: a retry after a network drop can never charge twice.
  const idemKey = useRef(`pay-${crypto.randomUUID()}`);

  const b = bill.data;
  const apply = (next: Bill): void => {
    qc.setQueryData(['bill', id], next);
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['floor'] });
  };
  const fail = (e: unknown): void => {
    if (e instanceof ApiError) {
      const map: Record<string, string> = {
        SHIFT_NOT_OPEN: t('bill.noShift'),
        BILL_NOT_PAYABLE: t('bill.notPayable'),
        BILL_ALREADY_SETTLED: t('bill.notPayable'),
      };
      setMessage(map[e.code] ?? e.message);
      if (e.code === 'BILL_NOT_PAYABLE' || e.code === 'BILL_ALREADY_SETTLED') void bill.refetch();
    } else setMessage(t('common.error'));
  };

  const discount = useMutation({
    mutationFn: (v: {
      percentBps: number;
      reason?: string;
      approver?: { username: string; pin: string };
    }) => api<Bill>(`/bills/${b!.id}/discount`, { method: 'POST', body: v }),
    onSuccess: (next) => {
      apply(next);
      setNeedApprover(null);
      setMessage(null);
    },
    onError: (e, v) => {
      if (e instanceof ApiError && e.code === 'DISCOUNT_APPROVAL_REQUIRED') {
        setNeedApprover({ percentBps: v.percentBps, reason: v.reason ?? '' });
        setApproverWrong(false);
        setMessage(null);
      } else if (e instanceof ApiError && e.code === 'APPROVER_INVALID') {
        setApproverWrong(true); // shown inside the dialog, not as a second message on the page
      } else fail(e);
    },
  });
  const settle = useMutation({
    mutationFn: () => {
      const tenders = rows.map((r) => {
        const m = methods.data?.find((x) => x.id === r.methodId);
        const amountPaisa = parseRs(r.amount) ?? 0;
        return {
          methodId: r.methodId,
          amountPaisa,
          ...(m?.opens_drawer && r.tendered
            ? { tenderedPaisa: parseRs(r.tendered) ?? amountPaisa }
            : {}),
          ...(r.reference.trim() ? { reference: r.reference.trim() } : {}),
        };
      });
      return api<SettleResult>(`/bills/${b!.id}/settle`, {
        method: 'POST',
        body: { tenders },
        headers: { 'idempotency-key': idemKey.current },
      });
    },
    onSuccess: (out) => {
      apply(out.bill);
      setResult(out);
      setMessage(null);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 400) setMessage(t('bill.short'));
      else fail(e);
    },
  });
  const reprint = useMutation({
    mutationFn: () =>
      api(`/bills/${b!.id}/reprint`, { method: 'POST', body: { reason: 'Customer copy' } }),
    onSuccess: () => setMessage(t('bill.reprinted')),
    onError: fail,
  });
  const voidBill = useMutation({
    mutationFn: (reason: string) =>
      api<Bill>(`/bills/${b!.id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', id] });
      void qc.invalidateQueries({ queryKey: ['floor'] });
      nav(`/order/${id}`);
    },
    onError: fail,
  });

  if (bill.isPending || methods.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (!b || bill.isError) return <p className="p-4 text-rose-700">{t('common.error')}</p>;

  const settled = b.status === 'SETTLED';
  const payable = b.status === 'PRE_BILLED';
  const enteredPaisa = rows.reduce((n, r) => n + (parseRs(r.amount) ?? 0), 0);
  const remaining = b.totalPaisa - enteredPaisa; // display hint only; the server re-validates
  const methodOf = (mid: string): PaymentMethod | undefined =>
    methods.data?.find((m) => m.id === mid);

  const addRow = (m: PaymentMethod): void => {
    const rest = Math.max(remaining, 0);
    setRows((rs) => [
      ...rs,
      {
        key: ++seq.current,
        methodId: m.id,
        amount: rest > 0 ? (rest / 100).toFixed(2) : '',
        tendered: '',
        reference: '',
      },
    ]);
  };
  const patch = (key: number, p: Partial<TenderRow>): void =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const rowsValid =
    rows.length > 0 &&
    remaining === 0 &&
    rows.every((r) => {
      const m = methodOf(r.methodId);
      const amt = parseRs(r.amount);
      if (!amt || amt <= 0) return false;
      if (m?.needs_reference && r.reference.trim().length === 0) return false;
      if (m?.opens_drawer && r.tendered) {
        const tn = parseRs(r.tendered);
        if (tn === null || tn < amt) return false;
      }
      return true;
    });

  // ── receipt / change screen
  if (result || settled) {
    const change = result?.changeDuePaisa ?? b.changeDuePaisa;
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <div className="text-2xl font-bold text-emerald-700">✓ {t('bill.settled')}</div>
        <div className="text-slate-600">
          {t('bill.billNo')} {ltr(`#${b.billNo}`)} · {ltr(formatRs(b.totalPaisa))}
        </div>
        <div className="card p-6">
          <div className="text-sm text-slate-500">{t('bill.change')}</div>
          <div data-testid="change-due" className="text-5xl font-bold">
            {change > 0 ? ltr(formatRs(change)) : t('bill.changeNone')}
          </div>
        </div>
        {message && (
          <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
            {message}
          </p>
        )}
        <div className="flex gap-2">
          {can(me.data, 'bill.reprint') && (
            <button
              className="btn-secondary flex-1"
              disabled={reprint.isPending}
              onClick={() => reprint.mutate()}
            >
              {t('bill.reprint')}
            </button>
          )}
          <Link to="/" className="btn-primary flex-1">
            {t('bill.done')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-3 md:grid-cols-2">
      {/* ── the bill */}
      <section className="card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Link to={`/order/${id}`} className="btn-secondary">
            ←
          </Link>
          <h1 className="me-auto text-xl font-bold">
            {t('bill.billNo')} {ltr(`#${b.billNo}`)}
          </h1>
        </div>
        <ul className="divide-y divide-slate-100">
          {b.lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-2 py-2">
              <span>
                {ltr(`${l.qty}×`)} {l.description}
              </span>
              <span>{ltr(formatRs(l.netPaisa))}</span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1 border-t border-slate-200 pt-2">
          <Row label={t('bill.subtotal')} paisa={b.subtotalPaisa} />
          {b.discountPaisa > 0 && <Row label={t('bill.discount')} paisa={-b.discountPaisa} />}
          {b.serviceChargePaisa > 0 && (
            <Row label={t('bill.service')} paisa={b.serviceChargePaisa} />
          )}
          {b.taxPaisa > 0 && <Row label={t('bill.tax')} paisa={b.taxPaisa} />}
          {b.roundOffPaisa !== 0 && <Row label={t('bill.roundOff')} paisa={b.roundOffPaisa} />}
          <div className="flex justify-between text-2xl font-bold">
            <dt>{t('bill.total')}</dt>
            <dd data-testid="bill-total">{ltr(formatRs(b.totalPaisa))}</dd>
          </div>
        </dl>

        {payable && can(me.data, 'bill.discount') && (
          <DiscountBox
            busy={discount.isPending}
            hasDiscount={b.discountPaisa > 0}
            onApply={(pct, reason) => discount.mutate({ percentBps: pct, reason })}
            onRemove={() => discount.mutate({ percentBps: 0 })}
          />
        )}
        {payable && can(me.data, 'bill.void') && (
          <button className="btn-secondary w-full text-rose-700" onClick={() => setVoiding(true)}>
            {t('bill.voidBill')}
          </button>
        )}
      </section>

      {/* ── payment */}
      <section className="card space-y-3 p-4">
        <h2 className="text-xl font-bold">{t('bill.pay')}</h2>
        {message && (
          <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {message}
          </p>
        )}
        {(methods.data ?? []).length === 0 && (
          <p className="text-slate-500">{t('bill.noMethods')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {(methods.data ?? [])
            .filter((m) => m.code !== 'KHATA')
            .map((m) => (
              <button
                key={m.id}
                className="btn-secondary"
                disabled={!payable}
                onClick={() => addRow(m)}
              >
                + {m.name}
              </button>
            ))}
        </div>

        {rows.map((r) => {
          const m = methodOf(r.methodId)!;
          return (
            <div
              key={r.key}
              className="space-y-2 rounded-lg border border-slate-200 p-3"
              data-testid={`tender-${m.code}`}
            >
              <div className="flex items-center gap-2">
                <span className="me-auto font-semibold">{m.name}</span>
                <button
                  className="btn-secondary"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  {t('bill.remove')}
                </button>
              </div>
              <label className="block text-sm">
                {t('bill.amount')}
                <input
                  className="input"
                  inputMode="decimal"
                  aria-label={`${m.name} ${t('bill.amount')}`}
                  value={r.amount}
                  onChange={(e) => patch(r.key, { amount: e.target.value })}
                />
              </label>
              {m.opens_drawer && (
                <div className="space-y-1">
                  <label className="block text-sm">
                    {t('bill.tendered')}
                    <input
                      className="input"
                      inputMode="decimal"
                      aria-label={t('bill.tendered')}
                      value={r.tendered}
                      onChange={(e) => patch(r.key, { tendered: e.target.value })}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary"
                      onClick={() => patch(r.key, { tendered: r.amount })}
                    >
                      {t('bill.exact')}
                    </button>
                    {QUICK_CASH.map((q) => (
                      <button
                        key={q}
                        className="btn-secondary"
                        onClick={() => patch(r.key, { tendered: String(q) })}
                      >
                        {ltr(String(q))}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {m.needs_reference && (
                <label className="block text-sm">
                  {t('bill.reference')}
                  <input
                    className="input"
                    aria-label={t('bill.reference')}
                    value={r.reference}
                    onChange={(e) => patch(r.key, { reference: e.target.value })}
                  />
                </label>
              )}
            </div>
          );
        })}

        <div className="flex justify-between text-lg">
          <span>{remaining > 0 ? t('bill.due') : t('bill.paid')}</span>
          <span data-testid="remaining">{ltr(formatRs(Math.abs(remaining)))}</span>
        </div>
        <button
          className="btn-primary h-16 w-full text-xl"
          disabled={!payable || !rowsValid || settle.isPending}
          onClick={() => settle.mutate()}
        >
          {t('bill.settle')}
        </button>
      </section>

      {needApprover && (
        <ApproverDialog
          busy={discount.isPending}
          wrong={approverWrong}
          onClose={() => setNeedApprover(null)}
          onSubmit={(username, pin) =>
            discount.mutate({
              percentBps: needApprover.percentBps,
              reason: needApprover.reason,
              approver: { username, pin },
            })
          }
        />
      )}
      {voiding && (
        <ReasonDialog
          title={t('bill.voidBill')}
          prompt={t('bill.voidReason')}
          busy={voidBill.isPending}
          onClose={() => setVoiding(false)}
          onSubmit={(reason) => voidBill.mutate(reason)}
        />
      )}
    </div>
  );
}

function Row({ label, paisa }: { label: string; paisa: number }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd>{ltr(formatRs(paisa))}</dd>
    </div>
  );
}

function DiscountBox({
  busy,
  hasDiscount,
  onApply,
  onRemove,
}: {
  busy: boolean;
  hasDiscount: boolean;
  onApply: (percentBps: number, reason: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [pct, setPct] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <div className="font-semibold">{t('bill.addDiscount')}</div>
      <div className="flex flex-wrap gap-2">
        {[5, 10, 15, 20].map((p) => (
          <button
            key={p}
            className={pct === p ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setPct(p)}
          >
            {ltr(`${p}%`)}
          </button>
        ))}
      </div>
      <input
        className="input"
        placeholder={t('bill.discountReason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          className="btn-secondary flex-1"
          disabled={busy || pct === null || reason.trim().length < 3}
          onClick={() => onApply(pct! * 100, reason.trim())}
        >
          {t('bill.apply')}
        </button>
        {hasDiscount && (
          <button className="btn-secondary flex-1" disabled={busy} onClick={onRemove}>
            {t('bill.removeDiscount')}
          </button>
        )}
      </div>
    </div>
  );
}

function ApproverDialog({
  busy,
  wrong,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  wrong: boolean;
  onClose: () => void;
  onSubmit: (username: string, pin: string) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-sm space-y-3 p-5">
        <h2 className="text-lg font-bold">{t('bill.approverTitle')}</h2>
        {wrong && (
          <p role="alert" className="text-sm text-rose-700">
            {t('bill.approverWrong')}
          </p>
        )}
        <input
          className="input"
          autoFocus
          placeholder={t('bill.approverUser')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="input"
          type="password"
          inputMode="numeric"
          placeholder={t('bill.approverPin')}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary flex-1"
            disabled={busy || !username.trim() || !/^\d{4,8}$/.test(pin)}
            onClick={() => onSubmit(username.trim(), pin)}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReasonDialog({
  title,
  prompt,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  prompt: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-sm space-y-3 p-5">
        <h2 className="text-lg font-bold">{title}</h2>
        <input
          className="input"
          autoFocus
          placeholder={prompt}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-danger flex-1"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onSubmit(reason.trim())}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
