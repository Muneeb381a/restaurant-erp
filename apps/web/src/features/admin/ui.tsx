import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';

/** Small shared pieces of the admin screens: modal, form field, error text, toggle. */

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose} size={wide ? 'lg' : 'md'}>
      {children}
    </Modal>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : t('common.error');
  return (
    <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
      {message}
    </p>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-40 ${on ? 'bg-emerald-600' : 'bg-slate-300'}`}
    >
      <span
        className={`inline-block size-5 rounded-full bg-white shadow transition ${on ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'}`}
      />
    </button>
  );
}

// the .dt table styles (index.css) set header and cell look; these stay for places that still pass classes
export const th = '';
export const td = '';

/** Title, one plain sentence about the page, and its main actions: the head of every admin screen. */
export function PageHead({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="me-auto min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {hint && <p className="hint max-w-2xl">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** A table row that says what is missing and what to do next, instead of a bare "Nothing yet". */
export function EmptyRow({
  cols,
  icon,
  text,
  children,
}: {
  cols: number;
  icon: IconName;
  text: string;
  children?: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={cols} className="!py-10 text-center">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-slate-600">
          <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
            <Icon name={icon} size={24} />
          </span>
          <p>{text}</p>
          {children}
        </div>
      </td>
    </tr>
  );
}
