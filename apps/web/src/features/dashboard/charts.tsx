import { useTranslation } from 'react-i18next';
import { formatRs, ltr } from '../../lib/money';
import type { DayPoint } from './types';

/** "Rs 12.4k" / "Rs 1.2M" for axes; exact amounts are always shown elsewhere. */
export function compactRs(paisa: number): string {
  const rs = paisa / 100;
  const a = Math.abs(rs);
  const sign = rs < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${sign}${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${sign}${Math.round(a)}`;
}

/** Rounds the top of an axis up to 1, 2, 2.5, 5 × 10ⁿ so the gridlines land on friendly numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 100_00;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

const shortDate = (iso: string, lang: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    day: 'numeric',
    month: 'short',
  });

/**
 * Daily sales (bars) and profit (line). Drawn to one scale: both share the same axis, so a day
 * where the line sits below the bar top reads as "costs ate part of the sales".
 */
export function TrendChart({ data: days, lang }: { data: DayPoint[]; lang: string }) {
  const { t } = useTranslation();
  // gross profit = sales - food cost; rent and salaries are booked on single days and would swamp the chart
  const data = days.map((d) => ({ ...d, profitPaisa: d.salesPaisa - d.costOfFoodPaisa }));
  const W = 680;
  const H = 240;
  const m = { l: 44, r: 8, t: 12, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const hi = niceMax(Math.max(...data.map((d) => Math.max(d.salesPaisa, d.profitPaisa)), 0));
  const lo = Math.min(0, ...data.map((d) => d.profitPaisa));
  const loNice = lo < 0 ? -niceMax(-lo) : 0;
  const y = (v: number): number => m.t + ih - ((v - loNice) / (hi - loNice)) * ih;
  const slot = iw / data.length;
  const bw = Math.max(2, Math.min(34, slot * 0.62));
  const x = (i: number): number => m.l + slot * i + slot / 2;
  const ticks = [0, 1, 2, 3, 4].map((k) => loNice + ((hi - loNice) * k) / 4);
  const every = Math.ceil(data.length / 8);
  const total = data.reduce((n, d) => n + d.salesPaisa, 0);
  const line = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.profitPaisa).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={t('dash.trendAria', { total: ltr(formatRs(total)), days: data.length })}
      className="h-auto w-full"
    >
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={m.l}
            x2={W - m.r}
            y1={y(v)}
            y2={y(v)}
            className="stroke-slate-200"
            strokeWidth={1}
          />
          <text x={m.l - 6} y={y(v) + 4} textAnchor="end" className="fill-slate-600" fontSize={11}>
            {compactRs(v)}
          </text>
        </g>
      ))}
      {loNice < 0 && (
        <line
          x1={m.l}
          x2={W - m.r}
          y1={y(0)}
          y2={y(0)}
          className="stroke-slate-500"
          strokeWidth={1}
        />
      )}
      {data.map((d, i) => (
        <g key={d.date}>
          <rect
            x={x(i) - bw / 2}
            y={y(d.salesPaisa)}
            width={bw}
            height={Math.max(0, y(0) - y(d.salesPaisa))}
            rx={2}
            className="fill-emerald-500"
          >
            <title>{`${shortDate(d.date, lang)}: ${ltr(formatRs(d.salesPaisa))}`}</title>
          </rect>
          {i % every === 0 && (
            <text x={x(i)} y={H - 8} textAnchor="middle" className="fill-slate-600" fontSize={11}>
              {data.length > 31 ? d.date.slice(5) : shortDate(d.date, lang)}
            </text>
          )}
        </g>
      ))}
      <path
        d={line}
        fill="none"
        className="stroke-amber-500"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      {data.length <= 31 &&
        data.map((d, i) => (
          <circle
            key={d.date}
            cx={x(i)}
            cy={y(d.profitPaisa)}
            r={3.5}
            className={d.profitPaisa < 0 ? 'fill-rose-600' : 'fill-amber-500'}
          >
            <title>{`${shortDate(d.date, lang)} · ${t('dash.gross')}: ${ltr(formatRs(d.profitPaisa))}`}</title>
          </circle>
        ))}
    </svg>
  );
}

/** Sales per local hour of the day; the busiest hour is the dark bar. */
export function HourChart({
  data,
}: {
  data: { hour: number; salesPaisa: number; bills: number }[];
}) {
  const { t } = useTranslation();
  const used = data.filter((h) => h.salesPaisa > 0).map((h) => h.hour);
  const from = Math.min(used.length ? Math.min(...used) : 11, 11);
  const to = Math.max(used.length ? Math.max(...used) : 23, 23);
  const rows = data.filter((h) => h.hour >= from && h.hour <= to);
  const peak = rows.reduce((p, h) => (h.salesPaisa > p.salesPaisa ? h : p), rows[0]!);
  const max = Math.max(peak.salesPaisa, 1);
  const label = (h: number): string => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;
  return (
    <div
      role="img"
      aria-label={t('dash.hourAria', { hour: peak.salesPaisa > 0 ? label(peak.hour) : '-' })}
      className="flex h-40 items-end gap-1"
    >
      {rows.map((h) => (
        <div
          key={h.hour}
          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          title={`${label(h.hour)}: ${ltr(formatRs(h.salesPaisa))} · ${h.bills}`}
        >
          <div
            className={`w-full rounded-t ${h.salesPaisa > 0 && h.hour === peak.hour ? 'bg-slate-900' : 'bg-emerald-400'}`}
            style={{ height: `${Math.max(h.salesPaisa > 0 ? 3 : 0, (h.salesPaisa / max) * 100)}%` }}
          />
          <span className="text-[0.7rem] text-slate-600">{label(h.hour)}</span>
        </div>
      ))}
    </div>
  );
}

/** One labelled horizontal bar; width is the share of `max`. */
export function Bar({
  label,
  value,
  max,
  tone = 'bg-emerald-500',
  right,
  sub,
}: {
  label: string;
  value: number;
  max: number;
  tone?: string;
  right: string;
  sub?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="money shrink-0 font-semibold">{right}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${max > 0 ? Math.max(1, Math.min(100, (value / max) * 100)) : 0}%` }}
        />
      </div>
      {sub && <div className="text-xs text-slate-600">{sub}</div>}
    </div>
  );
}
