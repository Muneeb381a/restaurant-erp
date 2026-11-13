import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/Modal';

/** Which help text belongs to the screen the person is on. */
export function helpKeyFor(pathname: string): string {
  if (pathname.startsWith('/dashboard')) return 'dashboard';
  if (pathname.startsWith('/kitchen')) return 'kitchen';
  if (pathname.startsWith('/bills')) return 'bills';
  if (pathname.startsWith('/khata')) return 'khata';
  if (pathname.startsWith('/admin')) return 'admin';
  if (/^\/order\/[^/]+\/pay/.test(pathname)) return 'pay';
  if (pathname.startsWith('/order')) return 'order';
  return 'tables';
}

/** "How this screen works": what it is for, the usual steps and a few tips, in plain words. */
export function HelpDialog({ page, onClose }: { page: string; onClose: () => void }) {
  const { t } = useTranslation();
  const list = (k: string): string[] => {
    const v = t(`help.${page}.${k}`, { returnObjects: true });
    return Array.isArray(v) ? (v as string[]) : [];
  };
  const steps = list('steps');
  const tips = list('tips');
  return (
    <Modal title={t(`help.${page}.title`)} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-base text-slate-800">{t(`help.${page}.what`)}</p>
        {steps.length > 0 && (
          <div className="space-y-2">
            <h3 className="micro">{t('help.steps')}</h3>
            <ol className="space-y-2">
              {steps.map((s, i) => (
                <li key={s} className="flex gap-3">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                    {i + 1}
                  </span>
                  <span className="pt-0.5">{s}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {tips.length > 0 && (
          <div className="space-y-2 rounded-xl bg-slate-100 p-3">
            <h3 className="micro">{t('help.tips')}</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm text-slate-800">
              {tips.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        <button className="btn-primary w-full" onClick={onClose}>
          {t('help.gotIt')}
        </button>
      </div>
    </Modal>
  );
}
