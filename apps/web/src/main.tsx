import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import { initI18n } from './i18n';
import './index.css';
import { TenantGate } from './features/landing/TenantGate';
import { ApiError } from './lib/api';
import { registerOffline } from './lib/online';
import { hydrateCache, persistCache } from './lib/persist';
import { mode, routerBasename } from './lib/tenant';

// the platform admin and the landing page are separate downloads: restaurant staff never fetch them
const PlatformApp = lazy(async () => ({
  default: (await import('./features/platform/PlatformApp')).PlatformApp,
}));
const LandingPage = lazy(async () => ({
  default: (await import('./features/landing/LandingPage')).LandingPage,
}));

const queryClient = new QueryClient({
  defaultOptions: {
    // a payment or an order must never wait silently for the internet and then fire later: it fails at
    // once with a clear message (see lib/api.ts). Reads keep their data and refresh when back online.
    mutations: { networkMode: 'always' },
    queries: {
      retry: (count, error) =>
        !(error instanceof ApiError && error.status > 0 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

hydrateCache(queryClient);
persistCache(queryClient);

/** One build, four kinds of address (see lib/tenant.ts). */
function Root(): ReactNode {
  switch (mode.kind) {
    case 'platform':
      return (
        <Suspense fallback={null}>
          <PlatformApp />
        </Suspense>
      );
    case 'landing':
      return (
        <Suspense fallback={null}>
          <LandingPage />
        </Suspense>
      );
    case 'tenant':
      return (
        <TenantGate>
          <App />
        </TenantGate>
      );
    default:
      return <App />;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={initI18n()}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={routerBasename()}>
          <Root />
        </BrowserRouter>
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);

registerOffline();
