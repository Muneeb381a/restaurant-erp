import { useTranslation } from 'react-i18next';

/**
 * The one loading indicator of the whole app. A ring with a moving arc in the brand green: calm, centred,
 * the same everywhere. It always carries a text for screen readers (and shows it when `label` is true),
 * and stops spinning for people who asked their system for less motion.
 *
 *   <Loader />                      a screen or panel that is still loading (centred, with a short text)
 *   <Loader size="sm" inline />     inside a line of text or a button
 */
export function Loader({
  size = 'md',
  tone = 'default',
  inline = false,
  label = true,
  text,
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  /** "light" for a ring sitting on a dark or green button */
  tone?: 'default' | 'light';
  /** sits in the flow of a line instead of filling a block */
  inline?: boolean;
  /** show the words under (or beside) the ring; the ring alone is for tight places */
  label?: boolean;
  /** a more specific text than "Loading…" */
  text?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const words = text ?? t('common.loading');
  const px = { sm: 16, md: 32, lg: 48 }[size];
  const stroke = size === 'sm' ? 3 : 2.5;
  const r = 10;
  const ring = (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="shrink-0 animate-spin motion-reduce:animate-none"
      style={{ animationDuration: '0.8s' }}
    >
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        strokeWidth={stroke}
        className={tone === 'light' ? 'stroke-white/30' : 'stroke-slate-200'}
      />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray="22 63"
        className={tone === 'light' ? 'stroke-white' : 'stroke-emerald-600'}
      />
    </svg>
  );
  if (inline)
    return (
      <span
        role="status"
        aria-live="polite"
        className={`inline-flex items-center gap-2 align-middle ${className}`}
      >
        {ring}
        {label ? <span>{words}</span> : <span className="sr-only">{words}</span>}
      </span>
    );
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-3 px-4 py-12 text-sm text-slate-500 ${className}`}
    >
      {ring}
      {label ? <span>{words}</span> : <span className="sr-only">{words}</span>}
    </div>
  );
}
