import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import type { User } from '../../../api/types';
import { useAuth, useUser } from '../../../auth/AuthContext';
import { ErrorText } from '../../../components/ErrorText';
import { Icon } from '../../../components/Icon';
import { isAppLanguage, LANGUAGE, LANGUAGES } from '../../../i18n';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';
import { useAccountSettings } from '../../customer/profile/PersonalPage';
import { PRO_PROFILE_PATHS } from './types';

/**
 * Language (D110), a row of its own in the pro Profile's Work group: English, German or Albanian, each named in
 * itself so it can be found whatever language the app is in now. "Save changes" saves it to the account and the
 * app switches at once.
 */
export function LanguagePage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const { setUser } = useAuth();
  const settings = useAccountSettings();
  const current = isAppLanguage(user.language) ? user.language : LANGUAGE;
  const [chosen, setChosen] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const language = chosen ?? current;
  // Only languages both the app and the API have.
  const loaded = settings.state.status === 'ready' ? settings.state.data : null;
  const languages = LANGUAGES.filter((code) => !loaded || loaded.languages.includes(code));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const result = await save.run(() => api.patch<{ user: User; language: string }>('/account/language', { language }));
    if (result) {
      // The account now carries the language, and the app shows itself in it (AuthContext).
      setUser(result.user);
      setChosen(null);
      setSaved(true);
    }
  }

  return (
    <>
      <AppHeader title={t('proProfile.language')} back={PRO_PROFILE_PATHS.profile} />
      <form className="body" onSubmit={submit} noValidate>
        <fieldset className="lgroup plist" aria-describedby="language-note">
          <legend className="visually-hidden">{t('proProfile.language')}</legend>
          {languages.map((code) => (
            <label key={code} className={`lrow language-row ${language === code ? 'on' : ''}`}>
              <input
                type="radio"
                name="language"
                value={code}
                lang={code}
                checked={language === code}
                onChange={() => {
                  setChosen(code);
                  setSaved(false);
                }}
              />
              <span className="grow" lang={code}>
                {t(`language.names.${code}`)}
              </span>
              {language === code && <Icon name="check" className="brand-text" />}
            </label>
          ))}
        </fieldset>
        <p id="language-note" className="info">
          <Icon name="chat" />
          <span>{t('personal.languageNote')}</span>
        </p>
        <ErrorText error={save.error} />
        {saved && (
          <p className="small brand-text" role="status">
            {t('personal.saved')}
          </p>
        )}
        <button className="cta" type="submit" disabled={save.busy || language === current}>
          {t('personal.save')}
        </button>
      </form>
    </>
  );
}
