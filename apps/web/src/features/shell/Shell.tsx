import { parseRupees } from '@erp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Mark } from '../../components/Brand';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Toaster } from '../../components/Toast';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { startLive, useLive } from '../../lib/live';
import { formatRs, ltr } from '../../lib/money';
import { can, useDay, useFloor, useMe, usePrinterHealth, useShift } from '../../lib/queries';
import type { Shift } from '../../lib/types';
import { ADMIN_SECTIONS } from '../admin/AdminLayout';
import { useKitchenBoard } from '../kitchen/KitchenPage';
import { localName, setLanguage, type Lang } from '../../i18n';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { HelpDialog, helpKeyFor } from './HelpDialog';
import { DayCloseDialog, ShiftDialog } from './ShiftDialogs';
import { watchResponsiveTables } from '../../lib/responsive-tables';

/** Auth guard + app frame: navigation by task, one Day/Shift control, account menu. */
export function Shell() {
  const tokens = useAuth((s) => s.tokens);
  const { search } = useLocation();
  // keep ?login=password&user=… from the platform link through the redirect
  if (!tokens) return <Navigate to={{ pathname: '/login', search }} replace />;
  return (
    <PasswordGate>
      <SignedIn />
    </PasswordGate>
  );
}

/**
 * A temporary password must be replaced before anything else loads: the server refuses every other
 * request until then, so the app behind is not even started (no screen firing requests that fail).
 */
function PasswordGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.data?.mustChangePassword)
    return (
      <div className="h-full bg-slate-100">
        <ChangePasswordDialog forced onClose={() => undefined} />
      </div>
    );
  return <>{children}</>;
}

interface NavItem {
  to?: string;
  icon: IconName;
  label: string;
  onClick?: () => void;
  end?: boolean;
  /** One plain line saying what the place is for, shown under the name. */
  hint?: string;
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
  const polling = useLive((x) => x.polling);
  const live = useLive((x) => x.connected) || polling; // polling is a normal state, not a fault
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const { pathname } = useLocation();
  const helpPage = helpKeyFor(pathname);

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
    items.push({
      to: '/dashboard',
      icon: 'chart',
      label: t('shell.navDashboard'),
      hint: t('shell.hint.dashboard'),
    });
  items.push({
    to: '/',
    icon: 'tables',
    label: t('shell.navTables'),
    hint: t('shell.hint.tables'),
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
      hint: t('shell.hint.kitchen'),
      badge:
        kitchenN > 0
          ? {
              n: kitchenN,
              title: t(cooks ? 'shell.kitchenNew' : 'shell.kitchenReady', { count: kitchenN }),
            }
          : undefined,
    });
  if (can(me.data, 'report.view'))
    items.push({
      to: '/bills',
      icon: 'receipt',
      label: t('shell.navBills'),
      hint: t('shell.hint.bills'),
    });
  if (can(me.data, 'khata.collect'))
    items.push({
      to: '/khata',
      icon: 'book',
      label: t('shell.navKhata'),
      hint: t('shell.hint.khata'),
    });
  if (shift.data)
    items.push({
      icon: 'cash',
      label: t('shell.navDrawer'),
      hint: t('shell.hint.drawer'),
      onClick: () => setDrawerShift(shift.data ?? null),
    });
  const adminItem: NavItem | null = ADMIN_SECTIONS.some((x) => can(me.data, x.permission))
    ? {
        to: '/admin',
        icon: 'sliders',
        label: t('shell.navAdmin'),
        hint: t('shell.hint.admin'),
      }
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
  // where you are: shown at the start of the top bar (order and payment screens belong to Tables)
  const current =
    all.find(
      (x) => x.to && x.to !== '/' && (pathname === x.to || pathname.startsWith(`${x.to}/`)),
    ) ?? all.find((x) => x.to === '/');

  const sideItem = (it: NavItem): ReactNode => {
    const cls = ({ isActive }: { isActive?: boolean }): string =>
      `group relative flex min-h-9 w-full items-center gap-2.5 rounded-md text-[0.8125rem] font-medium transition-colors ${
        expanded ? 'px-2.5' : 'justify-center px-0'
      } ${
        isActive
          ? 'bg-white text-slate-900 shadow-[0_0_0_1px_rgba(30,27,22,0.09),0_1px_2px_rgba(30,27,22,0.06)]'
          : 'text-slate-600 hover:bg-slate-200/60 hover:text-slate-900'
      }`;
    const body = (active: boolean): ReactNode => (
      <>
        <span className="relative shrink-0">
          <Icon
            name={it.icon}
            size={18}
            className={active ? 'text-slate-900' : 'text-slate-500 group-hover:text-slate-800'}
          />
          {it.badge && !expanded && (
            <span className="absolute -end-1.5 -top-1.5 flex min-w-[1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[0.62rem] font-bold leading-4 text-white">
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
            className="ms-auto flex min-w-[1.35rem] items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold leading-[1.35rem] text-amber-800"
          >
            {it.badge.n}
          </span>
        )}
      </>
    );
    const title = expanded ? it.hint : it.badge ? `${it.label}: ${it.badge.title}` : it.label;
    return it.to ? (
      <NavLink
        key={it.label}
        to={it.to}
        end={it.end}
        className={cls}
        title={title}
        aria-label={it.label}
      >
        {({ isActive }) => body(isActive)}
      </NavLink>
    ) : (
      <button
        key={it.label}
        type="button"
        className={cls({})}
        onClick={it.onClick}
        title={title}
        aria-label={it.label}
      >
        {body(false)}
      </button>
    );
  };

  const tabItem = (it: NavItem): ReactNode => {
    const cls = ({ isActive }: { isActive?: boolean }): string =>
      `relative flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.72rem] font-medium ${
        isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500'
      }`;
    const body = (active: boolean): ReactNode => (
      <>
        <span className="relative">
          <Icon name={it.icon} size={22} className={active ? 'text-slate-900' : ''} />
          {it.badge && (
            <span className="absolute -end-2.5 -top-1.5 flex min-w-[1.1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[0.65rem] font-bold leading-[1.1rem] text-white">
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
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-slate-900 px-3 text-slate-100 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3 me-auto">
          {wide && (
            <button
              type="button"
              onClick={toggleRail}
              aria-label={folded ? t('shell.expandMenu') : t('shell.foldMenu')}
              aria-expanded={!folded}
              title={folded ? t('shell.expandMenu') : t('shell.foldMenu')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Icon name="sidebar" size={18} data-flip />
            </button>
          )}
          <Link
            to="/"
            aria-label={t('app.title')}
            className="flex min-w-0 items-center gap-2.5 rounded-md"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white">
              <Mark size={18} />
            </span>
            <span className="hidden max-w-[16rem] truncate text-sm font-semibold tracking-tight text-white sm:block">
              {restaurant || t('app.title')}
            </span>
          </Link>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-white/20" />
          <div className="truncate text-sm font-medium text-slate-300">
            {current?.label || restaurant || t('app.title')}
          </div>
        </div>
        <ClockLive live={live} lang={i18n.language} />
        <DayShiftControl
          dayDate={day.data?.businessDate}
          dayOpenedAt={day.data?.openedAt}
          shiftOpen={!!shift.data}
          shiftOpenedAt={shift.data?.openedAt}
          floatPaisa={shift.data?.openingFloatPaisa}
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
          live={live}
          polling={polling}
          onLang={setLanguage}
          onPassword={() => setPasswordOpen(true)}
          onHelp={() => setHelpOpen(true)}
          onLogout={() => void logout()}
        />
      </header>
      <div className="flex min-h-0 flex-1 flex-col-reverse md:flex-row">
        {/* tablets and desktops: the side menu */}
        <div
          className={`hidden shrink-0 flex-col border-e border-slate-200 bg-slate-50 text-slate-700 transition-[width] duration-200 md:flex ${expanded ? 'w-56' : 'w-14'}`}
        >
          <nav
            aria-label={t('shell.mainNav')}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-3"
          >
            {groups.map((g, i) => (
              <div key={g.label} className="space-y-0.5">
                {expanded ? (
                  <div className="px-2.5 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-500">
                    {g.label}
                  </div>
                ) : (
                  i > 0 && <div className="mx-1 mb-3 border-t border-slate-200" />
                )}
                {g.items.map((it) => sideItem(it))}
              </div>
            ))}
          </nav>
          <div className="space-y-0.5 border-t border-slate-200 p-2">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              title={t('help.open')}
              aria-label={t('help.open')}
              className={`group flex min-h-9 w-full items-center gap-2.5 rounded-md text-[0.8125rem] font-medium text-slate-600 transition-colors hover:bg-slate-200/60 hover:text-slate-900 ${expanded ? 'px-2.5' : 'justify-center'}`}
            >
              <Icon name="info" size={18} className="text-slate-500 group-hover:text-slate-800" />
              {expanded && t('help.open')}
            </button>
            <div
              className={`flex min-h-8 items-center gap-2 text-xs font-medium text-slate-500 ${expanded ? 'px-2.5' : 'justify-center'}`}
              title={
                polling
                  ? t('shell.pollingHint')
                  : live
                    ? t('shell.liveHint')
                    : t('shell.offlineHint')
              }
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${live ? 'bg-emerald-500' : 'animate-pulse bg-amber-500'}`}
              />
              {expanded &&
                (polling
                  ? t('shell.autoRefresh')
                  : live
                    ? t('shell.live')
                    : t('shell.reconnecting'))}
            </div>
          </div>
        </div>

        {/* phones: a bar at the bottom with the four main places and "More" */}
        <nav
          aria-label={t('shell.mainNav')}
          className="flex shrink-0 gap-1 border-t border-slate-200 bg-white p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden"
        >
          {primary.map((it) => tabItem(it))}
          {more.length > 0 && (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              className="relative flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[0.72rem] font-medium text-slate-500"
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
            <div className="absolute inset-x-0 bottom-0 space-y-1 rounded-t-2xl bg-white p-3 pb-[max(1rem,env(safe-area-inset-bottom))] text-slate-800 shadow-sheet">
              <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300" />
              {more.map((it) => {
                const inner = (
                  <>
                    <Icon name={it.icon} size={22} />
                    <span className="me-auto leading-tight">
                      {it.label}
                      {it.hint && (
                        <span className="block text-sm font-normal text-slate-500">{it.hint}</span>
                      )}
                    </span>
                    {it.badge && (
                      <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800">
                        {it.badge.n}
                      </span>
                    )}
                  </>
                );
                const cls =
                  'flex min-h-touch w-full items-center gap-3 rounded-xl px-4 text-lg font-medium hover:bg-slate-100';
                return it.to ? (
                  <Link
                    key={it.label}
                    to={it.to}
                    className={cls}
                    onClick={() => setMoreOpen(false)}
                  >
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
      </div>

      {helpOpen && <HelpDialog page={helpPage} onClose={() => setHelpOpen(false)} />}
      {passwordOpen && (
        <ChangePasswordDialog forced={false} onClose={() => setPasswordOpen(false)} />
      )}
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
      className="hidden items-center lg:flex"
      title={live ? t('shell.liveHint') : t('shell.offlineHint')}
    >
      <span className="money text-sm font-medium text-slate-400">{ltr(time)}</span>
    </div>
  );
}

const dateLabel = (iso: string, lang: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

const timeOf = (iso: string | undefined, lang: string): string =>
  iso
    ? new Date(iso).toLocaleTimeString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

/** One half of the top-bar status: a small caption (what it is), the state in bold, one line of detail. */
function StatusCell({
  on,
  icon,
  caption,
  title,
  sub,
  nudge,
}: {
  on: boolean;
  icon: IconName;
  caption: string;
  title: string;
  sub: string;
  /** This is the step the person should do next: the icon pulses. */
  nudge?: boolean;
}) {
  const first = icon === 'clock';
  return (
    <span className={`flex items-center gap-1.5 py-1 ${first ? 'ps-3 pe-2.5' : 'px-2.5'}`}>
      <span
        aria-hidden="true"
        className={`relative size-2 shrink-0 rounded-full ${on ? 'bg-emerald-400' : 'bg-amber-400'}`}
      >
        {nudge && (
          <span className="absolute inset-0 animate-ping rounded-full bg-amber-400 motion-reduce:hidden" />
        )}
      </span>
      <span className="flex items-baseline gap-1.5 leading-tight">
        <span className="sr-only">{caption}</span>
        <span className="whitespace-nowrap text-[0.8rem] font-semibold">{title}</span>
        <span className="hidden max-w-[8rem] truncate whitespace-nowrap text-xs font-medium text-slate-400 xl:block">
          {sub}
        </span>
      </span>
    </span>
  );
}

/** A numbered step in the menu: where it stands, what it means, and the one thing to do about it. */
function Step({
  n,
  done,
  title,
  status,
  detail,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  status: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-slate-200 p-3">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${done ? 'bg-emerald-600' : 'bg-amber-500'}`}
      >
        {done ? <Icon name="check" size={16} /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{title}</span>
          <span className={done ? 'chip-ok' : 'chip-warn'}>{status}</span>
        </div>
        <p className="text-sm leading-snug text-slate-600">{detail}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * The only place the business day and shift are handled. Two labelled cells say where you are (the
 * business day, your own shift); the menu shows the same two as numbered steps with the next action.
 */
function DayShiftControl(p: {
  dayDate: string | undefined;
  dayOpenedAt: string | undefined;
  shiftOpen: boolean;
  shiftOpenedAt: string | undefined;
  floatPaisa: number | undefined;
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
  const dayTitle = dayOpen ? t('shell.dayOpen') : t('shell.dayClosed');
  const shiftTitle = p.shiftOpen ? t('shell.shiftOpen') : t('shell.shiftClosed');

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${dayTitle} · ${shiftTitle}`}
        className={`flex min-h-8 items-stretch divide-x rounded-md border text-start transition-colors rtl:divide-x-reverse ${
          needsAction
            ? 'divide-amber-400/30 border-amber-400/60 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20'
            : 'divide-white/15 border-white/20 text-slate-100 hover:bg-white/10'
        }`}
        onClick={() => setOpen(!open)}
      >
        <StatusCell
          on={dayOpen}
          icon="clock"
          caption={t('shell.captionDay')}
          title={dayTitle}
          sub={dayOpen ? ltr(dateLabel(p.dayDate ?? '', p.lang)) : t('shell.tapStartDay')}
          nudge={!dayOpen}
        />
        <StatusCell
          on={p.shiftOpen}
          icon="cash"
          caption={t('shell.captionShift')}
          title={shiftTitle}
          sub={
            p.shiftOpen
              ? `${p.cashier}${p.shiftOpenedAt ? ` · ${ltr(timeOf(p.shiftOpenedAt, p.lang))}` : ''}`
              : dayOpen
                ? t('shell.tapStartShift')
                : t('shell.afterDay')
          }
          nudge={dayOpen && !p.shiftOpen}
        />
        <span className="flex items-center pe-2 ps-0.5 text-slate-400">
          <Icon name="chevronDown" size={14} />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-2 w-[min(24rem,calc(100vw-1.5rem))] space-y-2 rounded-xl border border-slate-300 bg-white p-3 text-slate-900 shadow-sheet"
        >
          <Step
            n={1}
            done={dayOpen}
            title={t('shell.captionDay')}
            status={dayOpen ? t('shell.statusOpen') : t('shell.statusNotStarted')}
            detail={
              dayOpen
                ? `${t('shell.stepDayOpen', { date: ltr(dateLabel(p.dayDate ?? '', p.lang)) })}${
                    p.dayOpenedAt
                      ? ` ${t('shell.openedAt', { time: ltr(timeOf(p.dayOpenedAt, p.lang)) })}`
                      : ''
                  }`
                : t('shell.startDayHint')
            }
          >
            {!dayOpen && p.canOpenDay && (
              <button className="btn-primary w-full" disabled={p.busy} onClick={act(p.onOpenDay)}>
                {t('shell.openDay')}
              </button>
            )}
            {dayOpen && p.canCloseDay && (
              <MenuItem onClick={act(p.onCloseDay)}>
                <Icon name="check" size={20} />
                {t('cash.closeDay')}
              </MenuItem>
            )}
          </Step>
          <Step
            n={2}
            done={p.shiftOpen}
            title={t('shell.captionShift')}
            status={p.shiftOpen ? t('shell.statusOpen') : t('shell.statusNotStarted')}
            detail={
              p.shiftOpen
                ? t('shell.stepShiftOpen', {
                    name: p.cashier,
                    time: ltr(timeOf(p.shiftOpenedAt, p.lang)),
                    float: ltr(formatRs(p.floatPaisa ?? 0)),
                  })
                : dayOpen
                  ? t('shell.startShiftHint')
                  : t('shell.needDayFirst')
            }
          >
            {dayOpen && !p.shiftOpen && p.canOpenShift && (
              <button className="btn-primary w-full" onClick={act(p.onOpenShift)}>
                {t('shell.openShift')}
              </button>
            )}
            {dayOpen && p.shiftOpen && (
              <MenuItem onClick={act(p.onDrawer)}>
                <Icon name="cash" size={20} />
                {t('cash.drawer')}
              </MenuItem>
            )}
          </Step>
          <p className="px-1 text-xs leading-relaxed text-slate-600">
            {t('shell.dayShiftExplain')}
          </p>
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
  live,
  polling,
  onLang,
  onPassword,
  onHelp,
  onLogout,
}: {
  name: string;
  role: string;
  lang: Lang;
  live: boolean;
  polling: boolean;
  onLang: (l: Lang) => void;
  onPassword: () => void;
  onHelp: () => void;
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
        className="flex min-h-9 items-center gap-2 rounded-md py-0.5 ps-0.5 pe-1.5 transition-colors hover:bg-white/10"
        onClick={() => setOpen(!open)}
      >
        <span
          className="relative"
          title={
            polling ? t('shell.pollingHint') : live ? t('shell.liveHint') : t('shell.offlineHint')
          }
        >
          <Avatar name={name} size={28} />
          <span
            aria-hidden="true"
            className={`absolute -bottom-0.5 -end-0.5 size-3 rounded-full ring-2 ring-slate-900 ${live ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'}`}
          />
        </span>
        <span className="hidden flex-col items-start leading-tight lg:flex">
          <span className="max-w-[9rem] truncate text-[0.8rem] font-semibold text-white">
            {name}
          </span>
          <span className="text-[0.7rem] font-medium text-slate-400">
            {roleName} ·{' '}
            {polling ? t('shell.autoRefresh') : live ? t('shell.live') : t('shell.reconnecting')}
          </span>
        </span>
        <Icon name="chevronDown" size={14} className="hidden text-slate-400 sm:block" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-2 w-72 rounded-xl border border-slate-300 bg-white p-2 text-slate-900 shadow-sheet"
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
          <MenuItem
            onClick={() => {
              setOpen(false);
              onHelp();
            }}
          >
            <Icon name="info" size={20} />
            {t('help.open')}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              onPassword();
            }}
          >
            <Icon name="user" size={20} />
            {t('shell.changePassword')}
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
      <div className="space-y-3">
        <p className="rounded-lg bg-slate-100 p-3 text-sm leading-relaxed text-slate-700">
          {t('shell.floatHint')}
        </p>
        <label className="block space-y-1">
          <span className="label">{t('shell.float')}</span>
          <input
            className="input text-2xl font-semibold"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            autoFocus
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {error}
        </p>
      )}
    </Modal>
  );
}
