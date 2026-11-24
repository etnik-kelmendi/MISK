import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Icon } from '../../../components/Icon';
import { AppHeader } from '../../../shells/Shells';
import { useAccountSettings } from './PersonalPage';

/** The common questions, in order; each has a question and an answer in the translations. */
export const FAQ = ['charged', 'cancel', 'unhappy', 'pause'] as const;

/** A support email with the subject filled in, so the team sees at once what it is about. */
export function supportMailto(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

/**
 * Help & support (D92): common questions that open their answer, and the ways to reach the team that are set up
 * (SUPPORT_EMAIL for "Chat with us", which opens an email, and SUPPORT_PHONE for "Call").
 */
export function HelpPage() {
  const { t } = useTranslation();
  const settings = useAccountSettings();
  const [open, setOpen] = useState<string | null>(null);
  const support = settings.state.status === 'ready' ? settings.state.data.support : null;

  return (
    <>
      <AppHeader title={t('profile.help')} back="/profile" />
      <div className="body">
        <ul className="lgroup plist faq" aria-label={t('help.questions')}>
          {FAQ.map((key) => {
            const expanded = open === key;
            return (
              <li key={key}>
                <button
                  type="button"
                  className="lrow"
                  aria-expanded={expanded}
                  aria-controls={`faq-${key}`}
                  onClick={() => setOpen(expanded ? null : key)}
                >
                  <span className="grow">{t(`help.faq.${key}.q`)}</span>
                  <span className="lv">
                    <Icon name={expanded ? 'chevD' : 'chevR'} />
                  </span>
                </button>
                <p id={`faq-${key}`} className="small muted faq-answer" hidden={!expanded}>
                  {t(`help.faq.${key}.a`)}
                </p>
              </li>
            );
          })}
        </ul>
        {settings.state.status === 'loading' ? null : support?.email || support?.phone ? (
          <div className="row gap8 help-contact">
            {support.email && (
              <a className="cta grow" href={supportMailto(support.email, t('help.mailSubject'))}>
                <Icon name="chat" /> {t('help.chat')}
              </a>
            )}
            {support.phone && (
              <a className="cta ghost grow" href={`tel:${support.phone}`}>
                <Icon name="phone" /> {t('help.call')}
              </a>
            )}
          </div>
        ) : (
          <p className="small muted">{t('help.noContact')}</p>
        )}
        {support?.email && <p className="tiny muted">{t('help.chatNote')}</p>}
        <Link to="/bookings" className="cta ghost help-bookings">
          {t('help.bookingProblem')}
        </Link>
      </div>
    </>
  );
}
