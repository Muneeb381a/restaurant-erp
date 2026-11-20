import { useSyncExternalStore } from 'react';
import { mode } from './tenant';

/** Is this device connected to the internet (or the restaurant network) right now? */
const subscribe = (cb: () => void): (() => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};
export const useOnline = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );

/**
 * Lets the app open without internet (service worker + installable app). The service worker is only
 * registered in a production build: in development it would serve stale files.
 */
export function registerOffline(): void {
  if (mode.kind === 'tenant') {
    // each restaurant installs as its own app that opens on its own sign-in screen
    document
      .querySelector<HTMLLinkElement>('link[rel="manifest"]')
      ?.setAttribute('href', `/api/v1/public/tenants/${mode.slug}/manifest`);
  }
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => keepUpToDate(reg))
      .catch(() => undefined);
  });
}

/**
 * A new version arrives by itself, nobody has to clear anything: the browser is asked for a new service worker on
 * load, every 10 minutes, when the connection returns and when the tab is shown again. When the new one takes over,
 * the page reloads at a quiet moment (the Tables screen, or the tab is in the background), never in the middle of
 * an order or a payment. Orders kept offline live in storage and survive the reload.
 */
function keepUpToDate(reg: ServiceWorkerRegistration): void {
  const check = (): void => void reg.update().catch(() => undefined);
  setInterval(check, 10 * 60_000);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  if (!navigator.serviceWorker.controller) return; // first install: nothing old to replace
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    const quiet = (): boolean => {
      const path = location.pathname.replace(/^\/r\/[^/]+/, '') || '/';
      return path === '/' || document.visibilityState === 'hidden';
    };
    const timer = setInterval(() => {
      if (!quiet()) return;
      clearInterval(timer);
      reloading = true;
      location.reload();
    }, 3000);
  });
}
