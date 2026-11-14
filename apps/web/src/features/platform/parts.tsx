import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { TenantStatus } from '../../lib/platform-api';

/** A status as a coloured chip: the colour is never the only signal, the word is always there. */
export function StatusChip({ status }: { status: TenantStatus }) {
  const { t } = useTranslation();
  const cls =
    status === 'ACTIVE'
      ? 'chip-ok'
      : status === 'SUSPENDED'
        ? 'chip-warn'
        : status === 'FAILED'
          ? 'chip-bad'
          : 'chip-mute';
  return <span className={cls}>{t(`platform.status.${status}`)}</span>;
}

/** A value with a Copy button; falls back to selecting the text when the clipboard is refused. */
export function CopyField({
  label,
  value,
  mono = true,
  secret = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  secret?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setShown(true); // let the person select it by hand
    }
  }
  return (
    <div className="space-y-1">
      <div className="micro">{label}</div>
      <div className="flex items-center gap-2">
        <div
          dir="ltr"
          className={`min-w-0 flex-1 select-all truncate rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 ${mono ? 'font-mono text-base tracking-wide' : ''}`}
        >
          {shown ? value : '••••••••••••••'}
        </div>
        {secret && (
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={() => setShown(!shown)}
            aria-pressed={shown}
          >
            {shown ? t('platform.hide') : t('platform.show')}
          </button>
        )}
        <button type="button" className="btn-secondary shrink-0" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'receipt'} size={18} />
          {copied ? t('platform.copied') : t('platform.copy')}
        </button>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="micro">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-slate-600">{sub}</div>}
    </div>
  );
}

export const formatBytes = (n: number | null): string => {
  if (n === null) return '–';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
