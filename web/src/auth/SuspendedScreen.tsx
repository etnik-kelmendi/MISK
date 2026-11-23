import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Suspension } from '../api/client';
import { Icon } from '../components/Icon';
import { useAuth } from './AuthContext';

/**
 * Shown instead of the app when the team suspended the account (D87): when signing in, and the moment a
 * signed-in app finds out. It says what the team chose to share and how to reach them. The reason the team
 * wrote for itself is never sent to the app.
 */
export function SuspendedScreen({ suspension }: { suspension: Suspension }) {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const heading = useRef<HTMLHeadingElement>(null);
  const { email, phone } = suspension.support;

  // A whole new page: move focus to its heading so screen readers start there.
  useEffect(() => heading.current?.focus(), []);

  return (
    <div className="app-frame">
      <main className="body suspended" aria-labelledby="suspended-title">
        <div className="card stack">
          <span className="suspended-icon" aria-hidden="true">
            <Icon name="lock" />
          </span>
          <h1 id="suspended-title" ref={heading} tabIndex={-1}>
            {t('suspended.title')}
          </h1>
          <p>{t('suspended.text')}</p>
          {suspension.message && (
            <div className="note">
              <p className="b small">{t('suspended.messageTitle')}</p>
              <p className="pre-line">{suspension.message}</p>
            </div>
          )}
          <section className="stack" aria-labelledby="suspended-contact">
            <h2 id="suspended-contact" className="h-sm">
              {t('suspended.contactTitle')}
            </h2>
            {email || phone ? (
              <ul className="stack suspended-contact">
                {email && (
                  <ContactLine icon={<Icon name="chat" />}>
                    <a href={`mailto:${email}`}>{email}</a>
                  </ContactLine>
                )}
                {phone && (
                  <ContactLine icon={<Icon name="phone" />}>
                    <a href={`tel:${phone}`}>{phone}</a>
                  </ContactLine>
                )}
              </ul>
            ) : (
              <p className="small">{t('suspended.contactNone')}</p>
            )}
          </section>
          <p className="small muted">{t('suspended.later')}</p>
          <button type="button" className="btn btn-ghost wide" onClick={() => void logout()}>
            <Icon name="logout" /> {t('suspended.signOut')}
          </button>
        </div>
      </main>
    </div>
  );
}

function ContactLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="row gap8">
      <span aria-hidden="true">{icon}</span>
      {children}
    </li>
  );
}

/** Shows the suspended screen in place of the app while the account is suspended. */
export function SuspendedGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  return state.status === 'suspended' ? <SuspendedScreen suspension={state.suspension} /> : <>{children}</>;
}
