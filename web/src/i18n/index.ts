import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/** The language the app starts in, and falls back to for any text a translation lacks. */
export const LANGUAGE = 'en';
/** The languages the app has texts for, one translation file each (D92, D110). The API keeps the same list. */
export const LANGUAGES = ['en', 'de', 'sq'] as const;
export type AppLanguage = (typeof LANGUAGES)[number];

export const isAppLanguage = (code: unknown): code is AppLanguage =>
  typeof code === 'string' && (LANGUAGES as readonly string[]).includes(code);

/**
 * German and Albanian are loaded only when someone picks them, so English users never download them. Each is a
 * separate file the build splits off.
 */
const LOADERS: Record<Exclude<AppLanguage, typeof LANGUAGE>, () => Promise<{ default: Record<string, unknown> }>> = {
  de: () => import('./locales/de.json'),
  sq: () => import('./locales/sq.json'),
};

/** This device remembers the last language, so the sign-in pages and a reload start in it (D110). */
const STORED_KEY = 'misk-language';

function storedLanguage(): AppLanguage | null {
  try {
    const stored = window.localStorage.getItem(STORED_KEY);
    return isAppLanguage(stored) ? stored : null;
  } catch {
    // Storage can be blocked (private window); the account's language still applies after sign-in.
    return null;
  }
}

function remember(code: AppLanguage) {
  try {
    window.localStorage.setItem(STORED_KEY, code);
  } catch {
    // See storedLanguage.
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: LANGUAGE,
  fallbackLng: LANGUAGE,
  supportedLngs: [...LANGUAGES],
  interpolation: { escapeValue: false },
  initAsync: false,
});

function applyToDocument() {
  document.documentElement.lang = i18n.language;
  document.title = import.meta.env.MODE === 'admin' ? i18n.t('admin.title') : i18n.t('app.title');
}
applyToDocument();

/**
 * Shows the app in `code` (the account's language, D110), loading its texts first; an unknown or missing code
 * means English. Every text updates in place, without a reload.
 */
export async function setAppLanguage(code: string | null | undefined): Promise<void> {
  const next = isAppLanguage(code) ? code : LANGUAGE;
  remember(next);
  if (i18n.language === next) return;
  if (next !== LANGUAGE && !i18n.hasResourceBundle(next, 'translation')) {
    try {
      const texts = await LOADERS[next]();
      i18n.addResourceBundle(next, 'translation', texts.default);
    } catch (error) {
      // Offline or a failed download: stay in the current language rather than show half-translated pages.
      console.error('Could not load the texts for', next, error);
      return;
    }
  }
  await i18n.changeLanguage(next);
  applyToDocument();
}

// A language chosen earlier on this device applies straight away, before the account has loaded.
const remembered = storedLanguage();
if (remembered && remembered !== LANGUAGE) void setAppLanguage(remembered);

export default i18n;
