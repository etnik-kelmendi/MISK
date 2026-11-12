import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMarket } from '../api/MarketContext';
import { Icon, type IconKey } from '../components/Icon';
import { useInbox } from '../inbox/InboxContext';
import { dateTime } from '../lib/format';
import { AppHeader } from '../shells/Shells';

const ICON_OF: Partial<Record<string, IconKey>> = {
  job_offer: 'bolt',
  booking_cancelled: 'x',
  booking_rescheduled: 'calendar',
  booking_confirmed: 'check',
  job_completed: 'check',
  payout_sent: 'euro',
  pro_on_the_way: 'pin',
  rating_request: 'star',
};

/** The text without the "MISK:" that starts every text message, beginning with a capital letter. */
function readable(body: string): string {
  const text = body.replace(/^MISK:\s*/, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Every message MISK sent the person, also when no text message or push reached them. */
export function MessagesPage() {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const { inbox, failed, reload, markRead } = useInbox();
  // Messages that were new when the page opened stay marked as new while it is open.
  const [fresh, setFresh] = useState<Set<string> | null>(null);
  const marking = useRef(false);

  if (inbox && fresh === null) {
    setFresh(new Set(inbox.messages.filter((m) => !m.read).map((m) => m.id)));
  }

  // Opening the page counts as reading what is there.
  useEffect(() => {
    if (inbox && inbox.unread > 0 && !marking.current) {
      marking.current = true;
      markRead()
        .catch((error: unknown) => console.warn('Could not mark messages as read', error))
        .finally(() => {
          marking.current = false;
        });
    }
  }, [inbox, markRead]);

  return (
    <>
      <AppHeader title={t('inbox.title')} />
      <div className="body">
        {!inbox ? (
          failed ? (
            <div className="card center stack">
              <p role="alert">{t('inbox.failed')}</p>
              <button type="button" className="btn btn-ghost" onClick={reload}>
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <p className="muted center pad" role="status">
              {t('common.loading')}
            </p>
          )
        ) : inbox.messages.length === 0 ? (
          <p className="card center muted">{t('inbox.empty')}</p>
        ) : (
          <ul className="stack" aria-label={t('inbox.title')}>
            {inbox.messages.map((message) => {
              const isNew = fresh?.has(message.id) ?? !message.read;
              return (
                <li key={message.id} className={`card row gap8 msg ${isNew ? 'new' : ''}`}>
                  <span className="ci" aria-hidden="true">
                    <Icon name={ICON_OF[message.kind] ?? 'chat'} />
                  </span>
                  <span className="grow">
                    <span className="block">{readable(message.body)}</span>
                    <span className="tiny muted">
                      {dateTime(message.createdAt, timezone)}
                      {isNew && <span className="badge g msg-new">{t('inbox.new')}</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
