import { parseRupees } from '@erp/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { ltr } from '../../lib/money';
import { can, useDay, useFloor, useMe, usePrinterHealth, useShift } from '../../lib/queries';
import type { Shift } from '../../lib/types';
import { ADMIN_SECTIONS } from '../admin/AdminLayout';
import { useKitchenBoard } from '../kitchen/KitchenPage';
import { setLanguage, type Lang } from '../../i18n';
import { DayCloseDialog, ShiftDialog } from './ShiftDialogs';

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
  const loc = useLocation();
  const live = useLive((x) => x.connected);
  const tablesBusy = (floor.data?.tables ?? []).filter((x) => x.status !== 'FREE').length;
  const tablesBilled = (floor.data?.tables ?? []).filter((x) => x.status === 'BILLED').length;
  const offline = (printers.data ?? []).filter((p) => p.state === 'OFFLINE');
  useEffect(() => startLive(qc), [qc]);

  const [floatOpen, setFloatOpen] = useState(false);
  // the dialog keeps its own copy: closing the shift empties the 'current shift' query
  const [drawerShift, setDrawerShift] = useState<Shift | null>(null);
  const [closingDay, setClosingDay] = useState(false);

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

  const path = loc.pathname;
  const pageTitle = path.startsWith('/dashboard')
    ? t('shell.navDashboard')
    : path.startsWith('/bills')
      ? t('shell.navBills')
      : path.startsWith('/kitchen')
        ? t('shell.navKitchen')
        : path.startsWith('/khata')
          ? t('shell.navKhata')
          : path.startsWith('/admin')
            ? t('shell.navAdmin')
            : path.startsWith('/order')
              ? t('order.title')
              : t('shell.navTables');

  const railItem = (it: NavItem): ReactNode => {
    const cls = ({ isActive }: { isActive?: boolean }): string =>
      `group relative flex min-h-touch flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-2 text-[0.75rem] font-medium leading-tight md:w-full md:flex-none ${
        isActive ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'
      }`;
    const body = (active: boolean): ReactNode => (
      <>
        {active && (
          <span className="absolute inset-y-2 start-0 hidden w-[3px] rounded-full bg-amber-400 md:block" />
        )}
        <span className="relative">
          <Icon name={it.icon} />
          {it.badge && (
            <span
              title={it.badge.title}
              className="absolute -end-2.5 -top-2 flex min-w-[1.15rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[0.68rem] font-bold leading-[1.15rem] text-slate-900"
            >
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
      <nav
        aria-label={t('shell.mainNav')}
        className="flex shrink-0 gap-1 bg-slate-900 p-1.5 md:w-[var(--rail)] md:flex-col md:gap-1.5 md:p-2 md:pt-3"
      >
        <Link
          to="/"
          aria-label={t('app.title')}
          className="mx-auto mb-2 hidden size-11 items-center justify-center rounded-xl bg-emerald-600 text-white md:flex"
        >
          <Mark size={26} />
        </Link>
        {items.map((it) => railItem(it))}
        {adminItem && <div className="md:mt-auto" />}
        {adminItem && railItem(adminItem)}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-300 bg-white px-3 sm:px-4">
          <div className="me-auto flex min-w-0 items-center gap-2 truncate text-lg font-semibold tracking-tight">
            <Mark size={22} className="text-emerald-700 md:hidden" />
            <span className="hidden sm:inline md:hidden">{pageTitle}</span>
            <span className="hidden font-medium text-slate-600 md:inline">{t('app.title')}</span>
          </div>
          <ClockLive live={live} lang={i18n.language} />
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
            onCloseDay={() => setClosingDay(true)}
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
      {closingDay && <DayCloseDialog onClose={() => setClosingDay(false)} />}
      <Toaster />
    </div>
  );
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
      className="hidden flex-col items-end leading-tight md:flex"
      title={live ? t('shell.liveHint') : t('shell.offlineHint')}
    >
      <span className="money text-base font-semibold text-slate-800">{ltr(time)}</span>
      <span
        className={`flex items-center gap-1.5 text-xs font-medium ${live ? 'text-slate-600' : 'text-amber-800'}`}
      >
        <span className={`size-2 rounded-full ${live ? 'bg-emerald-600' : 'bg-amber-500'}`} />
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

function StatusCell({ on, title, sub }: { on: boolean; title: string; sub: string }) {
  return (
    <span className="flex items-center gap-2.5 px-3 py-1.5">
      <span className="relative flex size-3 shrink-0">
        {on && <span className="absolute inset-0 rounded-full bg-emerald-500/40" />}
        <span
          className={`relative m-auto size-2.5 rounded-full ${on ? 'bg-emerald-600' : 'bg-amber-500'}`}
        />
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span className="whitespace-nowrap text-sm font-semibold">{title}</span>
        <span className="hidden whitespace-nowrap text-xs font-medium text-slate-600 sm:block">
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
            ? 'divide-amber-300 border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
            : 'divide-slate-200 border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
        }`}
        onClick={() => setOpen(!open)}
      >
        <StatusCell
          on={dayOpen}
          title={dayOpen ? t('shell.dayOpen') : t('shell.dayClosed')}
          sub={dayOpen ? ltr(dateLabel(p.dayDate ?? '', p.lang)) : t('shell.tapToStart')}
        />
        <StatusCell
          on={p.shiftOpen}
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

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
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
