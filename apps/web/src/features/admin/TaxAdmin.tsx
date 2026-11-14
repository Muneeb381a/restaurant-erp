import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { parseRs } from '../../lib/money';
import type { TaxCategory, TaxReadiness, TaxRuleRow } from '../../lib/types';
import { EmptyRow, ErrorText, Field, Toggle } from './ui';

interface Branch {
  tax_authority: string;
  ntn: string | null;
  strn: string | null;
}
type Settings = Record<string, unknown>;
const AUTHORITIES = ['NONE', 'PRA', 'SRB', 'KPRA', 'BRA', 'FBR'] as const;
const today = (): string => localDate();
const pctText = (bps: number): string => `${bps / 100}%`;

/**
 * Tax set-up. The software ships NO rates: the owner (or their accountant) enters the categories and
 * rates from their tax authority, names who verified each one, and only then can tax be switched on.
 */
export function TaxAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const branch = useQuery({ queryKey: ['branch'], queryFn: () => api<Branch>('/branch') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const readiness = useQuery({
    queryKey: ['tax-readiness'],
    queryFn: () => api<TaxReadiness>('/tax/readiness'),
  });
  const categories = useQuery({
    queryKey: ['tax-categories'],
    queryFn: async () => (await api<{ items: TaxCategory[] }>('/tax/categories')).items,
  });
  const rules = useQuery({
    queryKey: ['tax-rules'],
    queryFn: async () => (await api<{ items: TaxRuleRow[] }>('/tax/rules')).items,
  });

  const [identity, setIdentity] = useState({ tax_authority: 'NONE', ntn: '', strn: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<TaxReadiness['problems']>([]);
  const [cat, setCat] = useState({ code: '', name: '' });
  const [rule, setRule] = useState({
    categoryId: '',
    paymentClass: 'CASH_OTHER',
    rate: '',
    from: today(),
    to: '',
    source: '',
    verifiedBy: '',
  });

  useEffect(() => {
    if (branch.data)
      setIdentity({
        tax_authority: branch.data.tax_authority,
        ntn: branch.data.ntn ?? '',
        strn: branch.data.strn ?? '',
      });
  }, [branch.data]);

  const refresh = async (): Promise<void> => {
    await Promise.all(
      ['branch', 'settings', 'tax-readiness', 'tax-categories', 'tax-rules'].map((k) =>
        qc.invalidateQueries({ queryKey: [k] }),
      ),
    );
  };
  const done = async (msg: string): Promise<void> => {
    setMessage(msg);
    await refresh();
  };

  const saveIdentity = useMutation({
    mutationFn: () =>
      api('/branch', {
        method: 'PATCH',
        body: {
          tax_authority: identity.tax_authority,
          ntn: identity.ntn.trim() || null,
          strn: identity.strn.trim() || null,
        },
      }),
    onSuccess: () => done(t('taxPage.saved')),
  });
  const setSetting = useMutation({
    mutationFn: (v: { key: string; value: boolean }) =>
      api(`/settings/${v.key}`, { method: 'PUT', body: { value: v.value } }),
    onSuccess: async () => {
      setProblems([]);
      await done(t('taxPage.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'TAX_NOT_READY')
        setProblems((e.body.problems as TaxReadiness['problems']) ?? []);
    },
  });
  const addCategory = useMutation({
    mutationFn: () =>
      api('/tax/categories', {
        method: 'POST',
        body: { code: cat.code.trim().toUpperCase().replace(/\s+/g, '_'), name: cat.name.trim() },
      }),
    onSuccess: async () => {
      setCat({ code: '', name: '' });
      await done(t('taxPage.saved'));
    },
  });
  const addRule = useMutation({
    mutationFn: () =>
      api('/tax/rules', {
        method: 'POST',
        body: {
          authority: identity.tax_authority,
          categoryId: rule.categoryId,
          paymentClass: rule.paymentClass,
          rateBps: parseRs(rule.rate) ?? 0,
          effectiveFrom: rule.from,
          ...(rule.to ? { effectiveTo: rule.to } : {}),
          ...(rule.source.trim() ? { sourceNote: rule.source.trim() } : {}),
          ...(rule.verifiedBy.trim() ? { verifiedBy: rule.verifiedBy.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setRule({ ...rule, rate: '', to: '', source: '', verifiedBy: '' });
      await done(t('taxPage.saved'));
    },
  });
  const patchRule = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      api(`/tax/rules/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => done(t('taxPage.saved')),
  });

  const enabled = settings.data?.['tax.enabled'] === true;
  const taxableService = settings.data?.['tax.service_charge_taxable'] !== false;
  const authority = branch.data?.tax_authority ?? 'NONE';
  const myRules = (rules.data ?? []).filter((r) => r.authority === authority);
  const ruleValid =
    !!rule.categoryId &&
    parseRs(rule.rate) !== null &&
    (parseRs(rule.rate) ?? 0) <= 10_000 &&
    !!rule.from &&
    authority !== 'NONE';

  return (
    <div className="max-w-6xl space-y-6 p-4 md:p-6">
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('taxPage.notice')}</p>
      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
          {message}
        </p>
      )}
      <ErrorText
        error={saveIdentity.error ?? addCategory.error ?? addRule.error ?? patchRule.error}
      />

      <section className="card space-y-3 p-4">
        <div className="flex items-center gap-3">
          <h2 className="me-auto text-lg font-bold">{t('taxPage.status')}</h2>
          <span
            className={`rounded px-2 py-1 text-sm ${enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-200'}`}
          >
            {enabled ? t('taxPage.on') : t('taxPage.off')}
          </span>
          <Toggle
            on={enabled}
            label={t('taxPage.enable')}
            onChange={(v) => setSetting.mutate({ key: 'tax.enabled', value: v })}
          />
        </div>
        {readiness.data && !readiness.data.ready && (
          <ul
            className="list-disc space-y-1 ps-5 text-sm text-amber-900"
            aria-label={t('taxPage.problems')}
          >
            {readiness.data.problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        )}
        {readiness.data?.ready && <p className="text-sm text-emerald-800">{t('taxPage.ready')}</p>}
        {problems.length > 0 && (
          <p role="alert" className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">
            {t('taxPage.notReady')}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Toggle
            on={taxableService}
            label={t('taxPage.serviceTaxable')}
            onChange={(v) => setSetting.mutate({ key: 'tax.service_charge_taxable', value: v })}
          />
          <span>{t('taxPage.serviceTaxable')}</span>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('taxPage.identity')}</h2>
        <Field label={t('taxPage.authority')}>
          <select
            className="input"
            value={identity.tax_authority}
            onChange={(e) => setIdentity({ ...identity, tax_authority: e.target.value })}
          >
            {AUTHORITIES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="NTN">
            <input
              className="input"
              value={identity.ntn}
              onChange={(e) => setIdentity({ ...identity, ntn: e.target.value })}
            />
          </Field>
          <Field label="STRN">
            <input
              className="input"
              value={identity.strn}
              onChange={(e) => setIdentity({ ...identity, strn: e.target.value })}
            />
          </Field>
        </div>
        <button
          className="btn-primary"
          disabled={saveIdentity.isPending}
          onClick={() => saveIdentity.mutate()}
        >
          {t('admin.save')}
        </button>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('taxPage.categories')}</h2>
        <p className="text-sm text-slate-600">{t('taxPage.categoriesHint')}</p>
        <ul className="flex flex-wrap gap-2">
          {(categories.data ?? []).map((c) => (
            <li key={c.id} className="rounded bg-slate-100 px-2 py-1 text-sm">
              {c.name} <code className="text-xs text-slate-500">{c.code}</code>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('taxPage.code')}>
            <input
              className="input"
              value={cat.code}
              onChange={(e) => setCat({ ...cat, code: e.target.value })}
            />
          </Field>
          <Field label={t('taxPage.name')}>
            <input
              className="input"
              value={cat.name}
              onChange={(e) => setCat({ ...cat, name: e.target.value })}
            />
          </Field>
          <button
            className="btn-secondary"
            disabled={!cat.code.trim() || !cat.name.trim() || addCategory.isPending}
            onClick={() => addCategory.mutate()}
          >
            {t('taxPage.addCategory')}
          </button>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-semibold">
          {t('taxPage.rules')} {authority !== 'NONE' ? `(${authority})` : ''}
        </h2>
        <p className="text-sm text-slate-600">{t('taxPage.rulesHint')}</p>
        <div className="dt">
          <table className="min-w-[44rem]">
            <thead>
              <tr>
                <th>{t('taxPage.category')}</th>
                <th>{t('taxPage.class')}</th>
                <th className="num">{t('taxPage.rate')}</th>
                <th>{t('taxPage.from')}</th>
                <th>{t('taxPage.to')}</th>
                <th>{t('taxPage.verifiedBy')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {myRules.map((r) => (
                <tr key={r.id} data-testid={`rule-${r.categoryCode}-${r.paymentClass}`}>
                  <td className="name">{r.categoryCode}</td>
                  <td>
                    <span className="chip-mute">{t(`taxPage.classes.${r.paymentClass}`)}</span>
                  </td>
                  <td className="num font-semibold">{pctText(r.rateBps)}</td>
                  <td className="money">{r.effectiveFrom}</td>
                  <td className="money">
                    {r.effectiveTo ?? <span className="chip-ok">{t('taxPage.current')}</span>}
                  </td>
                  <td>
                    {r.verifiedBy ? (
                      <span className="chip-ok">{r.verifiedBy}</span>
                    ) : (
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          const who = window.prompt(t('taxPage.verifyPrompt'));
                          if (who && who.trim())
                            patchRule.mutate({ id: r.id, body: { verifiedBy: who.trim() } });
                        }}
                      >
                        {t('taxPage.verify')}
                      </button>
                    )}
                  </td>
                  <td className="text-end">
                    {!r.effectiveTo && (
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          const d = window.prompt(t('taxPage.endPrompt'), today());
                          if (d && /^\d{4}-\d{2}-\d{2}$/.test(d))
                            patchRule.mutate({ id: r.id, body: { effectiveTo: d } });
                        }}
                      >
                        {t('taxPage.end')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {myRules.length === 0 && (
                <EmptyRow cols={7} icon="receipt" text={t('taxPage.noRules')} />
              )}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-3">
          <Field label={t('taxPage.category')}>
            <select
              className="input"
              value={rule.categoryId}
              onChange={(e) => setRule({ ...rule, categoryId: e.target.value })}
            >
              <option value="">—</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('taxPage.class')}>
            <select
              className="input"
              value={rule.paymentClass}
              onChange={(e) => setRule({ ...rule, paymentClass: e.target.value })}
            >
              {(['CASH_OTHER', 'DIGITAL', 'ANY'] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`taxPage.classes.${c}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('taxPage.rate')}>
            <input
              className="input"
              inputMode="decimal"
              value={rule.rate}
              onChange={(e) => setRule({ ...rule, rate: e.target.value })}
            />
          </Field>
          <Field label={t('taxPage.from')}>
            <input
              type="date"
              className="input"
              value={rule.from}
              onChange={(e) => setRule({ ...rule, from: e.target.value })}
            />
          </Field>
          <Field label={t('taxPage.to')}>
            <input
              type="date"
              className="input"
              value={rule.to}
              onChange={(e) => setRule({ ...rule, to: e.target.value })}
            />
          </Field>
          <Field label={t('taxPage.verifiedBy')}>
            <input
              className="input"
              value={rule.verifiedBy}
              onChange={(e) => setRule({ ...rule, verifiedBy: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-3">
            <Field label={t('taxPage.source')}>
              <input
                className="input"
                value={rule.source}
                onChange={(e) => setRule({ ...rule, source: e.target.value })}
              />
            </Field>
          </div>
        </div>
        {authority === 'NONE' && (
          <p className="text-sm text-amber-800">{t('taxPage.pickAuthority')}</p>
        )}
        <button
          className="btn-primary"
          disabled={!ruleValid || addRule.isPending}
          onClick={() => addRule.mutate()}
        >
          {t('taxPage.addRule')}
        </button>
      </section>
    </div>
  );
}
