import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from 'i18next';
import { routerBasename } from '../lib/tenant';

/**
 * Keeps one broken screen from blanking the whole app. Without it, any error while drawing a page
 * (or a page file that no longer exists after an update) leaves the browser showing white. This shows
 * what to do instead: reload, or go back to the tables.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // a page file that vanished after an update is fixed by a reload: do it once, automatically
    if (isStaleChunk(error)) reloadOnce();
    console.error('screen failed to draw', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-md flex-col items-center gap-3 p-10 text-center"
      >
        <h1 className="text-xl font-semibold">{i18n.t('crash.title')}</h1>
        <p className="text-slate-600">{i18n.t('crash.hint')}</p>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => window.location.reload()}>
            {i18n.t('crash.reload')}
          </button>
          <a className="btn-secondary" href={routerBasename() || '/'}>
            {i18n.t('crash.home')}
          </a>
        </div>
      </div>
    );
  }
}

/** "Failed to fetch dynamically imported module": the app was updated while this tab was open. */
export const isStaleChunk = (e: unknown): boolean =>
  /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(
    String((e as { message?: string } | null)?.message ?? e),
  );

/** Reloads the page once (never in a loop): a new version brings the files the tab was looking for. */
export function reloadOnce(): void {
  const KEY = 'erp-chunk-reload';
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
}
