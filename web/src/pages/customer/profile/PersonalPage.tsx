import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import type { User } from '../../../api/types';
import { useResource } from '../../../api/useResource';
import { useAuth, useUser } from '../../../auth/AuthContext';
import { ErrorText } from '../../../components/ErrorText';
import { FieldError } from '../../../components/FieldError';
import { Icon } from '../../../components/Icon';
import { LANGUAGE, LANGUAGES } from '../../../i18n';
import { useAction } from '../../../lib/useAction';
import { useValidation } from '../../../lib/useValidation';
import { AppHeader } from '../../../shells/Shells';
import { AccountEmail } from '../../AccountEmail';
import { AccountPhone } from '../../AccountPhone';

/** The API's limit for a first or last name. */
export const MAX_NAME_LENGTH = 60;

/** The languages the app has texts for (one translation file each, D110). The API keeps the same list. */
export const APP_LANGUAGES = LANGUAGES;

/** What `GET /account/settings` answers (D92). */
export interface AccountSettings {
  language: string;
  languages: string[];
  support: { email: string | null; phone: string | null };
}

/** The account's language and the support contact, for Personal information and Help & support. */
export function useAccountSettings() {
  const api = useApi();
  const load = useCallback(() => api.get<AccountSettings>('/account/settings'), [api]);
  return useResource(load);
}

/**
 * Personal information (D92): first and last name, the phone number (changed with a texted code, D87), the
 * email address (changed with a link to the new address, D97) and the language, saved with "Save changes".
 * The pro app shows the same page under its Profile (D100), with the pro's photo on top and its own privacy note,
 * since what customers see of a pro is not what pros see of a customer (D105).
 */
export function PersonalPage({
  back = '/profile',
  top,
  privacy,
  showLanguage = true,
}: {
  back?: string;
  top?: ReactNode;
  privacy?: string;
  /** False in the pro app, where Language is a Profile row of its own (D110). */
  showLanguage?: boolean;
} = {}) {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const { setUser } = useAuth();
  const settings = useAccountSettings();
  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [lastName, setLastName] = useState(user.lastName ?? '');
  const [chosenLanguage, setLanguage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const form = useValidation({ firstName: !firstName.trim() && t('validation.firstNameMissing') }, { firstName: 'personal-first-name' });

  const loaded = settings.state.status === 'ready' ? settings.state.data : null;
  // Only languages both the app and the API have; the saved one starts selected.
  const languages = APP_LANGUAGES.filter((code) => !loaded || loaded.languages.includes(code));
  const savedLanguage = loaded && (APP_LANGUAGES as readonly string[]).includes(loaded.language) ? loaded.language : LANGUAGE;
  const language = chosenLanguage ?? savedLanguage;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setSaved(false);
    if (!form.check()) return;
    const result = await save.run(() =>
      api.patch<{ user: User; language: string }>('/account/personal', {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        ...(showLanguage ? { language } : {}),
      }),
    );
    if (result) {
      setUser(result.user);
      setSaved(true);
    }
  }

  return (
    <>
      <AppHeader title={t('profile.personal')} back={back} />
      <div className="body">
        {top}
        <form id="personal-form" className="card stack" onSubmit={submit} noValidate aria-label={t('personal.nameTitle')}>
          <div className="field">
            <label htmlFor="personal-first-name">{t('personal.firstName')}</label>
            <input
              id="personal-first-name"
              required
              maxLength={MAX_NAME_LENGTH}
              autoComplete="given-name"
              value={firstName}
              {...form.describe('firstName')}
              onChange={(event) => setFirstName(event.target.value)}
            />
            <FieldError id="personal-first-name" message={form.message('firstName')} />
          </div>
          <div className="field">
            <label htmlFor="personal-last-name">
              {t('personal.lastName')} <span className="h-note">{t('rating.optional')}</span>
            </label>
            <input
              id="personal-last-name"
              maxLength={MAX_NAME_LENGTH}
              autoComplete="family-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </div>
        </form>

        <AccountPhone />
        <AccountEmail />

        {showLanguage && (
          <div className="card stack">
            <div className="field">
              <label htmlFor="personal-language">{t('personal.language')}</label>
              <select
                id="personal-language"
                form="personal-form"
                aria-describedby="personal-language-note"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                {languages.map((code) => (
                  <option key={code} value={code}>
                    {t(`personal.languages.${code}`)}
                  </option>
                ))}
              </select>
              <span id="personal-language-note" className="hint">
                {t('personal.languageNote')}
              </span>
            </div>
          </div>
        )}

        <div className="info">
          <Icon name="shield" />
          <p>{privacy ?? t('personal.privacy')}</p>
        </div>
        <ErrorText error={save.error} />
        {saved && (
          <p className="small brand-text" role="status">
            {t('personal.saved')}
          </p>
        )}
        <button className="cta" type="button" disabled={save.busy} onClick={() => void submit()}>
          {t('personal.save')}
        </button>
      </div>
    </>
  );
}
