import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { whatsappLink } from '../../lib/whatsapp';

/** The day's summary as a message: read it, send it on WhatsApp (to the owner's number when set), or copy it. */
export function SummaryShare({ date }: { date: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'ur' ? 'ur' : 'en';
  const [copied, setCopied] = useState(false);
  const summary = useQuery({
    queryKey: ['day-summary', date, lang],
    queryFn: () => api<{ text: string }>(`/reports/day-summary?date=${date}&lang=${lang}`),
    retry: false,
    staleTime: 0,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Record<string, unknown>>('/settings'),
    retry: false,
  });
  if (summary.isError) return null; // no permission to see money: nothing to share
  const phone =
    typeof settings.data?.['report.owner_phone'] === 'string'
      ? settings.data['report.owner_phone']
      : '';
  const text = summary.data?.text ?? '';
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the text is on screen to copy by hand */
    }
  };
  return (
    <div className="space-y-3">
      <pre
        dir="auto"
        className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-300 bg-slate-50 p-3 font-sans text-sm leading-relaxed"
      >
        {summary.isPending ? t('common.loading') : text}
      </pre>
      <div className="flex flex-wrap gap-2">
        <a
          className={`btn-primary flex-1 ${text ? '' : 'pointer-events-none opacity-50'}`}
          href={text ? whatsappLink(phone, text) : undefined}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="receipt" size={18} />
          {phone ? t('summary.sendOwner') : t('summary.send')}
        </a>
        <button className="btn-secondary" disabled={!text} onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'receipt'} size={18} />
          {copied ? t('summary.copied') : t('summary.copy')}
        </button>
      </div>
      {!phone && <p className="hint">{t('summary.noPhone')}</p>}
    </div>
  );
}
