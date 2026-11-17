import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import type { PaymentMethod } from '../../lib/types';
import { Dialog, EmptyRow, ErrorText, Field, PageHead, Toggle } from './ui';

/**
 * The ways a guest can pay. A new restaurant starts with none, so the common Pakistani ones are one tap
 * away. "Digital" matters for tax later: once tax is switched on, a bill paid only by digital methods
 * uses the digital rate (the accountant decides which methods count; see OPEN-QUESTIONS).
 */
const PRESETS: {
  code: string;
  name: string;
  tender_class: 'CASH_OTHER' | 'DIGITAL';
  opens_drawer: boolean;
  needs_reference: boolean;
}[] = [
  {
    code: 'CASH',
    name: 'Cash',
    tender_class: 'CASH_OTHER',
    opens_drawer: true,
    needs_reference: false,
  },
  {
    code: 'CARD',
    name: 'Card',
    tender_class: 'DIGITAL',
    opens_drawer: false,
    needs_reference: true,
  },
  {
    code: 'JAZZCASH',
    name: 'JazzCash',
    tender_class: 'DIGITAL',
    opens_drawer: false,
    needs_reference: true,
  },
  {
    code: 'EASYPAISA',
    name: 'Easypaisa',
    tender_class: 'DIGITAL',
    opens_drawer: false,
    needs_reference: true,
  },
  {
    code: 'RAAST_QR',
    name: 'Raast / bank QR',
    tender_class: 'DIGITAL',
    opens_drawer: false,
    needs_reference: true,
  },
  {
    code: 'KHATA',
    name: 'Khata (credit)',
    tender_class: 'CASH_OTHER',
    opens_drawer: false,
    needs_reference: false,
  },
];

const codeFrom = (name: string): string =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

export function PaymentsAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin-payment-methods'],
    queryFn: async () => (await api<{ items: PaymentMethod[] }>('/payment-methods')).items,
  });
  const [editing, setEditing] = useState<PaymentMethod | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = (): Promise<unknown> =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin-payment-methods'] }),
      qc.invalidateQueries({ queryKey: ['payment-methods'] }),
    ]);

  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) =>
      api(`/payment-methods/${v.id}`, { method: 'PATCH', body: { is_active: v.on } }),
    onSuccess: refresh,
    onError: setError,
  });
  const quickAdd = useMutation({
    mutationFn: (p: (typeof PRESETS)[number]) =>
      api('/payment-methods', { method: 'POST', body: p }),
    onSuccess: refresh,
    onError: setError,
  });

  const have = new Set((list.data ?? []).map((m) => m.code));
  const missing = PRESETS.filter((p) => !have.has(p.code));

  return (
    <div className="max-w-5xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.payments')} hint={t('paymentsPage.hint')}>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          {t('paymentsPage.new')}
        </button>
      </PageHead>
      <ErrorText error={error} />

      {missing.length > 0 && (
        <section className="space-y-2 rounded-xl border border-slate-300 bg-white p-3">
          <div className="micro">{t('paymentsPage.quickAdd')}</div>
          <div className="flex flex-wrap gap-2">
            {missing.map((p) => (
              <button
                key={p.code}
                className="btn-secondary"
                disabled={quickAdd.isPending}
                onClick={() => quickAdd.mutate(p)}
              >
                <Icon name="plus" size={16} />
                {p.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="dt">
        <table className="min-w-[40rem]">
          <thead>
            <tr>
              <th>{t('admin.name')}</th>
              <th>{t('paymentsPage.type')}</th>
              <th>{t('paymentsPage.asksRef')}</th>
              <th>{t('paymentsPage.opensDrawer')}</th>
              <th>{t('admin.active')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((m) => (
              <tr key={m.id} className={m.is_active ? '' : 'opacity-55'}>
                <td className="name">
                  {m.name}
                  <span className="sub">{m.code}</span>
                </td>
                <td>
                  <span className={m.tender_class === 'DIGITAL' ? 'chip-info' : 'chip-mute'}>
                    {t(m.tender_class === 'DIGITAL' ? 'paymentsPage.digital' : 'paymentsPage.cash')}
                  </span>
                </td>
                <td>{m.needs_reference ? <Icon name="check" size={18} /> : '–'}</td>
                <td>{m.opens_drawer ? <Icon name="check" size={18} /> : '–'}</td>
                <td>
                  <Toggle
                    on={m.is_active}
                    label={`${t('admin.active')} ${m.name}`}
                    onChange={(on) => toggle.mutate({ id: m.id, on })}
                  />
                </td>
                <td className="text-end">
                  <button
                    className="btn-secondary"
                    aria-label={`${t('admin.edit')} ${m.name}`}
                    onClick={() => setEditing(m)}
                  >
                    {t('admin.edit')}
                  </button>
                </td>
              </tr>
            ))}
            {list.isSuccess && list.data.length === 0 && (
              <EmptyRow cols={6} icon="cash" text={t('paymentsPage.empty')} />
            )}
          </tbody>
        </table>
      </div>
      <p className="hint max-w-2xl">{t('paymentsPage.noDelete')}</p>

      {editing && (
        <MethodDialog
          method={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}

function MethodDialog({
  method,
  onClose,
  onDone,
}: {
  method: PaymentMethod | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(method?.name ?? '');
  const [cls, setCls] = useState<'CASH_OTHER' | 'DIGITAL'>(method?.tender_class ?? 'DIGITAL');
  const [ref, setRef] = useState(method?.needs_reference ?? true);
  const [drawer, setDrawer] = useState(method?.opens_drawer ?? false);
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        tender_class: cls,
        needs_reference: ref,
        opens_drawer: drawer,
      };
      // the code is how bills and reports name the method: it is set once, never changed
      return method
        ? api(`/payment-methods/${method.id}`, { method: 'PATCH', body })
        : api('/payment-methods', {
            method: 'POST',
            body: { ...body, code: codeFrom(name) || 'METHOD' },
          });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog
      title={method ? `${t('admin.edit')}: ${method.name}` : t('paymentsPage.new')}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Field label={t('admin.name')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('paymentsPage.type')}>
          <select
            className="input"
            value={cls}
            onChange={(e) => setCls(e.target.value as 'CASH_OTHER' | 'DIGITAL')}
          >
            <option value="CASH_OTHER">{t('paymentsPage.cash')}</option>
            <option value="DIGITAL">{t('paymentsPage.digital')}</option>
          </select>
        </Field>
        <p className="hint">{t('paymentsPage.typeHint')}</p>
        <label className="flex items-center gap-3">
          <Toggle on={ref} label={t('paymentsPage.asksRef')} onChange={setRef} />
          <span>
            {t('paymentsPage.asksRef')}
            <span className="hint block">{t('paymentsPage.refHint')}</span>
          </span>
        </label>
        <label className="flex items-center gap-3">
          <Toggle on={drawer} label={t('paymentsPage.opensDrawer')} onChange={setDrawer} />
          <span>{t('paymentsPage.opensDrawer')}</span>
        </label>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {method ? t('admin.save') : t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
