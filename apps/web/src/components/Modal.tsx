import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

/**
 * The one overlay of the app. A centred dialog on tablets and desktops, a bottom sheet on phones.
 * Esc and a tap on the dim area close it; focus moves inside and returns afterwards.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the content: the primary action lives here, always visible. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current
      ?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not([data-close])')
      ?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && dismissible) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose, dismissible]);

  const width = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg';
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/55 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-sheet sm:rounded-2xl ${width}`}
      >
        <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
          <h2 className="me-auto text-xl font-semibold">{title}</h2>
          {dismissible && (
            <button
              data-close
              className="btn-quiet -me-2"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <Icon name="x" />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
