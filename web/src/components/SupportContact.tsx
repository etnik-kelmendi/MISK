import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

/** A support email with the subject filled in, so the team sees at once what it is about. */
export function supportMailto(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

/**
 * "Chat with us" and "Call", always both shown (D92, D100): an email to SUPPORT_EMAIL and a call to SUPPORT_PHONE
 * when they are set up; a button whose contact is not set up explains how to reach the team instead.
 */
export function SupportContact({
  support,
  mailSubject,
  chatClassName = 'cta grow',
}: {
  support: { email: string | null; phone: string | null } | null;
  mailSubject: string;
  /** The pro app shows "Chat with us" in its dark colour. */
  chatClassName?: string;
}) {
  const { t } = useTranslation();
  const [missing, setMissing] = useState<'chat' | 'call' | null>(null);
  return (
    <>
      <div className="row gap8 help-contact">
        {support?.email ? (
          <a className={chatClassName} href={supportMailto(support.email, mailSubject)}>
            <Icon name="chat" /> {t('help.chat')}
          </a>
        ) : (
          <button
            type="button"
            className={chatClassName}
            aria-expanded={missing === 'chat'}
            aria-controls={missing === 'chat' ? 'help-no-contact' : undefined}
            onClick={() => setMissing(missing === 'chat' ? null : 'chat')}
          >
            <Icon name="chat" /> {t('help.chat')}
          </button>
        )}
        {support?.phone ? (
          <a className="cta ghost grow" href={`tel:${support.phone}`}>
            <Icon name="phone" /> {t('help.call')}
          </a>
        ) : (
          <button
            type="button"
            className="cta ghost grow"
            aria-expanded={missing === 'call'}
            aria-controls={missing === 'call' ? 'help-no-contact' : undefined}
            onClick={() => setMissing(missing === 'call' ? null : 'call')}
          >
            <Icon name="phone" /> {t('help.call')}
          </button>
        )}
      </div>
      {missing && (
        <p id="help-no-contact" className="small muted" role="status">
          {t('help.noContact')}
        </p>
      )}
      {support?.email && <p className="tiny muted">{t('help.chatNote')}</p>}
    </>
  );
}
