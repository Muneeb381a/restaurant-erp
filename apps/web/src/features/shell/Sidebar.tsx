import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { BrandMark } from '../../components/BrandLogo';
import { Icon, type IconName } from '../../components/Icon';

export interface NavItem {
  to?: string;
  icon: IconName;
  label: string;
  onClick?: () => void;
  end?: boolean;
  /** One plain line saying what the place is for. */
  hint?: string;
  /** Small count on the item, e.g. busy tables. */
  badge?: { n: number; title: string };
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The side menu of tablets and desktops. A full-height column: the restaurant at the top, the places
 * grouped by what you do (serve, money, manage), and at the bottom help, the connection state and the
 * fold button. Folded, it is a rail of icons whose names appear beside them on hover or focus.
 */
export function Sidebar({
  groups,
  expanded,
  canFold,
  folded,
  onToggle,
  restaurant,
  subtitle,
  logoVersion,
  live,
  polling,
  onHelp,
}: {
  groups: NavGroup[];
  expanded: boolean;
  canFold: boolean;
  folded: boolean;
  onToggle: () => void;
  restaurant: string;
  subtitle: string;
  logoVersion: number | null;
  live: boolean;
  polling: boolean;
  onHelp: () => void;
}) {
  const { t } = useTranslation();

  /** Name shown beside a folded icon. */
  const tip = (text: string): ReactNode =>
    expanded ? null : (
      <span
        aria-hidden="true"
        className="pointer-events-none absolute start-full top-1/2 z-50 ms-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {text}
      </span>
    );

  const itemClass = (active: boolean): string =>
    `group relative flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-400 ${
      expanded ? '' : 'justify-center'
    } ${
      active
        ? 'bg-white/[0.09] text-white before:absolute before:inset-y-2.5 before:start-0 before:w-[3px] before:rounded-full before:bg-emerald-400'
        : 'text-slate-400 hover:bg-white/[0.05] hover:text-white'
    }`;

  const tile = (icon: IconName, active: boolean, badge?: NavItem['badge']): ReactNode => (
    <span
      className={`relative flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-emerald-500/20 text-emerald-300'
          : 'bg-white/[0.04] text-slate-400 group-hover:bg-white/[0.08] group-hover:text-white'
      }`}
    >
      <Icon name={icon} size={19} />
      {badge && !expanded && (
        <span className="absolute -end-1 -top-1 flex min-w-[1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[0.62rem] font-bold leading-4 text-slate-900 ring-2 ring-slate-900">
          {badge.n}
        </span>
      )}
    </span>
  );

  const entry = (it: NavItem): ReactNode => {
    const content = (active: boolean): ReactNode => (
      <>
        {tile(it.icon, active, it.badge)}
        {expanded && <span className="min-w-0 flex-1 truncate text-start">{it.label}</span>}
        {expanded && it.badge && (
          <span
            title={it.badge.title}
            className="ms-auto flex min-w-[1.5rem] items-center justify-center rounded-full bg-amber-400 px-1.5 text-xs font-bold leading-6 text-slate-900"
          >
            {it.badge.n}
          </span>
        )}
        {tip(it.badge ? `${it.label} · ${it.badge.title}` : it.label)}
      </>
    );
    return it.to ? (
      <NavLink
        key={it.label}
        to={it.to}
        end={it.end}
        aria-label={it.label}
        title={expanded ? it.hint : undefined}
        className={({ isActive }) => itemClass(isActive)}
      >
        {({ isActive }) => content(isActive)}
      </NavLink>
    ) : (
      <button
        key={it.label}
        type="button"
        aria-label={it.label}
        title={expanded ? it.hint : undefined}
        onClick={it.onClick}
        className={itemClass(false)}
      >
        {content(false)}
      </button>
    );
  };

  const status = polling
    ? t('shell.autoRefresh')
    : live
      ? t('shell.live')
      : t('shell.reconnecting');
  const statusHint = polling
    ? t('shell.pollingHint')
    : live
      ? t('shell.liveHint')
      : t('shell.offlineHint');

  return (
    <div
      className={`hidden shrink-0 flex-col border-e border-white/5 bg-gradient-to-b from-slate-900 to-[#0a101c] text-slate-300 transition-[width] duration-200 md:flex ${
        expanded ? 'w-64' : 'w-[4.75rem]'
      }`}
    >
      <Link
        to="/"
        aria-label={t('app.title')}
        className={`flex h-14 shrink-0 items-center gap-3 border-b border-white/10 outline-none focus-visible:bg-white/5 ${
          expanded ? 'px-4' : 'justify-center'
        }`}
      >
        <BrandMark version={logoVersion} size={36} />
        {expanded && (
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold tracking-tight text-white">
              {restaurant || t('app.title')}
            </span>
            <span className="block truncate text-xs text-slate-400">{subtitle}</span>
          </span>
        )}
      </Link>

      <nav
        aria-label={t('shell.mainNav')}
        className={`min-h-0 flex-1 space-y-5 px-3 py-4 ${expanded ? 'overflow-y-auto' : 'overflow-visible'}`}
      >
        {groups.map((g, i) => (
          <div key={g.label} className="space-y-1">
            {expanded ? (
              <div className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.09em] text-slate-500">
                {g.label}
              </div>
            ) : (
              i > 0 && <div className="mx-3 mb-4 border-t border-white/10" />
            )}
            {g.items.map((it) => entry(it))}
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-white/10 p-3">
        <button
          type="button"
          aria-label={t('help.open')}
          onClick={onHelp}
          className={itemClass(false)}
        >
          {tile('info', false)}
          {expanded && <span className="flex-1 truncate text-start">{t('help.open')}</span>}
          {tip(t('help.open'))}
        </button>
        {canFold && (
          <button
            type="button"
            aria-label={folded ? t('shell.expandMenu') : t('shell.foldMenu')}
            aria-expanded={!folded}
            onClick={onToggle}
            className={itemClass(false)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400 transition-colors group-hover:bg-white/[0.08] group-hover:text-white">
              <Icon
                name="chevronLeft"
                size={18}
                className={`transition-transform ${folded ? 'rotate-180 rtl:rotate-0' : 'rtl:rotate-180'}`}
              />
            </span>
            {expanded && <span className="flex-1 truncate text-start">{t('shell.foldMenu')}</span>}
            {tip(t('shell.expandMenu'))}
          </button>
        )}
        <div
          title={statusHint}
          className={`mt-1 flex min-h-9 items-center gap-2.5 rounded-xl bg-white/[0.04] text-xs font-medium text-slate-300 ${
            expanded ? 'px-3' : 'justify-center'
          }`}
        >
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${live ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'}`}
          />
          {expanded ? (
            <span className="truncate">{status}</span>
          ) : (
            <span className="sr-only">{status}</span>
          )}
        </div>
      </div>
    </div>
  );
}
