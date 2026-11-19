import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAge } from '../../lib/age';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { ApiError, api } from '../../lib/api';
import { ltr } from '../../lib/money';
import { pollMs } from '../../lib/live';
import { Navigate } from 'react-router-dom';
import { can, useKitchenScreen, useMe } from '../../lib/queries';

export type KotStatus = 'NEW' | 'PREPARING' | 'READY' | 'DONE';

export interface Ticket {
  id: string;
  kotNo: number;
  status: KotStatus;
  rush: boolean;
  createdAt: string;
  startedAt: string | null;
  readyAt: string | null;
  doneAt: string | null;
  stationCode: string;
  stationName: string;
  orderId: string;
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode: string | null;
  waiter: string | null;
  lines: {
    id: string;
    qty: number;
    name: string;
    weightG: number | null;
    modifiers: string[];
    note: string | null;
    fromDeal: string | null;
    voided: boolean;
  }[];
}
export interface Board {
  now: string;
  stations: { code: string; name: string }[];
  tickets: Ticket[];
}

/** The board: every ticket still in the kitchen, refreshed live. Shared with the side rail badge. */
export const useKitchenBoard = (station?: string, enabled = true) =>
  useQuery({
    queryKey: ['kitchen', 'board', station ?? ''],
    queryFn: () =>
      api<Board>(`/kitchen/board${station ? `?station=${encodeURIComponent(station)}` : ''}`),
    enabled,
    refetchInterval: () => pollMs(5_000),
  });

const COLUMNS: { status: Exclude<KotStatus, 'DONE'>; accent: string; dot: string }[] = [
  { status: 'NEW', accent: 'border-amber-400', dot: 'bg-amber-400' },
  { status: 'PREPARING', accent: 'border-sky-400', dot: 'bg-sky-400' },
  { status: 'READY', accent: 'border-emerald-400', dot: 'bg-emerald-400' },
];

/** The button is the colour of the column the ticket moves to: tap blue and it turns up under the blue heading. */
const GO: Record<'PREPARING' | 'READY' | 'DONE', string> = {
  PREPARING: 'bg-sky-500 text-white hover:bg-sky-400',
  READY: 'bg-emerald-500 text-white hover:bg-emerald-400',
  DONE: 'bg-white text-slate-900 hover:bg-slate-100',
};

/** A short two-tone beep; browsers allow it once the person has tapped anything on the page. */
function beep(kind: 'new' | 'ready'): void {
  try {
    const Ctx = window.AudioContext;
    const ctx = new Ctx();
    const tones = kind === 'new' ? [880, 660] : [660, 990];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.value = 0.15;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.22);
      o.stop(ctx.currentTime + i * 0.22 + 0.18);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* no audio available: the screen still shows the ticket */
  }
}

/** The Kitchen screen, unless the owner switched it off: then the printed ticket is the kitchen and this goes back to the tables. */
export function KitchenPage() {
  const on = useKitchenScreen();
  if (!on) return <Navigate to="/" replace />;
  return <KitchenBoardPage />;
}

function KitchenBoardPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const [station, setStation] = useState('');
  const [view, setView] = useState<Exclude<KotStatus, 'DONE'>>('NEW');
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem('erp-kitchen-sound') !== 'off';
    } catch {
      return true;
    }
  });
  const board = useKitchenBoard(station || undefined);
  const canCook = can(me.data, 'kitchen.update');
  const canServe = can(me.data, 'kitchen.serve') || canCook;

  // server clock vs this device: ages come from the server's "now", so a wrong tablet clock does not lie
  const skew = board.data ? Date.parse(board.data.now) - Date.now() : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  // alert when a ticket arrives (cooks) or turns ready (waiters)
  const known = useRef<Map<string, KotStatus> | null>(null);
  useEffect(() => {
    if (!board.data) return;
    const now = new Map(board.data.tickets.map((x) => [x.id, x.status] as const));
    const prev = known.current;
    known.current = now;
    if (!prev || !sound) return;
    const arrived = board.data.tickets.some((x) => x.status === 'NEW' && !prev.has(x.id));
    const ready = board.data.tickets.some(
      (x) => x.status === 'READY' && prev.get(x.id) !== 'READY',
    );
    if (canCook && arrived) beep('new');
    else if (!canCook && ready) beep('ready');
  }, [board.data, sound, canCook]);

  const move = useMutation({
    mutationFn: (v: { id: string; status: KotStatus }) =>
      api(`/kots/${v.id}/status`, { method: 'POST', body: { status: v.status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kitchen'] }),
    onError: (e) => {
      toast(e instanceof ApiError ? e.message : t('common.error'), 'bad');
      void qc.invalidateQueries({ queryKey: ['kitchen'] });
    },
  });

  const tickets = board.data?.tickets ?? [];
  const by = (s: KotStatus): Ticket[] => tickets.filter((x) => x.status === s);
  const served = by('DONE').slice().reverse();
  const ageMin = (x: Ticket): number => {
    const from = x.status === 'READY' && x.readyAt ? x.readyAt : x.createdAt;
    return Math.max(0, Math.floor((Date.now() + skew - Date.parse(from)) / 60_000));
  };
  const counts = useMemo(
    () => ({ NEW: by('NEW').length, PREPARING: by('PREPARING').length, READY: by('READY').length }),
    [tickets],
  );
  // tickets that have waited too long and are not ready yet: the one number the line cook watches
  const lateCount = (board.data?.tickets ?? []).filter(
    (x) => (x.status === 'NEW' || x.status === 'PREPARING') && ageMin(x) >= 20,
  ).length;

  function toggleSound(): void {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem('erp-kitchen-sound', next ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (next) beep('new'); // also unlocks audio on this device
  }

  const label = (s: KotStatus): string => t(`kitchen.col${s}`);

  return (
    <div className="min-h-full bg-slate-900">
      <div className="mx-auto max-w-[110rem] space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="me-auto">
            <h1 className="page-title text-white">{t('kitchen.title')}</h1>
            <p className="hint text-slate-400">{t('kitchen.hint')}</p>
            {lateCount > 0 && (
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-3 py-1 text-sm font-semibold text-rose-300 ring-1 ring-rose-500/40">
                <Icon name="clock" size={14} />
                {t('kitchen.lateN', { count: lateCount })}
              </span>
            )}
          </div>
          {(board.data?.stations.length ?? 0) > 1 && (
            <div
              className="seg max-w-full overflow-x-auto !border-slate-700 !bg-slate-800"
              role="group"
              aria-label={t('kitchen.station')}
            >
              <button
                className="seg-item shrink-0 [&:not([aria-pressed=true])]:text-slate-300 [&:not([aria-pressed=true])]:hover:bg-slate-700"
                aria-pressed={station === ''}
                onClick={() => setStation('')}
              >
                {t('common.all')}
              </button>
              {board.data?.stations.map((s) => (
                <button
                  key={s.code}
                  className="seg-item shrink-0 whitespace-nowrap [&:not([aria-pressed=true])]:text-slate-300 [&:not([aria-pressed=true])]:hover:bg-slate-700"
                  aria-pressed={station === s.code}
                  onClick={() => setStation(s.code)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <button
            className="btn border border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700"
            aria-pressed={sound}
            onClick={toggleSound}
          >
            <Icon name={sound ? 'bell' : 'bellOff'} size={20} />
            {sound ? t('kitchen.soundOn') : t('kitchen.soundOff')}
          </button>
        </div>

        {/* phones and small tablets show one column at a time */}
        <div
          className="seg w-full !border-slate-700 !bg-slate-800 lg:hidden"
          role="group"
          aria-label={t('kitchen.title')}
        >
          {COLUMNS.map((c) => (
            <button
              key={c.status}
              className="seg-item flex-1 gap-2 [&:not([aria-pressed=true])]:text-slate-300"
              aria-pressed={view === c.status}
              onClick={() => setView(c.status)}
            >
              {label(c.status)}
              <span className="money opacity-70">{counts[c.status]}</span>
            </button>
          ))}
        </div>

        {board.isError && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700">
            {t('common.error')}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          {COLUMNS.map((c) => (
            <section
              key={c.status}
              className={`min-w-0 space-y-3 ${view === c.status ? '' : 'hidden lg:block'}`}
              aria-label={label(c.status)}
            >
              <h2
                className={`flex items-center gap-2.5 rounded-xl border-t-4 bg-slate-800 px-4 py-3 text-base font-bold uppercase tracking-wide text-white ${c.accent}`}
              >
                <span aria-hidden="true" className={`size-2.5 rounded-full ${c.dot}`} />
                {label(c.status)}
                <span className="money ms-auto rounded-full bg-white/10 px-2.5 py-0.5 text-sm">
                  {counts[c.status]}
                </span>
              </h2>
              {by(c.status).length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-600 p-6 text-center text-slate-400">
                  {t(`kitchen.empty${c.status}`)}
                </p>
              )}
              {by(c.status).map((x) => (
                <TicketCard
                  key={x.id}
                  x={x}
                  age={ageMin(x)}
                  canCook={canCook}
                  canServe={canServe}
                  busy={move.isPending}
                  onMove={(status) => move.mutate({ id: x.id, status })}
                />
              ))}
            </section>
          ))}
        </div>

        {served.length > 0 && (
          <details className="rounded-xl bg-slate-800 p-4 text-slate-200">
            <summary className="cursor-pointer font-semibold">
              {t('kitchen.recent', { count: served.length })}
            </summary>
            <ul className="mt-2 divide-y divide-slate-700">
              {served.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="me-auto font-medium">
                    {where(x, t)} · <span className="text-slate-400">{x.stationName}</span>
                  </span>
                  <span className="text-slate-400">
                    {x.lines
                      .filter((l) => !l.voided)
                      .map((l) => `${ltr(`${l.qty}×`)} ${l.name}`)
                      .join(', ')}
                  </span>
                  {canServe && (
                    <button
                      className="btn-quiet px-2"
                      disabled={move.isPending}
                      onClick={() => move.mutate({ id: x.id, status: 'READY' })}
                    >
                      {t('kitchen.undo')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

const where = (x: Ticket, t: (k: string) => string): string =>
  x.orderType === 'DINE_IN'
    ? `${t('order.table')} ${ltr(x.tableCode ?? '')}`
    : `${t(x.orderType === 'TAKEAWAY' ? 'order.takeaway' : 'order.delivery')} ${ltr(`${t('order.token')} ${x.orderNo}`)}`;

function TicketCard({
  x,
  age,
  canCook,
  canServe,
  busy,
  onMove,
}: {
  x: Ticket;
  age: number;
  canCook: boolean;
  canServe: boolean;
  busy: boolean;
  onMove: (s: KotStatus) => void;
}) {
  const { t } = useTranslation();
  const ready = x.status === 'READY';
  const late = !ready && age >= 20;
  const slow = !ready && age >= 10;
  const next: { to: KotStatus; label: string; allowed: boolean } =
    x.status === 'NEW'
      ? { to: 'PREPARING', label: t('kitchen.start'), allowed: canCook }
      : x.status === 'PREPARING'
        ? { to: 'READY', label: t('kitchen.ready'), allowed: canCook }
        : { to: 'DONE', label: t('kitchen.served'), allowed: canServe };
  const back: KotStatus | null =
    x.status === 'PREPARING' ? 'NEW' : x.status === 'READY' ? 'PREPARING' : null;
  const dineIn = x.orderType === 'DINE_IN';
  // the band is the clock: green while fresh, amber when it is taking long, red and pulsing when late
  const band = ready
    ? 'bg-emerald-700 text-white'
    : late
      ? 'animate-pulse bg-rose-600 text-white'
      : slow
        ? 'bg-amber-400 text-slate-900'
        : 'bg-emerald-600 text-white';
  return (
    <article
      className={`overflow-hidden rounded-2xl bg-slate-800 text-white shadow-lg ring-1 ${x.rush ? 'ring-2 ring-rose-500' : 'ring-white/10'}`}
    >
      <header className={`flex items-center gap-3 px-4 py-3 ${band}`}>
        <div className="me-auto min-w-0">
          <div className="truncate text-3xl font-bold leading-none tracking-tight">
            {dineIn ? ltr(x.tableCode ?? '') : ltr(`#${x.orderNo}`)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-semibold opacity-90">
            <span className="inline-flex items-center gap-1 uppercase tracking-wide">
              <Icon name={dineIn ? 'tables' : 'bag'} size={12} />
              {t(
                dineIn
                  ? 'order.table'
                  : x.orderType === 'TAKEAWAY'
                    ? 'order.takeaway'
                    : 'order.delivery',
              )}
            </span>
            <span>
              {ltr(`#${x.kotNo}`)} · {x.stationName}
              {x.waiter ? ` · ${x.waiter}` : ''}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="money inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-black/20 px-2.5 py-1 text-lg font-bold">
            <Icon name={ready ? 'check' : 'clock'} size={16} />
            {formatAge(age, t)}
          </span>
          {x.rush && (
            <span className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-0.5 text-xs font-bold uppercase text-white">
              <Icon name="flame" size={12} /> {t('order.rush')}
            </span>
          )}
        </div>
      </header>
      <ul className="space-y-3 p-4">
        {x.lines.map((l) => (
          <li key={l.id} className={l.voided ? 'opacity-60' : ''}>
            <div
              className={`flex items-start gap-3 text-xl font-semibold leading-snug ${l.voided ? 'line-through' : ''}`}
            >
              <span className="money inline-flex min-w-11 shrink-0 justify-center rounded-lg bg-white/10 px-2 py-0.5 text-xl font-bold text-amber-300">
                {ltr(`${l.qty}×`)}
              </span>
              <span>
                {l.name}
                {l.weightG ? ` · ${ltr(`${l.weightG} g`)}` : ''}
                {l.voided && (
                  <span className="ms-2 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs font-bold uppercase text-rose-300 no-underline">
                    {t('kitchen.cancelled')}
                  </span>
                )}
              </span>
            </div>
            {l.modifiers.length > 0 && (
              <div className="ms-14 mt-0.5 text-sm text-slate-300">{l.modifiers.join(', ')}</div>
            )}
            {l.fromDeal && (
              <div className="ms-14 mt-0.5 text-sm text-slate-400">
                {t('kitchen.fromDeal', { deal: l.fromDeal })}
              </div>
            )}
            {l.note && (
              <div className="ms-14 mt-1.5 rounded-md border-s-4 border-amber-400 bg-amber-400/15 px-2.5 py-1 text-base font-semibold text-amber-200">
                {l.note}
              </div>
            )}
          </li>
        ))}
      </ul>
      <footer className="flex gap-2 border-t border-white/10 p-3">
        {back && canCook && (
          <button
            className="btn border border-slate-600 px-3 text-slate-200 hover:bg-white/10"
            disabled={busy}
            onClick={() => onMove(back)}
            aria-label={t('kitchen.undo')}
          >
            <Icon name="chevronLeft" data-flip />
          </button>
        )}
        {next.allowed ? (
          <button
            className={`btn btn-lg flex-1 text-lg ${GO[next.to as 'PREPARING' | 'READY' | 'DONE']}`}
            disabled={busy}
            onClick={() => onMove(next.to)}
          >
            {next.label}
          </button>
        ) : (
          <p className="flex-1 self-center text-center text-sm text-slate-400">
            {t(`kitchen.wait${x.status}`)}
          </p>
        )}
      </footer>
    </article>
  );
}
