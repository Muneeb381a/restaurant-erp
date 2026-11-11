import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { QrCode, qrPngBlob } from '../../components/QrCode';
import { api } from '../../lib/api';
import { ErrorText, Field, PageHead, Toggle } from './ui';

interface Branch {
  id: string;
  name: string;
  name_ur: string | null;
}
type Settings = Record<string, unknown>;

/** The address a guest's phone must be able to reach. Localhost only works on the till itself. */
const isLocalOnly = (url: string): boolean => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
};
const validBase = (url: string): boolean => /^https?:\/\/[^\s/]+[^\s]*$/.test(url.trim());

/** Admin → QR menu: switch the customer menu on, set the address, write today's note, print the QR. */
export function QrMenuAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const branch = useQuery({ queryKey: ['branch'], queryFn: () => api<Branch>('/branch') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const [base, setBase] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const saved = settings.data['menu.public_url'];
    setBase(typeof saved === 'string' ? saved : window.location.origin);
    const n = settings.data['menu.public_note'];
    setNote(typeof n === 'string' ? n : '');
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (v: { key: string; value: unknown }) =>
      api(`/settings/${v.key}`, { method: 'PUT', body: { value: v.value } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['public-menu'] });
      setMessage(t('qr.saved'));
    },
  });

  const enabled = settings.data?.['menu.public_enabled'] === true;
  const baseOk = validBase(base);
  const cleanBase = base.trim().replace(/\/+$/, '');
  const link = branch.data && baseOk ? `${cleanBase}/m?b=${branch.data.id}` : '';
  const savedBase = settings.data?.['menu.public_url'];
  const baseDirty = typeof savedBase !== 'string' || savedBase !== cleanBase;
  const noteDirty =
    note.trim() !== ((settings.data?.['menu.public_note'] as string | undefined) ?? '');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the link is also shown in the box to copy by hand */
    }
  };
  const download = async (): Promise<void> => {
    const blob = await qrPngBlob(link);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'menu-qr.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <PageHead title={t('admin.qrMenu')} hint={t('qr.hint')} />
      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          {message}
        </p>
      )}
      <ErrorText error={save.error} />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {/* 1. on / off */}
          <section className="card flex flex-wrap items-center gap-4 p-4">
            <div className="me-auto min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{t('qr.visible')}</h3>
                {enabled ? (
                  <span className="chip-ok">{t('qr.live')}</span>
                ) : (
                  <span className="chip-mute">{t('qr.off')}</span>
                )}
              </div>
              <p className="hint">{enabled ? t('qr.liveHint') : t('qr.offHint')}</p>
            </div>
            <Toggle
              on={enabled}
              label={t('qr.visible')}
              disabled={save.isPending}
              onChange={(v) => save.mutate({ key: 'menu.public_enabled', value: v })}
            />
          </section>

          {/* 2. address */}
          <section className="card space-y-3 p-4">
            <div>
              <h3 className="font-semibold">{t('qr.addressTitle')}</h3>
              <p className="hint">{t('qr.addressHint')}</p>
            </div>
            <Field label={t('qr.address')}>
              <input
                className="input"
                dir="ltr"
                inputMode="url"
                placeholder="http://192.168.1.10"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
            </Field>
            {base && !baseOk && <p className="text-sm text-rose-700">{t('qr.addressBad')}</p>}
            {baseOk && isLocalOnly(cleanBase) && (
              <p
                role="note"
                className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
              >
                <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
                {t('qr.localWarn')}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary"
                disabled={!baseOk || !baseDirty || save.isPending}
                onClick={() => save.mutate({ key: 'menu.public_url', value: cleanBase })}
              >
                {t('qr.saveAddress')}
              </button>
              <button className="btn-secondary" onClick={() => setBase(window.location.origin)}>
                {t('qr.useThis')}
              </button>
            </div>
            {link && (
              <div className="rounded-lg bg-slate-100 p-3">
                <div className="micro">{t('qr.link')}</div>
                <div className="break-all text-sm" dir="ltr">
                  {link}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="btn-secondary" onClick={() => void copy()}>
                    <Icon name={copied ? 'check' : 'receipt'} size={18} />
                    {copied ? t('qr.copied') : t('qr.copy')}
                  </button>
                  <a className="btn-secondary" href={link} target="_blank" rel="noreferrer">
                    <Icon name="chevronRight" size={18} data-flip />
                    {t('qr.open')}
                  </a>
                </div>
              </div>
            )}
          </section>

          {/* 3. note */}
          <section className="card space-y-3 p-4">
            <div>
              <h3 className="font-semibold">{t('qr.noteTitle')}</h3>
              <p className="hint">{t('qr.noteHint')}</p>
            </div>
            <Field label={t('qr.note')}>
              <textarea
                className="input min-h-24 py-2"
                maxLength={300}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div className="flex items-center gap-3">
              <button
                className="btn-primary"
                disabled={!noteDirty || save.isPending}
                onClick={() => save.mutate({ key: 'menu.public_note', value: note.trim() })}
              >
                {t('qr.saveNote')}
              </button>
              <span className="hint money">{note.length}/300</span>
            </div>
          </section>
        </div>

        {/* the poster: also what gets printed */}
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div className="qr-poster card flex flex-col items-center gap-3 p-6 text-center">
            <p className="text-sm font-medium uppercase tracking-widest text-slate-600">
              {t('qr.posterEn', { lng: 'en' })}
            </p>
            <p className="text-lg font-semibold" dir="rtl" lang="ur">
              {t('qr.posterUr', { lng: 'ur' })}
            </p>
            {link ? (
              <QrCode text={link} size={240} label={t('qr.codeLabel')} />
            ) : (
              <div className="flex size-60 items-center justify-center rounded-lg border border-dashed border-slate-400 p-4 text-sm text-slate-600">
                {t('qr.needAddress')}
              </div>
            )}
            <div>
              <h4 className="text-xl font-semibold">{branch.data?.name}</h4>
              {branch.data?.name_ur && (
                <p className="text-lg" dir="rtl" lang="ur">
                  {branch.data.name_ur}
                </p>
              )}
            </div>
            <p className="text-xs text-slate-500" dir="ltr">
              {link.replace(/\?b=.*/, '')}
            </p>
          </div>
          <div className="qr-actions flex flex-wrap gap-2">
            <button className="btn-primary flex-1" disabled={!link} onClick={() => window.print()}>
              <Icon name="printer" size={18} />
              {t('qr.print')}
            </button>
            <button
              className="btn-secondary flex-1"
              disabled={!link}
              onClick={() => void download()}
            >
              {t('qr.download')}
            </button>
          </div>
          <p className="hint">{t('qr.printHint')}</p>
        </aside>
      </div>
    </div>
  );
}
