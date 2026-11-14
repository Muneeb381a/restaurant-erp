import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Mark } from '../../components/Brand';
import { mode, useTenantState } from '../../lib/tenant';

export interface TenantInfo {
  slug: string;
  name: string;
  available: boolean;
}

function useCloudTenantInfo(): TenantInfo | undefined {
  const slug = mode.kind === 'tenant' ? mode.slug : '';
  const q = useQuery({
    queryKey: ['tenant-info', slug],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<TenantInfo | null> => {
      const res = await fetch(`/api/v1/public/tenants/${slug}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`tenant info ${res.status}`);
      return (await res.json()) as TenantInfo;
    },
  });
  return q.data ?? undefined;
}

/**
 * The restaurant's public name (cached). The mode never changes while the page is open, so which
 * hook runs is decided once; a single-restaurant install uses no query at all.
 */
export const useTenantInfo: () => TenantInfo | undefined =
  mode.kind === 'tenant' ? useCloudTenantInfo : () => undefined;

function Notice({ title, text, extra }: { title: string; text: string; extra?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 text-center shadow-sheet">
        <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-slate-900 text-white">
          <Mark size={30} />
        </span>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-slate-700">{text}</p>
        {extra}
        <a className="btn-secondary w-full" href="/">
          {t('gate.again')}
        </a>
      </div>
    </main>
  );
}

/**
 * Cloud mode: before the till opens, check that the restaurant in the address exists and is switched
 * on, and say so plainly if not. Also catches a restaurant switched off while someone is using it.
 */
export function TenantGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const slug = mode.kind === 'tenant' ? mode.slug : '';
  const blocked = useTenantState();
  const info = useQuery({
    queryKey: ['tenant-info', slug],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<TenantInfo | null> => {
      const res = await fetch(`/api/v1/public/tenants/${slug}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`tenant info ${res.status}`);
      return (await res.json()) as TenantInfo;
    },
  });

  if (blocked.suspended || (info.data && !info.data.available))
    return (
      <Notice
        title={t('gate.offTitle')}
        text={t('gate.offText')}
        extra={
          blocked.reason ? (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {t('gate.offReason', { reason: blocked.reason })}
            </p>
          ) : null
        }
      />
    );
  if (info.isPending) return <p className="p-6 text-center text-slate-600">{t('gate.loading')}</p>;
  if (info.data === null)
    return <Notice title={t('gate.notFoundTitle')} text={t('gate.notFoundText', { code: slug })} />;
  // a network error does not block: the sign-in screen has its own "server unreachable" indicator
  return <>{children}</>;
}
