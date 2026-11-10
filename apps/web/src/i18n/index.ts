import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ur from './ur.json';

export type Lang = 'en' | 'ur';
const KEY = 'erp-lang';

export function directionOf(lang: Lang): 'ltr' | 'rtl' {
  return lang === 'ur' ? 'rtl' : 'ltr';
}

/** Keeps <html lang/dir> in step with the language so Tailwind logical classes flip for Urdu. */
export function applyLanguage(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = directionOf(lang);
}

function stored(): Lang {
  try {
    return localStorage.getItem(KEY) === 'ur' ? 'ur' : 'en';
  } catch {
    return 'en';
  }
}

export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* private mode */
  }
  void i18n.changeLanguage(lang);
  applyLanguage(lang);
}

export function initI18n(initial: Lang = stored()): typeof i18n {
  void i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, ur: { translation: ur } },
    lng: initial,
    fallbackLng: 'en',
    interpolation: { escapeValue: false }, // React already escapes
  });
  applyLanguage(initial);
  return i18n;
}

/** Pick the Urdu name when the UI is Urdu and one exists. */
export function localName(lang: string, name: string, nameUr: string | null | undefined): string {
  return lang === 'ur' && nameUr ? nameUr : name;
}
