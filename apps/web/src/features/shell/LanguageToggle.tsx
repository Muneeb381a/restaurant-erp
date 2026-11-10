import { useTranslation } from 'react-i18next';
import { setLanguage, type Lang } from '../../i18n';

export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const next: Lang = i18n.language === 'ur' ? 'en' : 'ur';
  return (
    <button type="button" className="btn-secondary" onClick={() => setLanguage(next)}>
      {t('common.language')}
    </button>
  );
}
