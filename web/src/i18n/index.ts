import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

// English first. Every label comes from en.json, so more languages (Phase 4) need no component changes.
export const LANGUAGE = 'en';

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: LANGUAGE,
  fallbackLng: LANGUAGE,
  supportedLngs: [LANGUAGE],
  interpolation: { escapeValue: false },
  initAsync: false,
});

document.documentElement.lang = LANGUAGE;
document.title = i18n.t('app.title');

export default i18n;
