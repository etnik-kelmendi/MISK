import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAppConfig } from '../../../api/ApiContext';
import { Icon, type IconKey } from '../../../components/Icon';
import { Sheet } from '../../../components/Sheet';
import { AppHeader } from '../../../shells/Shells';

/** Where the answer of the cookie notice is kept in this browser. */
export const COOKIE_CHOICE_KEY = 'misk.cookieChoice';

interface CookieChoice {
  necessary: true;
  /** When the person confirmed it, as an ISO date. */
  at: string;
}

function readChoice(): CookieChoice | null {
  try {
    const raw = window.localStorage.getItem(COOKIE_CHOICE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CookieChoice>) : null;
    return parsed?.necessary === true && typeof parsed.at === 'string' ? { necessary: true, at: parsed.at } : null;
  } catch {
    // Storage can be blocked (private mode) or hold something else: then nothing is remembered.
    return null;
  }
}

function saveChoice(choice: CookieChoice): void {
  try {
    window.localStorage.setItem(COOKIE_CHOICE_KEY, JSON.stringify(choice));
  } catch (error) {
    console.warn('Could not remember the cookie choice', error);
  }
}

/**
 * Cookie settings: MISK only keeps what the app needs to work (the sign-in cookie and settings of this device),
 * with no advertising or tracking, so there is nothing optional to switch on or off. The person's OK is kept.
 */
function CookieSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<CookieChoice | null>(readChoice);
  return (
    <Sheet
      title={t('legal.cookiesTitle')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="cta"
          onClick={() => {
            const next: CookieChoice = { necessary: true, at: new Date().toISOString() };
            saveChoice(next);
            setChoice(next);
            onClose();
          }}
        >
          {t('legal.cookiesOk')}
        </button>
      }
    >
      <div className="stack">
        <p className="small">{t('legal.cookiesText')}</p>
        <div className="lgroup">
          <div className="lrow">
            <span className="grow">
              <span id="cookies-necessary" className="block">
                {t('legal.necessary')}
              </span>
              <span id="cookies-necessary-text" className="tiny muted block topic-text">
                {t('legal.necessaryText')}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked="true"
              aria-labelledby="cookies-necessary"
              aria-describedby="cookies-necessary-text"
              className="toggle on"
              disabled
            />
          </div>
        </div>
        <p className="tiny muted">{t('legal.noTracking')}</p>
        {choice && <p className="tiny muted">{t('legal.cookiesSaved')}</p>}
      </div>
    </Sheet>
  );
}

function LegalRow({ icon, label, children }: { icon: IconKey; label: string; children: (inner: ReactNode) => ReactNode }) {
  const inner = (
    <>
      <span className="li" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="grow">{label}</span>
      <span className="lv">
        <Icon name="chevR" />
      </span>
    </>
  );
  return <li>{children(inner)}</li>;
}

/**
 * Terms & privacy (D92): Terms of Service and Subscription terms (the plans section of the same terms) in the app,
 * the Privacy Policy where the owner published it (VITE_PRIVACY_URL), and Cookie settings.
 */
export function TermsPrivacyPage() {
  const { t } = useTranslation();
  const config = useAppConfig();
  const [cookies, setCookies] = useState(false);
  return (
    <>
      <AppHeader title={t('profile.legal')} back="/profile" />
      <div className="body">
        <ul className="lgroup plist" aria-label={t('profile.legal')}>
          <LegalRow icon="file" label={t('legal.terms')}>
            {(inner) => (
              <Link to="/terms" className="lrow">
                {inner}
              </Link>
            )}
          </LegalRow>
          <LegalRow icon="lock" label={t('legal.privacy')}>
            {(inner) =>
              config.privacyUrl ? (
                <a href={config.privacyUrl} target="_blank" rel="noreferrer" className="lrow">
                  {inner}
                </a>
              ) : (
                <span className="lrow muted-row">
                  <span className="li" aria-hidden="true">
                    <Icon name="lock" />
                  </span>
                  <span className="grow">{t('legal.privacy')}</span>
                  <span className="lv">{t('legal.notPublished')}</span>
                </span>
              )
            }
          </LegalRow>
          <LegalRow icon="repeat" label={t('legal.subscription')}>
            {(inner) => (
              <Link to="/terms#terms-plans" className="lrow">
                {inner}
              </Link>
            )}
          </LegalRow>
          <LegalRow icon="sliders" label={t('legal.cookies')}>
            {(inner) => (
              <button type="button" className="lrow" aria-haspopup="dialog" onClick={() => setCookies(true)}>
                {inner}
              </button>
            )}
          </LegalRow>
        </ul>
        <p className="tiny muted">{t('terms.updated')}</p>
        {cookies && <CookieSheet onClose={() => setCookies(false)} />}
      </div>
    </>
  );
}
