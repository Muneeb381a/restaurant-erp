import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr, parseRs } from '../../lib/money';
import { can, useBill, useMe, usePaymentMethods } from '../../lib/queries';
import type { Bill, BillQuotes, KhataAccount, PaymentMethod, SettleResult } from '../../lib/types';
import { KhataPicker } from '../khata/KhataPicker';
import { RefundDialog } from './RefundDialog';

interface TenderRow {
  key: number;
  methodId: string;
  amount: string;
  tendered: string;
  reference: string;
  /** Khata tender only: the chosen customer account. */
  khata: KhataAccount | null;
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
  // what the bill totals for each payment class (the tax rate depends on how it is paid)
  const quotes = useQuery({
    queryKey: ['bill-quotes', bill.data?.id],
    queryFn: () => api<BillQuotes>(`/bills/${bill.data!.id}/quotes`),
    enabled: bill.data?.status === 'PRE_BILLED',
  });
  const methods = usePaymentMethods();

  const [rows, setRows] = useState<TenderRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SettleResult | null>(null);
  const [needApprover, setNeedApprover] = useState<{ percentBps: number; reason: string } | null>(
    null,
  );
  const [approverWrong, setApproverWrong] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [discounting, setDiscounting] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const seq = useRef(0);
  // One key per payment attempt: a retry after a network drop can never charge twice.
  const idemKey = useRef(`pay-${crypto.randomUUID()}`);

  const b = bill.data;
  const apply = (next: Bill): void => {
    void qc.cancelQueries({ queryKey: ['bill', id] });
    qc.setQueryData(['bill', id], next);
    void qc.invalidateQueries({ queryKey: ['order', id] });
    qc.removeQueries({ queryKey: ['floor'] }); // not invalidate: no stale floor may flash up
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
      void qc.invalidateQueries({ queryKey: ['bill-quotes'] });
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
          ...(r.khata ? { khataAccountId: r.khata.id } : {}),
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
      if (e instanceof ApiError && e.code === 'KHATA_LIMIT_EXCEEDED')
        setMessage(
          t('khata.limitExceeded', {
            available: ltr(formatRs(Number(e.body.availablePaisa ?? 0))),
          }),
        );
      else if (e instanceof ApiError && e.code === 'KHATA_ACCOUNT_INACTIVE')
        setMessage(t('khata.inactiveAcct'));
      else if (e instanceof ApiError && e.status === 400) setMessage(t('bill.short'));
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
      qc.removeQueries({ queryKey: ['floor'] }); // not invalidate: no stale floor may flash up
      nav(`/order/${id}`);
    },
    onError: fail,
  });

  if (bill.isPending || methods.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (!b || bill.isError) return <p className="p-4 text-rose-700">{t('common.error')}</p>;

  const settled = b.status === 'SETTLED';
  const payable = b.status === 'PRE_BILLED';
  const enteredPaisa = rows.reduce((n, r) => n + (parseRs(r.amount) ?? 0), 0);
  // all-digital tenders get the digital quote, anything else the cash/other one; the server decides at settle
  const payClass: 'CASH_OTHER' | 'DIGITAL' =
    rows.length > 0 &&
    rows.every((r) => methods.data?.find((m) => m.id === r.methodId)?.tender_class === 'DIGITAL')
      ? 'DIGITAL'
      : 'CASH_OTHER';
  const quoted =
    quotes.data?.taxEnabled && b.status === 'PRE_BILLED' ? quotes.data[payClass] : null;
  const shown = {
    taxPaisa: quoted?.taxPaisa ?? b.taxPaisa,
    roundOffPaisa: quoted?.roundOffPaisa ?? b.roundOffPaisa,
    totalPaisa: quoted?.totalPaisa ?? b.totalPaisa,
  };
  const remaining = shown.totalPaisa - enteredPaisa; // display hint only; the server re-validates
  const methodOf = (mid: string): PaymentMethod | undefined =>
    methods.data?.find((m) => m.id === mid);

  const addRow = (m: PaymentMethod): void => {
    // prefill with what is left under the class this tender creates: adding a card to an empty bill
    // makes it an all-digital (cheaper-tax) bill, so the total to split changes with the new row
    const classAfter =
      m.tender_class === 'DIGITAL' &&
      rows.every((r) => methods.data?.find((x) => x.id === r.methodId)?.tender_class === 'DIGITAL')
        ? 'DIGITAL'
        : 'CASH_OTHER';
    const totalAfter =
      quotes.data?.taxEnabled && b.status === 'PRE_BILLED'
        ? quotes.data[classAfter].totalPaisa
        : b.totalPaisa;
    const rest = Math.max(totalAfter - enteredPaisa, 0);
    setRows((rs) => [
      ...rs,
      {
        key: ++seq.current,
        methodId: m.id,
        amount: rest > 0 ? (rest / 100).toFixed(2) : '',
        tendered: '',
        reference: '',
        khata: null,
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
      if (m?.code === 'KHATA' && !r.khata) return false;
      if (m?.opens_drawer && r.tendered) {
        const tn = parseRs(r.tendered);
        if (tn === null || tn < amt) return false;
      }
      return true;
    });

  // ── paid: receipt / change screen
  if (result || settled) {
    const change = result?.changeDuePaisa ?? b.changeDuePaisa;
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-emerald-600 text-white">
            <Icon name="check" size={32} />
          </span>
          <h1 className="text-2xl font-semibold">{t('bill.settled')}</h1>
          <p className="text-slate-700">
            {t('bill.billNo')} {ltr(`#${b.billNo}`)} ·{' '}
            <span className="money">{ltr(formatRs(b.totalPaisa))}</span>
          </p>
        </div>
        <div className="card p-5 text-center">
          <div className="label">{t('bill.change')}</div>
          <div data-testid="change-due" className="money mt-1 text-5xl font-semibold">
            {change > 0 ? ltr(formatRs(change)) : t('bill.changeNone')}
          </div>
        </div>
        {b.fiscalInvoiceNo ? (
          <p className="text-center text-sm text-slate-700" data-testid="fiscal-no">
            {t('bill.fiscalNo')}: {ltr(b.fiscalInvoiceNo)}
          </p>
        ) : b.fiscalStatus === 'PENDING' || b.fiscalStatus === 'FAILED' ? (
          <p className="text-center text-sm text-amber-800" data-testid="fiscal-pending">
            {t('bill.fiscalPending')}
          </p>
        ) : null}
        {(b.creditNotes?.length ?? 0) > 0 && (
          <div className="card space-y-1 p-3" data-testid="credit-notes">
            <div className="font-semibold">{t('refund.history')}</div>
            {b.creditNotes!.map((c) => (
              <div key={c.id} className="flex justify-between text-sm">
                <span>
                  {t('refund.note')} {ltr(`#${c.cnNo}`)} · {c.reason}
                </span>
                <span className="money">{ltr(formatRs(-c.totalPaisa))}</span>
              </div>
            ))}
          </div>
        )}
        {message && (
          <p role="status" className="rounded-lg bg-emerald-50 p-2 text-center text-emerald-900">
            {message}
          </p>
        )}
        <Link to="/" className="btn-primary btn-lg w-full">
          {t('bill.done')}
        </Link>
        <div className="flex gap-2">
          {can(me.data, 'bill.reprint') && (
            <button
              className="btn-secondary flex-1"
              disabled={reprint.isPending}
              onClick={() => reprint.mutate()}
            >
              <Icon name="printer" size={18} />
              {t('bill.reprint')}
            </button>
          )}
          {can(me.data, 'bill.refund') && (b.refundedPaisa ?? 0) < b.totalPaisa && (
            <button className="btn-secondary flex-1" onClick={() => setRefunding(true)}>
              {t('refund.button')}
            </button>
          )}
        </div>
        {refunding && <RefundDialog bill={b} onClose={() => setRefunding(false)} />}
      </div>
    );
  }

  // why the main button is not ready yet, in plain words
  let blocker: string | null = null;
  if (!payable) blocker = t('bill.notPayable');
  else if (rows.length === 0) blocker = t('bill.chooseMethod');
  else if (remaining > 0) blocker = t('bill.toAssign', { amount: ltr(formatRs(remaining)) });
  else if (remaining < 0) blocker = t('bill.over', { amount: ltr(formatRs(-remaining)) });
  else if (!rowsValid) blocker = t('bill.checkRows');

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-3 md:grid-cols-2 md:p-4">
      {/* ── the bill */}
      <section className="card flex flex-col p-4">
        <div className="mb-2 flex items-center gap-2">
          <Link to={`/order/${id}`} className="btn-quiet -ms-2 px-2" aria-label={t('common.back')}>
            <Icon name="chevronLeft" data-flip />
          </Link>
          <h1 className="me-auto text-xl font-semibold">
            {t('bill.billNo')} {ltr(`#${b.billNo}`)}
          </h1>
        </div>
        <ul className="divide-y divide-slate-200">
          {groupLines(b.lines).map((l) => (
            <li key={l.key} className="flex justify-between gap-2 py-2">
              <span>
                <span className="text-slate-600">{ltr(`${l.qty}×`)}</span> {l.description}
              </span>
              <span className="money">{ltr(formatRs(l.netPaisa))}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-2 space-y-1 border-t border-slate-300 pt-3">
          <Row label={t('bill.subtotal')} paisa={b.subtotalPaisa} />
          {b.discountPaisa > 0 && <Row label={t('bill.discount')} paisa={-b.discountPaisa} />}
          {b.serviceChargePaisa > 0 && (
            <Row label={t('bill.service')} paisa={b.serviceChargePaisa} />
          )}
          {shown.taxPaisa > 0 && (
            <Row
              label={
                (quoted?.taxRateBps ?? b.taxRateBps)
                  ? `${t('bill.tax')} ${(quoted?.taxRateBps ?? b.taxRateBps)! / 100}%`
                  : t('bill.tax')
              }
              paisa={shown.taxPaisa}
            />
          )}
          {shown.roundOffPaisa !== 0 && (
            <Row label={t('bill.roundOff')} paisa={shown.roundOffPaisa} />
          )}
          <div className="flex items-baseline justify-between pt-1 text-2xl font-semibold">
            <dt>{t('bill.total')}</dt>
            <dd data-testid="bill-total" className="money">
              {ltr(formatRs(shown.totalPaisa))}
            </dd>
          </div>
        </dl>

        {payable && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
            {can(me.data, 'bill.discount') && (
              <button className="btn-secondary" onClick={() => setDiscounting(true)}>
                {b.discountPaisa > 0 ? t('bill.changeDiscount') : t('bill.addDiscount')}
              </button>
            )}
            {can(me.data, 'bill.void') && (
              <button className="btn-quiet ms-auto text-rose-700" onClick={() => setVoiding(true)}>
                {t('bill.voidBill')}
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── payment */}
      <section className="card space-y-4 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">{t('bill.pay')}</h2>
          <div className="text-end">
            <div className="label">{remaining < 0 ? t('bill.extra') : t('bill.due')}</div>
            <div
              data-testid="remaining"
              className={`money text-3xl font-semibold ${remaining === 0 && rows.length > 0 ? 'text-emerald-700' : ''}`}
            >
              {ltr(formatRs(Math.abs(remaining)))}
            </div>
          </div>
        </div>

        {message && (
          <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {message}
          </p>
        )}
        {(methods.data ?? []).length === 0 && (
          <p className="text-slate-600">{t('bill.noMethods')}</p>
        )}

        <div>
          <div className="label mb-1.5">
            {rows.length === 0 ? t('bill.method') : t('bill.addAnother')}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(methods.data ?? [])
              .filter((m) => m.code !== 'KHATA' || can(me.data, 'khata.collect'))
              .map((m) => (
                <button
                  key={m.id}
                  className="btn-secondary min-h-primary flex-col gap-0.5 text-sm"
                  disabled={!payable}
                  onClick={() => addRow(m)}
                >
                  <Icon
                    name={m.code === 'CASH' ? 'cash' : m.code === 'KHATA' ? 'book' : 'receipt'}
                    size={20}
                  />
                  {m.name}
                </button>
              ))}
          </div>
        </div>

        {rows.map((r) => {
          const m = methodOf(r.methodId)!;
          const amt = parseRs(r.amount) ?? 0;
          const tn = r.tendered ? parseRs(r.tendered) : null;
          return (
            <div
              key={r.key}
              className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-3"
              data-testid={`tender-${m.code}`}
            >
              <div className="flex items-center gap-2">
                <span className="me-auto font-semibold">{m.name}</span>
                <button
                  className="btn-quiet px-2 text-slate-700"
                  aria-label={`${t('bill.remove')} ${m.name}`}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  <Icon name="x" size={18} />
                  {t('bill.remove')}
                </button>
              </div>
              <label className="block space-y-1">
                <span className="label">{t('bill.amount')}</span>
                <input
                  className="input money"
                  inputMode="decimal"
                  aria-label={`${m.name} ${t('bill.amount')}`}
                  value={r.amount}
                  onChange={(e) => patch(r.key, { amount: e.target.value })}
                />
              </label>
              {m.opens_drawer && (
                <div className="space-y-2">
                  <label className="block space-y-1">
                    <span className="label">{t('bill.tendered')}</span>
                    <input
                      className="input money"
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
                  {tn !== null && amt > 0 && (
                    <div
                      className={`flex items-baseline justify-between rounded-lg px-3 py-2 ${tn >= amt ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-800'}`}
                      aria-live="polite"
                    >
                      <span>{tn >= amt ? t('bill.change') : t('bill.cashShort')}</span>
                      <span className="money text-xl font-semibold">
                        {ltr(formatRs(Math.abs(tn - amt)))}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {m.code === 'KHATA' && (
                <div className="space-y-1">
                  <KhataPicker selected={r.khata} onSelect={(a) => patch(r.key, { khata: a })} />
                  {r.khata && amt > r.khata.availableCreditPaisa && (
                    <p className="text-sm text-amber-800">
                      {t('khata.limitExceeded', {
                        available: ltr(formatRs(r.khata.availableCreditPaisa)),
                      })}
                    </p>
                  )}
                  {r.khata && amt > 0 && amt <= r.khata.availableCreditPaisa && (
                    <p className="text-sm text-slate-700">
                      {t('khata.afterBill', {
                        amount: ltr(formatRs(r.khata.balancePaisa + amt)),
                      })}
                    </p>
                  )}
                </div>
              )}
              {m.needs_reference && (
                <label className="block space-y-1">
                  <span className="label">{t('bill.reference')}</span>
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

        <div className="sticky bottom-0 -mx-4 -mb-4 space-y-2 rounded-b-xl border-t border-slate-200 bg-white p-4">
          <button
            className="btn-primary btn-lg w-full"
            disabled={blocker !== null || settle.isPending}
            onClick={() => settle.mutate()}
          >
            {t('bill.settle')} · {ltr(formatRs(shown.totalPaisa))}
          </button>
          {blocker && <p className="hint text-center">{blocker}</p>}
        </div>
      </section>

      {discounting && (
        <DiscountDialog
          busy={discount.isPending}
          hasDiscount={b.discountPaisa > 0}
          onClose={() => setDiscounting(false)}
          onApply={(pct, reason) => {
            discount.mutate({ percentBps: pct, reason });
            setDiscounting(false);
          }}
          onRemove={() => {
            discount.mutate({ percentBps: 0 });
            setDiscounting(false);
          }}
        />
      )}
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

/** The bill lists each tap separately; the guest reads it better with identical dishes merged. */
function groupLines(
  lines: Bill['lines'],
): { key: string; qty: number; description: string; netPaisa: number }[] {
  const out = new Map<
    string,
    { key: string; qty: number; description: string; netPaisa: number }
  >();
  for (const l of lines) {
    const cur = out.get(l.description);
    if (cur) {
      cur.qty += l.qty;
      cur.netPaisa += l.netPaisa;
    } else
      out.set(l.description, {
        key: l.id,
        qty: l.qty,
        description: l.description,
        netPaisa: l.netPaisa,
      });
  }
  return [...out.values()];
}

function Row({ label, paisa }: { label: string; paisa: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-700">{label}</dt>
      <dd className="money">{ltr(formatRs(paisa))}</dd>
    </div>
  );
}

function DiscountDialog({
  busy,
  hasDiscount,
  onClose,
  onApply,
  onRemove,
}: {
  busy: boolean;
  hasDiscount: boolean;
  onClose: () => void;
  onApply: (percentBps: number, reason: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [pct, setPct] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={t('bill.addDiscount')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {hasDiscount && (
            <button className="btn-secondary me-auto" disabled={busy} onClick={onRemove}>
              {t('bill.removeDiscount')}
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={busy || pct === null || reason.trim().length < 3}
            onClick={() => onApply(pct! * 100, reason.trim())}
          >
            {t('bill.apply')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {[5, 10, 15, 20].map((p) => (
            <button
              key={p}
              aria-pressed={pct === p}
              className={`btn border ${pct === p ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-400 bg-white hover:bg-slate-100'}`}
              onClick={() => setPct(p)}
            >
              {ltr(`${p}%`)}
            </button>
          ))}
        </div>
        <input
          className="input"
          placeholder={t('bill.discountReason')}
          aria-label={t('bill.discountReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="hint">{t('bill.discountHint')}</p>
      </div>
    </Modal>
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
    <Modal
      title={t('bill.approverTitle')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={busy || !username.trim() || !/^\d{4,8}$/.test(pin)}
            onClick={() => onSubmit(username.trim(), pin)}
          >
            {t('common.confirm')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="hint">{t('bill.approverHint')}</p>
        {wrong && (
          <p role="alert" className="text-sm text-rose-700">
            {t('bill.approverWrong')}
          </p>
        )}
        <input
          className="input"
          autoFocus
          placeholder={t('bill.approverUser')}
          aria-label={t('bill.approverUser')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="input"
          type="password"
          inputMode="numeric"
          placeholder={t('bill.approverPin')}
          aria-label={t('bill.approverPin')}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
      </div>
    </Modal>
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
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-danger"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onSubmit(reason.trim())}
          >
            {t('common.confirm')}
          </button>
        </>
      }
    >
      <input
        className="input"
        autoFocus
        placeholder={prompt}
        aria-label={prompt}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}
