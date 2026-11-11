import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
      className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition disabled:opacity-40 ${on ? 'bg-emerald-600' : 'bg-slate-300'}`}
    >
      <span
        className={`inline-block size-6 rounded-full bg-white shadow transition ${on ? 'translate-x-7 rtl:-translate-x-7' : 'translate-x-1 rtl:-translate-x-1'}`}
      />
    </button>
  );
}

export const th = 'px-3 py-2 text-start text-sm font-semibold text-slate-600';
export const td = 'px-3 py-2 align-top';
