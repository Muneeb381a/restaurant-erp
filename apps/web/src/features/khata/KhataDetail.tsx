import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { api } from '../../lib/api';
import { creditUse, daysSince, reminderText } from '../../lib/khata';
import { formatRs, ltr, parseRs } from '../../lib/money';
import { can, useKhataAccount, useMe, usePaymentMethods } from '../../lib/queries';
import type { KhataAccount, KhataEntry } from '../../lib/types';
import { whatsappLink } from '../../lib/whatsapp';
import { Avatar } from '../../components/Avatar';
import { AgeChip, rs, shortDate, UsageBar, useExplain } from './parts';

type Dialog = 'receive' | 'adjust' | 'limit' | null;
type Filter = 'all' | 'sales' | 'payments' | 'other';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'khata.filterAll' },
  { key: 'sales', label: 'khata.filterSales' },
  { key: 'payments', label: 'khata.filterPayments' },
  { key: 'other', label: 'khata.filterOther' },
];

const matches = (e: KhataEntry, f: Filter): boolean =>
  f === 'all' ||
  (f === 'sales' && e.kind === 'CHARGE') ||
  (f === 'payments' && e.kind === 'PAYMENT') ||
  (f === 'other' && (e.kind === 'ADJUST_UP' || e.kind === 'ADJUST_DOWN' || e.kind === 'REFUND'));

/** Icon and colours that tell the kind of entry at a glance. */
const KIND: Record<KhataEntry['kind'], { icon: IconName; tone: string }> = {
  CHARGE: { icon: 'receipt', tone: 'bg-rose-100 text-rose-700' },
  PAYMENT: { icon: 'cash', tone: 'bg-emerald-100 text-emerald-700' },
  REFUND: { icon: 'swap', tone: 'bg-sky-100 text-sky-700' },
  ADJUST_UP: { icon: 'plus', tone: 'bg-amber-100 text-amber-800' },
  ADJUST_DOWN: { icon: 'minus', tone: 'bg-amber-100 text-amber-800' },
};

/** One account: who they are, what they owe and since when, what to do next, and the whole ledger. */
export function KhataDetail() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const me = useMe();
  const [shown, setShown] = useState(100);
  const acct = useKhataAccount(id, shown);
  const branch = useQuery({
    queryKey: ['branch'],
    queryFn: () => api<{ name: string }>('/branch'),
    staleTime: 5 * 60_000,
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const qc = useQueryClient();
  const explain = useExplain();

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/khata/accounts/${id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['khata'] });
      setMessage(t('khata.saved'));
    },
    onError: (e) => setMessage(explain(e)),
  });

  const entries = acct.data?.entries;
  const groups = useMemo(() => {
    const out: { day: string; items: KhataEntry[] }[] = [];
    for (const e of entries ?? []) {
      if (!matches(e, filter)) continue;
      const d = new Date(e.createdAt);
      const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [entries, filter]);

  if (acct.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (acct.isError || !acct.data) return <p className="p-4 text-rose-700">{t('common.error')}</p>;
  const a = acct.data;
  const manager = can(me.data, 'customer.manage');
  const use = creditUse(a.balancePaisa, a.creditLimitPaisa);
  const lastPaidDays = daysSince(a.lastPaymentAt);
  const restaurant = branch.data?.name ?? '';
  const lang = i18n.language === 'ur' ? 'ur' : 'en';
  const remindIn = (l: 'en' | 'ur'): string =>
    reminderText({ customer: a.name, restaurant, balancePaisa: a.balancePaisa }, l);
  const dayLabel = (iso: string): string => {
    const days = daysSince(iso);
    if (days === 0) return t('khata.ageToday');
    if (days === 1) return t('khata.yesterday');
    return shortDate(iso, i18n.language);
  };
  const hasMore = a.entries.length >= shown && shown < 500;

  const done = async (msg: string): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['khata'] });
    setDialog(null);
    setMessage(msg);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      {/* who they are and where they stand */}
      <section className="overflow-hidden rounded-2xl bg-slate-900 text-white shadow-sheet">
        <div className="flex flex-wrap items-center gap-3 p-4 sm:p-6">
          <Link
            to="/khata"
            className="btn-quiet -ms-2 px-2 text-slate-200 hover:text-white"
            aria-label={t('common.back')}
          >
            <Icon name="chevronLeft" data-flip />
          </Link>
          <Avatar name={a.name} size={56} />
          <div className="me-auto min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{a.name}</h1>
            <p className="text-sm text-slate-300">{a.phone ? ltr(a.phone) : t('khata.noPhone')}</p>
          </div>
          {!a.isActive && <span className="chip-mute">{t('khata.inactive')}</span>}
          {a.balancePaisa > 0 && use.state === 'near' && (
            <span className="chip-warn">{t('khata.stateNear')}</span>
          )}
          {a.balancePaisa > 0 && use.state === 'over' && (
            <span className="chip-bad">{t('khata.stateOver')}</span>
          )}
        </div>

        <div className="grid gap-4 border-t border-white/10 p-4 sm:p-6 lg:grid-cols-5 lg:gap-8">
          <div className="space-y-1 lg:col-span-2">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-300">
              {t('khata.owes')}
            </div>
            <div
              className={`money whitespace-nowrap text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-none tracking-tight ${a.balancePaisa > 0 ? 'text-rose-300' : 'text-emerald-300'}`}
              data-testid="khata-balance"
            >
              {ltr(formatRs(a.balancePaisa))}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-sm text-slate-300">
              {a.balancePaisa > 0 && a.owingSince && (
                <span className="flex items-center gap-2">
                  <AgeChip a={a} />
                  {t('khata.owingSince', { date: shortDate(a.owingSince, i18n.language) })}
                </span>
              )}
              {a.balancePaisa <= 0 && <span>{t('khata.nothingOwed')}</span>}
            </div>
          </div>

          <div className="space-y-3 lg:col-span-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-300">
                  {t('khata.limit')}
                </div>
                <div className="money text-xl font-semibold">
                  {ltr(formatRs(a.creditLimitPaisa))}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-300">
                  {t('khata.available')}
                </div>
                <div className="money text-xl font-semibold">
                  {ltr(formatRs(a.availableCreditPaisa))}
                </div>
              </div>
            </div>
            <UsageBar a={a} dark withText={false} />
            <p className="text-sm text-slate-300">
              {a.lastPaymentAt
                ? `${t('khata.lastPaid', { date: shortDate(a.lastPaymentAt, i18n.language) })}${
                    lastPaidDays !== null && lastPaidDays > 0
                      ? ` (${ltr(t('khata.ageDays', { n: lastPaidDays }))})`
                      : ''
                  }`
                : a.balancePaisa > 0
                  ? t('khata.neverPaid')
                  : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-white/[.04] p-4 sm:px-6">
          <button
            className="btn-primary"
            disabled={a.balancePaisa <= 0}
            onClick={() => {
              setMessage(null);
              setDialog('receive');
            }}
          >
            <Icon name="cash" size={18} />
            {t('khata.receive')}
          </button>
          {manager && (
            <div className="ms-auto flex flex-wrap gap-1">
              <button
                className="btn-quiet text-slate-200 hover:text-white"
                onClick={() => {
                  setMessage(null);
                  setDialog('adjust');
                }}
              >
                {t('khata.adjust')}
              </button>
              <button
                className="btn-quiet text-slate-200 hover:text-white"
                onClick={() => {
                  setMessage(null);
                  setDialog('limit');
                }}
              >
                {t('khata.editLimit')}
              </button>
              <button
                className="btn-quiet text-slate-200 hover:text-white"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ isActive: !a.isActive })}
              >
                {a.isActive ? t('khata.switchOff') : t('khata.switchOn')}
              </button>
            </div>
          )}
        </div>
      </section>

      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
          {message}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* the ledger, grouped by day */}
        <section className="min-w-0 space-y-3 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="me-auto text-lg font-semibold">{t('khata.ledger')}</h2>
            <div
              className="seg max-w-full overflow-x-auto"
              role="group"
              aria-label={t('khata.ledger')}
            >
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  className="seg-item shrink-0 whitespace-nowrap"
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {t(f.label)}
                </button>
              ))}
            </div>
          </div>

          {a.entries.length === 0 && (
            <p className="card p-8 text-center text-slate-600">{t('khata.noEntries')}</p>
          )}
          {a.entries.length > 0 && groups.length === 0 && (
            <p className="card p-8 text-center text-slate-600">{t('khata.filterEmpty')}</p>
          )}
          {groups.map((g) => (
            <div key={g.day} className="card overflow-hidden">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-slate-600">
                {dayLabel(g.items[0]!.createdAt)}
              </div>
              <ul className="divide-y divide-slate-200">
                {g.items.map((e) => (
                  <Entry key={e.id} e={e} lang={i18n.language} />
                ))}
              </ul>
            </div>
          ))}
          {hasMore && (
            <button
              className="btn-secondary w-full"
              onClick={() => setShown(Math.min(500, shown + 100))}
            >
              {t('khata.showMore')}
            </button>
          )}
        </section>

        {/* side: the reminder and the terms */}
        <aside className="space-y-4">
          {a.balancePaisa > 0 && (
            <section className="card space-y-3 p-4">
              <h2 className="text-base font-semibold">{t('khata.remindTitle')}</h2>
              <p className="rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
                {remindIn(lang)}
              </p>
              {a.phone ? (
                <div className="flex flex-wrap gap-2">
                  {(['ur', 'en'] as const).map((l) => (
                    <a
                      key={l}
                      className={l === lang ? 'btn-primary' : 'btn-secondary'}
                      href={whatsappLink(a.phone, remindIn(l))}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {l === 'ur' ? t('khata.remindUrdu') : t('khata.remindEnglish')}
                    </a>
                  ))}
                </div>
              ) : (
                <p className="hint">{t('khata.needsPhone')}</p>
              )}
              <p className="hint">{t('khata.remindHint')}</p>
            </section>
          )}
          <section className="card divide-y divide-slate-200">
            <h2 className="px-4 py-3 text-base font-semibold">{t('khata.termsTitle')}</h2>
            <Fact label={t('khata.limit')} value={ltr(formatRs(a.creditLimitPaisa))} />
            <Fact label={t('khata.available')} value={ltr(formatRs(a.availableCreditPaisa))} />
            <Fact
              label={t('khata.statusLabel')}
              value={a.isActive ? t('khata.active') : t('khata.inactive')}
            />
            {a.notes && <Fact label={t('khata.notes')} value={a.notes} />}
          </section>
        </aside>
      </div>

      {dialog === 'receive' && (
        <ReceiveDialog a={a} onClose={() => setDialog(null)} onDone={done} />
      )}
      {dialog === 'adjust' && <AdjustDialog a={a} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'limit' && <LimitDialog a={a} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="money text-end font-medium">{value}</span>
    </div>
  );
}

/** One line of the ledger: what happened, who did it, the change and what the customer owed after. */
function Entry({ e, lang }: { e: KhataEntry; lang: string }) {
  const { t } = useTranslation();
  const k = KIND[e.kind];
  const time = new Date(e.createdAt).toLocaleTimeString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <li data-testid="khata-entry" className="flex items-center gap-3 px-4 py-3">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${k.tone}`}>
        <Icon name={k.icon} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="font-medium">{t(`khata.kind.${e.kind}`)}</span>
          {e.billNo !== null && <span className="text-slate-600">{ltr(`#${e.billNo}`)}</span>}
          {e.method && <span className="chip-mute">{e.method}</span>}
        </div>
        <div className="truncate text-xs text-slate-600">
          {ltr(time)}
          {e.by ? ` · ${e.by}` : ''}
          {e.reference ? ` · ${e.reference}` : ''}
          {e.note ? ` · ${e.note}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-end">
        <div
          className={`money font-semibold ${e.deltaPaisa > 0 ? 'text-rose-700' : 'text-emerald-700'}`}
        >
          {ltr(`${e.deltaPaisa > 0 ? '+' : '−'}${formatRs(Math.abs(e.deltaPaisa))}`)}
        </div>
        <div className="text-xs text-slate-600">
          {t('khata.balanceAfter')} {ltr(formatRs(e.balanceAfterPaisa))}
        </div>
      </div>
    </li>
  );
}

function DialogFooter({
  onClose,
  busy,
  disabled,
  onSave,
}: {
  onClose: () => void;
  busy: boolean;
  disabled: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button className="btn-secondary" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button className="btn-primary" disabled={busy || disabled} onClick={onSave}>
        {t('khata.save')}
      </button>
    </>
  );
}

function Err({ text }: { text: string | null }): ReactNode {
  return text ? (
    <p role="alert" className="text-sm text-rose-700">
      {text}
    </p>
  ) : null;
}

/** The customer pays (part of) what they owe, by cash, card or wallet. */
function ReceiveDialog({
  a,
  onClose,
  onDone,
}: {
  a: KhataAccount;
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const explain = useExplain();
  const methods = usePaymentMethods();
  const payMethods = (methods.data ?? []).filter((m) => m.code !== 'KHATA');
  const [methodId, setMethodId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = useRef(`khata-${crypto.randomUUID()}`);
  const chosen = payMethods.find((m) => m.id === (methodId || payMethods[0]?.id));
  const paisa = parseRs(amount) ?? 0;
  const tooMuch = paisa > a.balancePaisa;

  const save = useMutation({
    mutationFn: () =>
      api(`/khata/accounts/${a.id}/payments`, {
        method: 'POST',
        body: {
          methodId: chosen?.id,
          amountPaisa: paisa,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: () => onDone(t('khata.saved')),
    onError: (e) => setError(explain(e)),
  });

  return (
    <Modal
      title={t('khata.receive')}
      size="sm"
      onClose={onClose}
      footer={
        <DialogFooter
          onClose={onClose}
          busy={save.isPending}
          disabled={
            !chosen || paisa <= 0 || tooMuch || (!!chosen.needs_reference && !reference.trim())
          }
          onSave={() => save.mutate()}
        />
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {payMethods.map((m) => (
            <button
              key={m.id}
              className={chosen?.id === m.id ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setMethodId(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="input"
            inputMode="decimal"
            placeholder={t('khata.amount')}
            aria-label={t('khata.amount')}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button
            className="btn-secondary shrink-0"
            onClick={() => setAmount(String(a.balancePaisa / 100))}
          >
            {t('khata.fullBalance')}
          </button>
        </div>
        {tooMuch ? (
          <Err text={t('khata.overpay')} />
        ) : (
          paisa > 0 && (
            <p className="text-sm text-slate-700">
              {t('khata.afterPayment', { amount: rs(a.balancePaisa - paisa) })}
            </p>
          )
        )}
        {chosen?.needs_reference && (
          <input
            className="input"
            placeholder={t('khata.reference')}
            aria-label={t('khata.reference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        )}
        <Err text={error} />
      </div>
    </Modal>
  );
}

/** A manager corrects the balance (opening balance from the paper register, a write-off), with a reason. */
function AdjustDialog({
  a,
  onClose,
  onDone,
}: {
  a: KhataAccount;
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const explain = useExplain();
  const [direction, setDirection] = useState<'UP' | 'DOWN'>('UP');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const paisa = parseRs(amount) ?? 0;
  const tooMuch = direction === 'DOWN' && paisa > a.balancePaisa;
  const save = useMutation({
    mutationFn: () =>
      api(`/khata/accounts/${a.id}/adjustments`, {
        method: 'POST',
        body: { direction, amountPaisa: paisa, reason: reason.trim() },
      }),
    onSuccess: () => onDone(t('khata.saved')),
    onError: (e) => setError(explain(e)),
  });
  return (
    <Modal
      title={t('khata.adjust')}
      size="sm"
      onClose={onClose}
      footer={
        <DialogFooter
          onClose={onClose}
          busy={save.isPending}
          disabled={paisa <= 0 || reason.trim().length < 3 || tooMuch}
          onSave={() => save.mutate()}
        />
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          {(['UP', 'DOWN'] as const).map((d) => (
            <button
              key={d}
              className={direction === d ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
              aria-pressed={direction === d}
              onClick={() => setDirection(d)}
            >
              {d === 'UP' ? t('khata.up') : t('khata.down')}
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
        {tooMuch && <Err text={t('khata.decreaseMax')} />}
        <input
          className="input"
          placeholder={t('khata.reason')}
          aria-label={t('khata.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="hint">{t('khata.adjustHint')}</p>
        <Err text={error} />
      </div>
    </Modal>
  );
}

function LimitDialog({
  a,
  onClose,
  onDone,
}: {
  a: KhataAccount;
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const explain = useExplain();
  const [limit, setLimit] = useState(String(a.creditLimitPaisa / 100));
  const [error, setError] = useState<string | null>(null);
  const paisa = parseRs(limit);
  const save = useMutation({
    mutationFn: () =>
      api(`/khata/accounts/${a.id}`, { method: 'PATCH', body: { creditLimitPaisa: paisa ?? 0 } }),
    onSuccess: () => onDone(t('khata.saved')),
    onError: (e) => setError(explain(e)),
  });
  return (
    <Modal
      title={t('khata.editLimit')}
      size="sm"
      onClose={onClose}
      footer={
        <DialogFooter
          onClose={onClose}
          busy={save.isPending}
          disabled={paisa === null}
          onSave={() => save.mutate()}
        />
      }
    >
      <div className="space-y-3">
        <input
          className="input"
          inputMode="decimal"
          aria-label={t('khata.creditLimit')}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        {paisa !== null && paisa < a.balancePaisa && (
          <p className="text-sm text-amber-800">{t('khata.limitBelowBalance')}</p>
        )}
        <Err text={error} />
      </div>
    </Modal>
  );
}
