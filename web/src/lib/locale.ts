import i18n from '../i18n';

/** The locale for dates, weekday and month names and money in each app language (D110). */
const DISPLAY_LOCALES: Record<string, string> = { en: 'en-GB', de: 'de-DE', sq: 'sq-AL' };

/**
 * The locale to show dates and amounts in, following the language the app is shown in. Only for text people
 * read: code that reads numbers back out of a formatted date keeps a fixed locale.
 */
export function displayLocale(): string {
  return DISPLAY_LOCALES[i18n.language] ?? 'en-GB';
}
