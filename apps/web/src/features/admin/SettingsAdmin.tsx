import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import { api } from '../../lib/api';
import { parseRs } from '../../lib/money';
import { PrintHelp } from './PrintHelp';
import { mode } from '../../lib/tenant';
import { LogoControls } from './LogoControls';
import { ErrorText, Field, PageHead, Toggle } from './ui';

interface Branch {
  name: string;
  name_ur: string | null;
  address: string | null;
  phone: string | null;
  logoVersion: number | null;
}
type Settings = Record<string, unknown>;

/** A titled block: icon, heading, one line of explanation, then the controls. */
function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-slate-700 ring-1 ring-slate-300">
          <Icon name={icon} size={20} />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          {hint && <p className="hint">{hint}</p>}
        </div>
      </header>
      <div className="divide-y divide-slate-200">{children}</div>
    </section>
  );
}

/** One setting: what it is on the start side, the control on the end side. */
function Row({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      {(title || hint) && (
        <div className="min-w-0 flex-1 basis-56">
          {title && <div className="font-medium">{title}</div>}
          {hint && <p className="hint">{hint}</p>}
        </div>
      )}
      <div className={title || hint ? 'shrink-0' : 'w-full'}>{children}</div>
    </div>
  );
}

/** Restaurant details and the few switches that change how bills and receipts behave. */
export function SettingsAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const branch = useQuery({ queryKey: ['branch'], queryFn: () => api<Branch>('/branch') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const [form, setForm] = useState({ name: '', name_ur: '', address: '', phone: '' });
  const [service, setService] = useState('0');
  const [ownerPhone, setOwnerPhone] = useState('');
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

  useEffect(() => {
    const p = settings.data?.['report.owner_phone'];
    setOwnerPhone(typeof p === 'string' ? p : '');
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
    <div className="max-w-3xl space-y-5 p-4 md:p-6">
      <PageHead title={t('admin.settings')} hint={t('settingsPage.hint')} />
      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          {message}
        </p>
      )}
      <ErrorText error={saveBranch.error ?? setSetting.error} />

      {mode.kind === 'tenant' && (
        <Section icon="printer" title={t('printHelp.title')} hint={t('printHelp.hint')}>
          <PrintHelp />
        </Section>
      )}

      <Section icon="receipt" title={t('logo.title')} hint={t('logo.sectionHint')}>
        <LogoControls version={branch.data?.logoVersion ?? null} />
      </Section>

      <Section
        icon="bag"
        title={t('settingsPage.restaurant')}
        hint={t('settingsPage.restaurantHint')}
      >
        <div className="grid gap-4 p-4 sm:grid-cols-2">
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
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <button
              className="btn-primary"
              disabled={!form.name.trim() || saveBranch.isPending}
              onClick={() => saveBranch.mutate()}
            >
              {t('settingsPage.saveRestaurant')}
            </button>
          </div>
        </div>
      </Section>

      <Section icon="cash" title={t('settingsPage.billing')} hint={t('settingsPage.billingHint')}>
        <Row title={undefined} hint={undefined}>
          <Field label={t('settingsPage.serviceCharge')}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input w-32"
                inputMode="decimal"
                dir="ltr"
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
              <span className="hint">{t('settingsPage.serviceChargeHint')}</span>
            </div>
          </Field>
        </Row>
        <Row title={t('settingsPage.roundToRupee')} hint={t('settingsPage.roundHint')}>
          <Toggle
            on={s['billing.round_to_rupee'] === true}
            label={t('settingsPage.roundToRupee')}
            onChange={(v) => setSetting.mutate({ key: 'billing.round_to_rupee', value: v })}
          />
        </Row>
      </Section>

      <Section
        icon="receipt"
        title={t('settingsPage.receipt')}
        hint={t('settingsPage.receiptHint')}
      >
        <Row title={t('settingsPage.language')} hint={t('settingsPage.languageHint')}>
          <div className="flex gap-2">
            {(['en', 'ur'] as const).map((l) => (
              <button
                key={l}
                className={lang === l ? 'btn-primary' : 'btn-secondary'}
                aria-pressed={lang === l}
                onClick={() => setSetting.mutate({ key: 'receipt.language', value: l })}
              >
                {t(`settingsPage.${l}`)}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <Section icon="chart" title={t('settingsPage.reports')} hint={t('settingsPage.reportsHint')}>
        <Row>
          <Field label={t('settingsPage.ownerPhone')}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input w-56"
                dir="ltr"
                inputMode="tel"
                placeholder="0300 1234567"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
              />
              <button
                className="btn-secondary"
                disabled={setSetting.isPending || !/^(\+?[0-9 -]{8,20})?$/.test(ownerPhone)}
                onClick={() =>
                  setSetting.mutate({
                    key: 'report.owner_phone',
                    value: ownerPhone.replace(/[ -]/g, ''),
                  })
                }
              >
                {t('settingsPage.saveNumber')}
              </button>
            </div>
          </Field>
          <p className="hint mt-1">{t('settingsPage.ownerPhoneHint')}</p>
        </Row>
      </Section>

      <Section icon="flame" title={t('settingsPage.kitchen')} hint={t('settingsPage.kitchenHint')}>
        <Row title={t('settingsPage.printOnSend')} hint={t('settingsPage.printOnSendHint')}>
          <Toggle
            on={s['kot.print_on_send'] !== false}
            label={t('settingsPage.printOnSend')}
            onChange={(v) => setSetting.mutate({ key: 'kot.print_on_send', value: v })}
          />
        </Row>
      </Section>
    </div>
  );
}
