import { parseRupees } from '@erp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Mark } from '../../components/Brand';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Toaster } from '../../components/Toast';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { startLive, useLive } from '../../lib/live';
import { ltr } from '../../lib/money';
import { can, useDay, useFloor, useMe, usePrinterHealth, useShift } from '../../lib/queries';
import type { Shift } from '../../lib/types';
import { ADMIN_SECTIONS } from '../admin/AdminLayout';
import { useKitchenBoard } from '../kitchen/KitchenPage';
import { localName, setLanguage, type Lang } from '../../i18n';
import { DayCloseDialog, ShiftDialog } from './ShiftDialogs';
import { watchResponsiveTables } from '../../lib/responsive-tables';

/** Auth guard + app frame: navigation by task, one Day/Shift control, account menu. */
export function Shell() {
  const tokens = useAuth((s) => s.tokens);
  if (!tokens) return <Navigate to="/login" replace />;
  return <SignedIn />;
}

interface NavItem {
  to?: string;
  icon: IconName;
  label: string;
  onClick?: () => void;
  end?: boolean;
  /** Small count on the icon, e.g. busy tables. */
  badge?: { n: number; title: string };
}

function SignedIn() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const logoutLocal = useAuth((s) => s.logout);
  const me = useMe();
  const day = useDay();
  const shift = useShift();
  const printers = usePrinterHealth();
  const floor = useFloor();
  const kitchen = useKitchenBoard(undefined, can(me.data, 'kitchen.view'));
  const cooks = can(me.data, 'kitchen.update');
  const kitchenN = (kitchen.data?.tickets ?? []).filter(
    (x) => x.status === (cooks ? 'NEW' : 'READY'),
  ).length;
  const live = useLive((x) => x.connected);
  const tablesBusy = (floor.data?.tables ?? []).filter((x) => x.status !== 'FREE').length;
  const tablesBilled = (floor.data?.tables ?? []).filter((x) => x.status === 'BILLED').length;
  const offline = (printers.data ?? []).filter((p) => p.state === 'OFFLINE');
  useEffect(() => startLive(qc), [qc]);
  useEffect(() => watchResponsiveTables(), []); // wide tables become cards on phones

  const branch = useQuery({
    queryKey: ['branch'],
    queryFn: () => api<{ name: string; name_ur: string | null }>('/branch'),
    staleTime: 5 * 60_000,
  });
  const restaurant = branch.data
    ? localName(i18n.language, branch.data.name, branch.data.name_ur)
    : '';
  // the side menu is labelled on wide screens and icon-only on tablets; the owner can fold it either way
  const wide = useMediaQuery('(min-width: 1024px)');
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem('erp-rail') === 'folded';
    } catch {
      return false;
    }
  });
  const expanded = wide && !folded;
  const toggleRail = (): void => {
    const next = !folded;
    setFolded(next);
    try {
      localStorage.setItem('erp-rail', next ? 'folded' : 'open');
    } catch {
      /* private mode */
    }
  };
  const [moreOpen, setMoreOpen] = useState(false);

  const [floatOpen, setFloatOpen] = useState(false);
  // the dialog keeps its own copy: closing the shift empties the 'current shift' query
  const [drawerShift, setDrawerShift] = useState<Shift | null>(null);
  const [closingDay, setClosingDay] = useState(false);
  // the closing dialog keeps the date: once the day is closed the 'current day' query is empty
  const [closingDate, setClosingDate] = useState<string | undefined>(undefined);

  const openDay = useMutation({
    mutationFn: () => api('/business-days/open', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['day'] }),
  });

  async function logout(): Promise<void> {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* already invalid */
    }
    logoutLocal();
    qc.clear();
    nav('/login', { replace: true });
  }

  const items: NavItem[] = [];
  if (can(me.data, 'report.financial'))
    items.push({ to: '/dashboard', icon: 'chart', label: t('shell.navDashboard') });
  items.push({
    to: '/',
    icon: 'tables',
    label: t('shell.navTables'),
    end: true,
    badge:
      tablesBusy > 0
        ? {
            n: tablesBusy,
            title: t('shell.tablesBusy', { busy: tablesBusy, billed: tablesBilled }),
          }
        : undefined,
  });
  if (can(me.data, 'kitchen.view'))
    items.push({
      to: '/kitchen',
      icon: 'flame',
      label: t('shell.navKitchen'),
      badge:
        kitchenN > 0
          ? {
              n: kitchenN,
              title: t(cooks ? 'shell.kitchenNew' : 'shell.kitchenReady', { count: kitchenN }),
            }
          : undefined,
    });
  if (can(me.data, 'report.view'))
    items.push({ to: '/bills', icon: 'receipt', label: t('shell.navBills') });
  if (can(me.data, 'khata.collect'))
    items.push({ to: '/khata', icon: 'book', label: t('shell.navKhata') });
  if (shift.data)
    items.push({
      icon: 'cash',
      label: t('shell.navDrawer'),
      onClick: () => setDrawerShift(shift.data ?? null),
    });
  const adminItem: NavItem | null = ADMIN_SECTIONS.some((x) => can(me.data, x.permission))
    ? { to: '/admin', icon: 'sliders', label: t('shell.navAdmin') }
    : null;

  // groups of the side menu: what you do during service, the money, and the owner's views
  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: t('shell.groupService'),
      items: items.filter((x) => ['/', '/kitchen', '/bills'].includes(x.to ?? '')),
    },
    {
      label: t('shell.groupMoney'),
      items: items.filter((x) => x.to === '/khata' || (!x.to && x.icon === 'cash')),
    },
    {
      label: t('shell.groupManage'),
      items: [...items.filter((x) => x.to === '/dashboard'), ...(adminItem ? [adminItem] : [])],
    },
  ].filter((g) => g.items.length > 0);
  // phone bar: the four things used most; the rest sit behind "More"
  const all = groups.flatMap((g) => g.items);
  const primary =
    all.length > 5
      ? all.filter((x) => ['/', '/kitchen', '/bills'].includes(x.to ?? '')).slice(0, 4)
      : all;
  const more = all.filter((x) => !primary.includes(x));

  const sideItem = (it: NavItem): ReactNode => {
    const cls = ({ isActive }: { isActive?: boolean }): string =>
      `group relative flex min-h-11 w-full items-center gap-3 rounded-lg text-[0.95rem] font-medium transition-colors ${
        expanded ? 'px-3' : 'justify-center px-0'
      } ${isActive ? 'bg-white/[.12] text-white' : 'text-slate-300 hover:bg-white/[.07] hover:text-white'}`;
    const body = (active: boolean): ReactNode => (
      <>
        {active && (
          <span className="absolute inset-y-2 start-0 w-[3px] rounded-full bg-amber-400" />
        )}
        <span className="relative shrink-0">
          <Icon name={it.icon} size={22} className={active ? 'text-amber-300' : ''} />
          {it.badge && !expanded && (
            <span className="absolute -end-1.5 -top-1.5 flex min-w-[1.05rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[0.65rem] font-bold leading-[1.05rem] text-slate-900">
              {it.badge.n}
            </span>
          )}
        </span>
        <span className={expanded ? 'min-w-0 flex-1 truncate text-start' : 'sr-only'}>
          {it.label}
        </span>
        {it.badge && expanded && (
          <span
            title={it.badge.title}
            className="ms-auto flex min-w-[1.4rem] items-center justify-center rounded-full bg-amber-400 px-1.5 text-xs font-bold leading-[1.4rem] text-slate-900"
          >
            {it.badge.n}
          </span>
        )}
      </>
    );
    const title = expanded ? undefined : it.badge ? `${it.label}: ${it.badge.title}` : it.label;
    return it.to ? (
      <NavLink key={it.label} to={it.to} end={it.end} className={cls} title={title}>
        {({ isActive }) => body(isActive)}
      </NavLink>
    ) : (
      <button key={it.label} type="button" className={cls({})} onClick={it.onClick} title={title}>
        {body(false)}
      </button>
    );
  };

  const tabItem = (it: NavItem): ReactNode => {
    const cls = ({ isActive }: { isActive?: boolean }): string =>
      `relative flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.72rem] font-medium ${
        isActive ? 'bg-white/[.12] text-white' : 'text-slate-300'
      }`;
    const body = (active: boolean): ReactNode => (
      <>
        <span className="relative">
          <Icon name={it.icon} size={22} className={active ? 'text-amber-300' : ''} />
          {it.badge && (
            <span className="absolute -end-2.5 -top-1.5 flex min-w-[1.1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[0.65rem] font-bold leading-[1.1rem] text-slate-900">
              {it.badge.n}
            </span>
          )}
        </span>
        {it.label}
      </>
    );
    return it.to ? (
      <NavLink key={it.label} to={it.to} end={it.end} className={cls}>
        {({ isActive }) => body(isActive)}
      </NavLink>
    ) : (
      <button key={it.label} type="button" className={cls({})} onClick={it.onClick}>
        {body(false)}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col-reverse md:flex-row">
      {/* tablets and desktops: the side menu */}
      <div
        className={`hidden shrink-0 flex-col bg-slate-900 text-slate-200 transition-[width] duration-200 md:flex ${expanded ? 'w-60' : 'w-[4.75rem]'}`}
      >
        <Link
          to="/"
          aria-label={t('app.title')}
          className={`flex h-16 shrink-0 items-center gap-3 border-b border-white/10 ${expanded ? 'px-4' : 'justify-center'}`}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <Mark size={26} />
          </span>
          {expanded && (
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[0.95rem] font-semibold text-white">
                {restaurant || t('app.title')}
              </span>
              <span className="block text-xs text-slate-400">{t('shell.pos')}</span>
            </span>
          )}
        </Link>
        <nav
          aria-label={t('shell.mainNav')}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4"
        >
          {groups.map((g, i) => (
            <div key={g.label} className="space-y-1">
              {expanded ? (
                <div className="px-3 pb-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  {g.label}
                </div>
              ) : (
                i > 0 && <div className="mx-3 mb-3 border-t border-white/10" />
              )}
              {g.items.map((it) => sideItem(it))}
            </div>
          ))}
        </nav>
        <div className="shrink-0 space-y-1 border-t border-white/10 p-3">
          <div
            className={`flex items-center gap-2 px-3 py-1 text-xs ${live ? 'text-slate-400' : 'text-amber-300'}`}
            title={live ? t('shell.liveHint') : t('shell.offlineHint')}
          >
            <span
              className={`size-2 shrink-0 rounded-full ${live ? 'bg-emerald-500' : 'bg-amber-400'}`}
            />
            {expanded && (live ? t('shell.live') : t('shell.reconnecting'))}
          </div>
          {wide && (
            <button
              type="button"
              onClick={toggleRail}
              aria-label={folded ? t('shell.expandMenu') : t('shell.foldMenu')}
              aria-expanded={!folded}
              title={folded ? t('shell.expandMenu') : t('shell.foldMenu')}
              className={`flex min-h-10 w-full items-center gap-3 rounded-lg text-sm text-slate-400 hover:bg-white/[.07] hover:text-white ${expanded ? 'px-3' : 'justify-center'}`}
            >
              <Icon name="chevronLeft" size={20} data-flip className={folded ? 'rotate-180' : ''} />
              {expanded && t('shell.foldMenu')}
            </button>
          )}
        </div>
      </div>

      {/* phones: a bar at the bottom with the four main places and "More" */}
      <nav
        aria-label={t('shell.mainNav')}
        className="flex shrink-0 gap-1 bg-slate-900 p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden"
      >
        {primary.map((it) => tabItem(it))}
        {more.length > 0 && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            className="relative flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.72rem] font-medium text-slate-300"
          >
            <Icon name="more" size={22} />
            {t('shell.more')}
          </button>
        )}
      </nav>
      {moreOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t('shell.more')}
        >
          <button
            type="button"
            aria-label={t('common.close')}
            className="absolute inset-0 bg-black/50"
            onClick={() => setMoreOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 space-y-1 rounded-t-2xl bg-slate-900 p-3 pb-[max(1rem,env(safe-area-inset-bottom))] text-slate-100 shadow-sheet">
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/25" />
            {more.map((it) => {
              const inner = (
                <>
                  <Icon name={it.icon} size={22} />
                  <span className="me-auto">{it.label}</span>
                  {it.badge && (
                    <span className="rounded-full bg-amber-400 px-2 text-xs font-bold text-slate-900">
                      {it.badge.n}
                    </span>
                  )}
                </>
              );
              const cls =
                'flex min-h-touch w-full items-center gap-3 rounded-xl px-4 text-lg font-medium hover:bg-white/10';
              return it.to ? (
                <Link key={it.label} to={it.to} className={cls} onClick={() => setMoreOpen(false)}>
                  {inner}
                </Link>
              ) : (
                <button
                  key={it.label}
                  type="button"
                  className={cls}
                  onClick={() => {
                    setMoreOpen(false);
                    it.onClick?.();
                  }}
                >
                  {inner}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-300 bg-white px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3 me-auto">
            <span className="text-emerald-700 md:hidden">
              <Mark size={26} />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-base font-semibold tracking-tight text-slate-900">
                <span className="md:hidden">{restaurant || t('app.title')}</span>
                <span className="hidden md:inline">
                  {day.data?.businessDate
                    ? ltr(longDate(day.data.businessDate, i18n.language))
                    : t('shell.dayClosed')}
                </span>
              </div>
              <div className="hidden truncate text-xs font-medium text-slate-600 md:block">
                {restaurant}
              </div>
            </div>
          </div>
          <ClockLive live={live} lang={i18n.language} />
          <span className="hidden h-8 w-px bg-slate-300 md:block" aria-hidden="true" />
          <DayShiftControl
            dayDate={day.data?.businessDate}
            shiftOpen={!!shift.data}
            cashier={me.data?.fullName ?? ''}
            lang={i18n.language}
            canOpenDay={can(me.data, 'day.open')}
            canOpenShift={can(me.data, 'shift.open')}
            canCloseDay={can(me.data, 'day.close')}
            busy={openDay.isPending}
            onOpenDay={() => openDay.mutate()}
            onOpenShift={() => setFloatOpen(true)}
            onDrawer={() => setDrawerShift(shift.data ?? null)}
            onCloseDay={() => {
              setClosingDate(day.data?.businessDate);
              setClosingDay(true);
            }}
          />
          <AccountMenu
            name={me.data?.fullName ?? ''}
            role={me.data?.role ?? ''}
            lang={i18n.language as Lang}
            onLang={setLanguage}
            onLogout={() => void logout()}
          />
        </header>

        {offline.length > 0 && (
          <div
            role="alert"
            className="flex items-center justify-center gap-2 bg-rose-600 px-3 py-2 text-sm font-semibold text-white"
          >
            <Icon name="printer" size={18} />
            {t('shell.printerOffline', {
              names: offline.map((p) => `${p.name} (${p.queued})`).join(', '),
            })}
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      {floatOpen && <OpenShiftDialog onClose={() => setFloatOpen(false)} />}
      {drawerShift && <ShiftDialog shift={drawerShift} onClose={() => setDrawerShift(null)} />}
      {closingDay && <DayCloseDialog date={closingDate} onClose={() => setClosingDay(false)} />}
      <Toaster />
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

const longDate = (iso: string, lang: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

/** Closes a popover on outside click / Esc. */
function usePopover(): {
  open: boolean;
  setOpen: (v: boolean) => void;
  ref: React.RefObject<HTMLDivElement>;
} {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function MenuItem({
  children,
  onClick,
  tone,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'bad';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex min-h-touch w-full items-center gap-2 rounded-md px-3 text-start text-base hover:bg-slate-100 ${tone === 'bad' ? 'text-rose-700' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** "21:42" style clock with the live-connection dot: the till shows the time staff actually read. */
function ClockLive({ live, lang }: { live: boolean; lang: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div
      className="hidden flex-col items-end leading-tight md:flex"
      title={live ? t('shell.liveHint') : t('shell.offlineHint')}
    >
      <span className="money text-lg font-semibold tracking-tight text-slate-900">{ltr(time)}</span>
      <span className={`text-xs font-medium ${live ? 'text-slate-600' : 'text-amber-800'}`}>
        {live ? t('shell.live') : t('shell.reconnecting')}
      </span>
    </div>
  );
}

const dateLabel = (iso: string, lang: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

function StatusCell({
  on,
  icon,
  title,
  sub,
}: {
  on: boolean;
  icon: IconName;
  title: string;
  sub: string;
}) {
  return (
    <span className="flex items-center gap-2.5 px-1.5 py-1.5 sm:px-3">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${on ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'}`}
      >
        <Icon name={icon} size={17} />
      </span>
      <span className="sr-only flex-col items-start leading-tight sm:not-sr-only sm:flex">
        <span className="whitespace-nowrap text-sm font-semibold">{title}</span>
        <span className="max-w-[9rem] truncate whitespace-nowrap text-xs font-medium opacity-80">
          {sub}
        </span>
      </span>
    </span>
  );
}

/**
 * The only place the business day and shift are handled. Two cells show where you are (day, shift);
 * the menu offers exactly the next step (start day → start shift → cash drawer / close day).
 */
function DayShiftControl(p: {
  dayDate: string | undefined;
  shiftOpen: boolean;
  cashier: string;
  lang: string;
  canOpenDay: boolean;
  canOpenShift: boolean;
  canCloseDay: boolean;
  busy: boolean;
  onOpenDay: () => void;
  onOpenShift: () => void;
  onDrawer: () => void;
  onCloseDay: () => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const dayOpen = !!p.dayDate;
  const needsAction = !dayOpen || !p.shiftOpen;
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex min-h-touch items-stretch divide-x rounded-xl border text-start transition-colors rtl:divide-x-reverse ${
          needsAction
            ? 'divide-amber-300 border-amber-400 bg-amber-50 text-amber-950 hover:bg-amber-100'
            : 'divide-emerald-200 border-emerald-300 bg-emerald-50 text-emerald-950 hover:bg-emerald-100'
        }`}
        onClick={() => setOpen(!open)}
      >
        <StatusCell
          on={dayOpen}
          icon="clock"
          title={dayOpen ? t('shell.dayOpen') : t('shell.dayClosed')}
          sub={dayOpen ? ltr(dateLabel(p.dayDate ?? '', p.lang)) : t('shell.tapToStart')}
        />
        <StatusCell
          on={p.shiftOpen}
          icon="cash"
          title={p.shiftOpen ? t('shell.shiftOpen') : t('shell.shiftClosed')}
          sub={p.shiftOpen ? p.cashier : dayOpen ? t('shell.tapToStart') : '–'}
        />
        <span className="flex items-center px-2 text-slate-500">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-1.5 w-80 rounded-xl border border-slate-300 bg-white p-2 shadow-sheet"
        >
          {!dayOpen && (
            <>
              <p className="hint px-3 py-2">{t('shell.startDayHint')}</p>
              {p.canOpenDay && (
                <button
                  className="btn-primary mb-1 w-full"
                  disabled={p.busy}
                  onClick={act(p.onOpenDay)}
                >
                  {t('shell.openDay')}
                </button>
              )}
            </>
          )}
          {dayOpen && !p.shiftOpen && (
            <>
              <p className="hint px-3 py-2">{t('shell.startShiftHint')}</p>
              {p.canOpenShift && (
                <button className="btn-primary mb-1 w-full" onClick={act(p.onOpenShift)}>
                  {t('shell.openShift')}
                </button>
              )}
            </>
          )}
          {dayOpen && p.shiftOpen && (
            <MenuItem onClick={act(p.onDrawer)}>
              <Icon name="cash" size={20} />
              {t('cash.drawer')}
            </MenuItem>
          )}
          {dayOpen && p.canCloseDay && (
            <MenuItem onClick={act(p.onCloseDay)}>
              <Icon name="check" size={20} />
              {t('cash.closeDay')}
            </MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('') || '?';

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-emerald-700 font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

function AccountMenu({
  name,
  role,
  lang,
  onLang,
  onLogout,
}: {
  name: string;
  role: string;
  lang: Lang;
  onLang: (l: Lang) => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const next: Lang = lang === 'ur' ? 'en' : 'ur';
  const roleName = role ? t(`role.${role.toUpperCase()}`, { defaultValue: role }) : '';
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('shell.account')}
        className="flex min-h-touch items-center gap-2.5 rounded-xl border border-transparent py-1 ps-1 pe-2 hover:border-slate-300 hover:bg-slate-50"
        onClick={() => setOpen(!open)}
      >
        <Avatar name={name} />
        <span className="hidden flex-col items-start leading-tight lg:flex">
          <span className="max-w-[10rem] truncate text-sm font-semibold">{name}</span>
          <span className="text-xs font-medium text-slate-600">{roleName}</span>
        </span>
        <Icon name="chevronDown" size={16} className="hidden text-slate-500 sm:block" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-1.5 w-72 rounded-xl border border-slate-300 bg-white p-2 shadow-sheet"
        >
          <div className="flex items-center gap-3 px-3 py-3">
            <Avatar name={name} size={44} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{name}</div>
              <div className="text-sm text-slate-600">{roleName}</div>
            </div>
          </div>
          <div className="my-1 border-t border-slate-200" />
          <MenuItem
            onClick={() => {
              setOpen(false);
              onLang(next);
            }}
          >
            <Icon name="globe" size={20} />
            {t('common.language')}
          </MenuItem>
          <MenuItem tone="bad" onClick={onLogout}>
            <Icon name="logout" size={20} />
            {t('shell.logout')}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function OpenShiftDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [value, setValue] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: (openingFloatPaisa: number) =>
      api('/shifts/open', { method: 'POST', body: { openingFloatPaisa } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['shift'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.error')),
  });

  function submit(): void {
    try {
      open.mutate(parseRupees(value));
    } catch {
      setError(t('common.error'));
    }
  }

  return (
    <Modal
      title={t('shell.openShift')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={open.isPending} onClick={submit}>
            {t('shell.openShift')}
          </button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="label">{t('shell.float')}</span>
        <input
          className="input"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      )}
    </Modal>
  );
}
