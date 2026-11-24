import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { useApi } from '../../../api/ApiContext';
import type { User } from '../../../api/types';
import { useAuth, useUser } from '../../../auth/AuthContext';
import { ErrorText } from '../../../components/ErrorText';
import { Icon } from '../../../components/Icon';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';

const STEPS = ['apply', 'check', 'jobs'] as const;

/**
 * Become a pro (D92): the same account is used and the customer's bookings and plans stay (D64). "Start my pro
 * application" makes the account a pro's and opens the application in the pro app.
 */
export function BecomeProPage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const start = useAction();

  async function begin() {
    const result = await start.run(() => api.post<{ user: User }>('/account/become-pro'));
    if (result) {
      setUser(result.user);
      navigate('/pro');
    }
  }

  return (
    <>
      <AppHeader title={t('profile.becomePro')} back="/profile" />
      <div className="body">
        <div className="card center-text become-pro-hero">
          <span className="become-pro-icon" aria-hidden="true">
            <Icon name="wrench" />
          </span>
          <h2 className="become-pro-title">{t('becomePro.title')}</h2>
          <p className="small muted">{t('becomePro.text')}</p>
        </div>
        <h2 className="h-sm">{t('becomePro.how')}</h2>
        <div className="card">
          <ol className="tl" aria-label={t('becomePro.how')}>
            {STEPS.map((step, index) => (
              <li key={step} className={`tl-item ${index === 0 ? 'now' : ''}`}>
                <span className="tdot" aria-hidden="true" />
                <span className="tt">{t(`becomePro.steps.${step}.title`)}</span>
                <span className="small muted">{t(`becomePro.steps.${step}.text`)}</span>
              </li>
            ))}
          </ol>
        </div>
        <ErrorText error={start.error} />
        {user.role === 'pro' ? (
          <Link to="/pro" className="cta dark">
            {t('becomePro.open')} <Icon name="arrowR" />
          </Link>
        ) : (
          <button type="button" className="cta dark" disabled={start.busy} onClick={() => void begin()}>
            {t('becomePro.start')} <Icon name="arrowR" />
          </button>
        )}
      </div>
    </>
  );
}
