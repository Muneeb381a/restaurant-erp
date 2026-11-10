import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { parseRs } from '../../lib/money';
import { ErrorText, Field, Toggle } from './ui';

interface Branch {
  name: string;
  name_ur: string | null;
  address: string | null;
  phone: string | null;
}
type Settings = Record<string, unknown>;

/** Restaurant details and the few switches that change how bills and receipts behave. */
export function SettingsAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const branch = useQuery({ queryKey: ['branch'], queryFn: () => api<Branch>('/branch') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const [form, setForm] = useState({ name: '', name_ur: '', address: '', phone: '' });
  const [service, setService] = useState('0');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (branch.data)
      setForm({
        name: branch.data.name,
        name_ur: branch.data.name_ur ?? '',
        address: branch.data.address ?? '',
        phone: branch.data.phone ?? '',
      });
  }, [branch.data]);
  useEffect(() => {
    const bps = settings.data?.['billing.service_charge_bps'];
    if (typeof bps === 'number') setService(String(bps / 100));
  }, [settings.data]);

  const saveBranch = useMutation({
    mutationFn: () =>
      api('/branch', {
        method: 'PATCH',
        body: {
          name: form.name.trim(),
          name_ur: form.name_ur.trim() || null,
          address: form.address.trim() || null,
          phone: form.phone.trim() || null,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['branch'] });
      setMessage(t('settingsPage.saved'));
    },
  });
  const setSetting = useMutation({
    mutationFn: (v: { key: string; value: unknown }) =>
      api(`/settings/${v.key}`, { method: 'PUT', body: { value: v.value } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      setMessage(t('settingsPage.saved'));
    },
  });

  const s = settings.data ?? {};
  const lang = s['receipt.language'] === 'ur' ? 'ur' : 'en';
  const bps = parseRs(service);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
          {message}
        </p>
      )}
      <ErrorText error={saveBranch.error ?? setSetting.error} />

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('settingsPage.restaurant')}</h2>
        <Field label={t('settingsPage.name')}>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label={t('settingsPage.nameUr')}>
          <input
            className="input"
            dir="rtl"
            value={form.name_ur}
            onChange={(e) => setForm({ ...form, name_ur: e.target.value })}
          />
        </Field>
        <Field label={t('settingsPage.address')}>
          <input
            className="input"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </Field>
        <Field label={t('settingsPage.phone')}>
          <input
            className="input"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Field>
        <button
          className="btn-primary"
          disabled={!form.name.trim() || saveBranch.isPending}
          onClick={() => saveBranch.mutate()}
        >
          {t('settingsPage.saveRestaurant')}
        </button>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('settingsPage.billing')}</h2>
        <Field label={t('settingsPage.serviceCharge')}>
          <div className="flex gap-2">
            <input
              className="input w-32"
              inputMode="decimal"
              value={service}
              onChange={(e) => setService(e.target.value)}
            />
            <button
              className="btn-secondary"
              disabled={bps === null || bps > 10_000 || setSetting.isPending}
              onClick={() => setSetting.mutate({ key: 'billing.service_charge_bps', value: bps })}
            >
              {t('settingsPage.applyService')}
            </button>
          </div>
        </Field>
        <p className="text-sm text-slate-500">{t('settingsPage.serviceChargeHint')}</p>
        <div className="flex items-center gap-3">
          <Toggle
            on={s['billing.round_to_rupee'] === true}
            label={t('settingsPage.roundToRupee')}
            onChange={(v) => setSetting.mutate({ key: 'billing.round_to_rupee', value: v })}
          />
          <span>{t('settingsPage.roundToRupee')}</span>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('settingsPage.receipt')}</h2>
        <div className="text-sm text-slate-600">{t('settingsPage.language')}</div>
        <div className="flex gap-2">
          {(['en', 'ur'] as const).map((l) => (
            <button
              key={l}
              className={lang === l ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setSetting.mutate({ key: 'receipt.language', value: l })}
            >
              {t(`settingsPage.${l}`)}
            </button>
          ))}
        </div>
        <p className="text-sm text-slate-500">{t('settingsPage.languageHint')}</p>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('settingsPage.kitchen')}</h2>
        <div className="flex items-center gap-3">
          <Toggle
            on={s['kot.print_on_send'] !== false}
            label={t('settingsPage.printOnSend')}
            onChange={(v) => setSetting.mutate({ key: 'kot.print_on_send', value: v })}
          />
          <span>{t('settingsPage.printOnSend')}</span>
        </div>
      </section>
    </div>
  );
}
