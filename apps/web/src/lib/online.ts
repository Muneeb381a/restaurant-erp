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
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
