import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader } from '../../components/Loader';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { prepareLogo, type PreparedLogo } from '../../lib/image';
import { ErrorText } from './ui';

/**
 * The restaurant's logo: shown in the top bar and printed at the top of every bill. The picture is
 * prepared here in the browser (a PNG for the screen, a black-and-white dot version for each thermal
 * paper width) and the preview shows exactly what the printer will print.
 */
export function LogoControls({ version }: { version: number | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [prepared, setPrepared] = useState<PreparedLogo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const saved = useQuery({
    queryKey: ['logo', version],
    enabled: version != null,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    queryFn: async () =>
      URL.createObjectURL(await api<Blob>('/branch/logo', { responseType: 'blob' })),
  });
  const refresh = (): Promise<unknown> => qc.invalidateQueries({ queryKey: ['branch'] });

  const save = useMutation({
    mutationFn: () =>
      api('/branch/logo', {
        method: 'PUT',
        body: {
          image: prepared!.image,
          raster58: prepared!.raster58,
          raster80: prepared!.raster80,
        },
      }),
    onSuccess: async () => {
      setPrepared(null);
      await refresh();
    },
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: () => api('/branch/logo', { method: 'DELETE' }),
    onSuccess: refresh,
    onError: setError,
  });

  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      setPrepared(await prepareLogo(file));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start gap-6">
        <div className="space-y-2">
          <div className="micro">{t('logo.current')}</div>
          <div className="flex size-28 items-center justify-center overflow-hidden rounded-xl border border-slate-300 bg-white">
            {saved.data ? (
              <img src={saved.data} alt={t('logo.current')} className="size-full object-contain" />
            ) : (
              <span className="px-2 text-center text-sm text-slate-500">{t('logo.none')}</span>
            )}
          </div>
        </div>

        {prepared && (
          <div className="space-y-2">
            <div className="micro">{t('logo.howItPrints')}</div>
            <div className="rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
              <img
                src={prepared.preview80}
                alt={t('logo.howItPrints')}
                className="block h-auto w-72 max-w-full"
                style={{ imageRendering: 'pixelated' }}
              />
            </div>
          </div>
        )}
      </div>

      <p className="hint max-w-xl">{t('logo.hint')}</p>
      <ErrorText error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader size="sm" inline /> : saved.data ? t('logo.change') : t('logo.upload')}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={t('logo.upload')}
          onChange={(e) => void choose(e.target.files?.[0])}
        />
        {prepared && (
          <>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {t('logo.save')}
            </button>
            <button className="btn-quiet" onClick={() => setPrepared(null)}>
              {t('common.cancel')}
            </button>
          </>
        )}
        {version != null && !prepared && (
          <button
            className="btn-danger-quiet ms-auto"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t('logo.remove')}
          </button>
        )}
      </div>
    </div>
  );
}
