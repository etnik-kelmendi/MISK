import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Icon } from '../components/Icon';
import { readable, useInbox } from './InboxContext';

/**
 * Announces a message that just arrived, such as a job the team gave the pro or a cancelled job, at the
 * top of every screen until it is opened or closed. Hidden on the Messages page, which shows it anyway.
 */
export function NewMessageBanner({ messagesPath }: { messagesPath: string }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { fresh, dismissFresh } = useInbox();
  const newest = fresh[0];
  if (!newest || pathname === messagesPath) {
    return null;
  }
  return (
    <div className="new-message" role="status" aria-live="polite">
      <Icon name="bell" />
      <div className="grow">
        <p className="b small">{t('inbox.newTitle')}</p>
        <p className="small">{readable(newest.body)}</p>
        {fresh.length > 1 && <p className="tiny muted">{t('inbox.more', { count: fresh.length - 1 })}</p>}
        <Link to={messagesPath} className="small b">
          {t('inbox.open')}
        </Link>
      </div>
      <button type="button" className="iconbtn" aria-label={t('inbox.dismiss')} onClick={dismissFresh}>
        <Icon name="x" />
      </button>
    </div>
  );
}
