import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import { initI18n } from './i18n';
import './index.css';
import { LandingPage } from './features/landing/LandingPage';
import { TenantGate } from './features/landing/TenantGate';
import { PlatformApp } from './features/platform/PlatformApp';
import { ApiError } from './lib/api';
import { mode, routerBasename } from './lib/tenant';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** One build, four kinds of address (see lib/tenant.ts). */
function Root(): ReactNode {
  switch (mode.kind) {
    case 'platform':
      return <PlatformApp />;
    case 'landing':
      return <LandingPage />;
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
