import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { appOrigin } from '../../lib/tenant';

/**
 * Websites are not allowed to see which printers a computer has, or to print without asking. The one
 * reliable way to print a receipt with no dialog is to open the browser in "auto-print" mode, which sends
 * every print to the computer's default printer. This gives the person who sets up the counter computer a
 * small file that does exactly that, once, so the cashier only ever opens the app from that shortcut.
 */
export function PrintHelp() {
  const { t } = useTranslation();

  function download(browser: 'msedge' | 'chrome'): void {
    // a plain batch file: open this restaurant in an app window with auto-print on
    const text = `@echo off\r\nstart "" ${browser} --kiosk-printing --app=${appOrigin()}/\r\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = browser === 'msedge' ? 'Open POS (Edge).bat' : 'Open POS (Chrome).bat';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3 text-sm">
      <p>{t('printHelp.intro')}</p>
      <ol className="list-decimal space-y-1 ps-5 text-slate-700">
        <li>{t('printHelp.step1')}</li>
        <li>{t('printHelp.step2')}</li>
        <li>{t('printHelp.step3')}</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => download('msedge')}>
          <Icon name="printer" size={18} />
          {t('printHelp.edge')}
        </button>
        <button className="btn-secondary" onClick={() => download('chrome')}>
          {t('printHelp.chrome')}
        </button>
      </div>
      <p className="hint">{t('printHelp.paper')}</p>
    </div>
  );
}
