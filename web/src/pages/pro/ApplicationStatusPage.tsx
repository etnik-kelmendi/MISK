import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { ApplicationView, ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { longDate } from '../../lib/format';
import { DocumentItem, requiredDocuments } from './ApplicationForm';

type Outcome = 'review' | 'info' | 'approved' | 'rejected' | 'suspended' | 'draft';

function outcomeOf(profile: ProProfile): Outcome {
  switch (profile.status) {
    case 'info_requested':
      return 'info';
    case 'approved':
    case 'pending_approval':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'suspended':
      return 'suspended';
    case 'draft':
      return 'draft';
    default:
      return 'review';
  }
}

const CARD_ICON: Record<Exclude<Outcome, 'draft'>, 'clock' | 'bell' | 'check' | 'x' | 'lock'> = {
  review: 'clock',
  info: 'bell',
  approved: 'check',
  rejected: 'x',
  suspended: 'lock',
};

/**
 * "Contact support" by email or phone, from the server's SUPPORT_EMAIL and SUPPORT_PHONE (D87). The button is
 * always there; with neither set, it shows how to reach the team instead of linking nowhere.
 */
function ContactSupport({ support }: { support: ApplicationView['support'] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const href = support.email ? `mailto:${support.email}` : support.phone ? `tel:${support.phone}` : null;
  if (!href) {
    return (
      <>
        <button type="button" className="mini-btn" aria-expanded={open} aria-controls={open ? noteId : undefined} onClick={() => setOpen((v) => !v)}>
          <Icon name="chat" /> {t('application.contactSupport')}
        </button>
        {open && (
          <p id={noteId} className="small muted" role="status">
            {t('application.contactNone')}
          </p>
        )}
      </>
    );
  }
  return (
    <a className="mini-btn" href={href}>
      <Icon name="chat" /> {t('application.contactSupport')}
    </a>
  );
}

/** The card at the top: where the application stands, in words, and what the pro can do now. */
function StatusCard({ view, onChange }: { view: ApplicationView; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const { profile, support } = view;
  const outcome = outcomeOf(profile);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [outcome]);
  if (outcome === 'draft') {
    return (
      <section className="card center stack" aria-labelledby="status-title">
        <h2 id="status-title" className="b" ref={heading} tabIndex={-1}>
          {t('application.notSent')}
        </h2>
        <Link to="/pro/apply" className="cta dark">
          {t('application.toForm')}
        </Link>
      </section>
    );
  }
  const requested = profile.requestedDocuments ?? [];
  return (
    // The state class is prefixed: a bare "info" would pick up the app's side-by-side .info hint style.
    <section className={`card center stack status-card is-${outcome}`} aria-labelledby="status-title">
      <span className="status-icon" aria-hidden="true">
        <Icon name={CARD_ICON[outcome]} />
      </span>
      <h2 id="status-title" className="b big" ref={heading} tabIndex={-1}>
        {t(`application.card.${outcome}`)}
      </h2>
      {outcome === 'review' && <p className="muted small">{t('application.card.reviewText')}</p>}
      {outcome === 'approved' && (
        <>
          <p className="muted small">{t('application.card.approvedText')}</p>
          <Link to="/pro" className="cta dark">
            {t('application.goToJobs')} <Icon name="arrowR" />
          </Link>
        </>
      )}
      {outcome === 'info' && (
        <>
          {profile.reviewNote && (
            <blockquote className="team-words">
              <p className="tiny muted">{t('application.fromTeam')}</p>
              <p className="pre-line">{profile.reviewNote}</p>
            </blockquote>
          )}
          <p className="muted small">{requested.length ? t('application.card.infoUpload') : t('application.card.infoEdit')}</p>
          {requested.length > 0 ? (
            <div className="stack text-start">
              {requested.map((kind) => (
                <DocumentItem
                  key={kind}
                  profile={profile}
                  kind={kind}
                  onChange={onChange}
                  label={t('application.upload', { document: t(`apply.doc.${kind}`) })}
                />
              ))}
            </div>
          ) : (
            <Link to="/pro/apply" className="mini-btn green">
              {t('application.changeApplication')}
            </Link>
          )}
        </>
      )}
      {outcome === 'rejected' && (
        <>
          {profile.reviewNote && (
            <div className="team-words">
              <p className="tiny muted">{t('application.reason')}</p>
              <p className="pre-line">{profile.reviewNote}</p>
            </div>
          )}
          <ContactSupport support={support} />
          {profile.editable ? (
            <>
              <p className="small">{t('application.applyAgainNow')}</p>
              <Link to="/pro/apply" className="cta dark">
                {t('application.applyAgain')}
              </Link>
            </>
          ) : (
            <p className="small">
              {t('application.applyAgainIn')}
              {profile.reapplyOn && <> · {t('application.applyAgainFrom', { date: longDate(profile.reapplyOn, timezone) })}</>}
            </p>
          )}
        </>
      )}
      {outcome === 'suspended' && <ContactSupport support={support} />}
    </section>
  );
}

function Timeline({ view }: { view: ApplicationView }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const { timeline, profile } = view;
  if (!timeline) {
    return null;
  }
  return (
    <section className="card" aria-labelledby="steps-heading">
      <h2 id="steps-heading" className="visually-hidden">
        {t('application.steps')}
      </h2>
      <ol className="tl">
        {timeline.steps.map((step) => {
          const current = step.key === timeline.current;
          const note =
            step.key === 'sent'
              ? profile.submittedAt
                ? t('application.stepNote.sent', { date: longDate(profile.submittedAt, timezone) })
                : ''
              : t(`application.stepNote.${step.key}.${step.state}`);
          return (
            <li
              key={step.key}
              className={`tl-item ${step.state === 'done' ? 'done' : current ? 'now' : ''} ${step.state}`}
              aria-current={current ? 'step' : undefined}
            >
              <span className="tdot" aria-hidden="true" />
              <span className="tt">
                {t(`application.step.${step.key}`)}
                <span className="visually-hidden"> ({t(`application.stepState.${step.state}`)})</span>
              </span>
              <span className="small muted">{note}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Summary({ profile }: { profile: ProProfile }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const required = requiredDocuments(profile);
  const uploaded = required.filter((kind) => profile.documents[kind] != null).length;
  return (
    <section className="card" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="h-sm">
        {t('application.summary')}
      </h2>
      <dl className="kv">
        <dt>{t('application.trades')}</dt>
        <dd className="b">{(profile.tradeNames ?? []).join(', ') || '–'}</dd>
        <dt>{t('application.home')}</dt>
        <dd className="b">{[profile.homeAddress, profile.homePostcode].filter(Boolean).join(', ') || '–'}</dd>
        <dt>{t('application.travel')}</dt>
        <dd className="b">{t('application.travelValue', { km: profile.radiusKm })}</dd>
        <dt>{t('application.days')}</dt>
        <dd className="b">{profile.workingDays.map((day) => t(`weekday.${day}` as 'weekday.1')).join(', ') || '–'}</dd>
        <dt>{t('application.documents')}</dt>
        <dd className="b">{t('application.documentsValue', { count: uploaded, total: required.length })}</dd>
        <dt>{t('application.background')}</dt>
        <dd className="b">
          {profile.backgroundConsentAt
            ? t('application.consentGiven', { date: longDate(profile.backgroundConsentAt, timezone) })
            : t('application.consentMissing')}
        </dd>
      </dl>
    </section>
  );
}

/**
 * The Application status page (D93): a card with where the application stands, the four steps, and what
 * the pro sent. Every change of status also reaches the pro as a message that links here.
 */
export function ApplicationStatusPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<ApplicationView>('/pro/application'), [api]);
  const { state, reload, update } = useResource(load);
  // After an upload the review may carry on: fetch the steps again.
  const onChange = useCallback(
    (profile: ProProfile) => {
      update((current) => ({ ...current, profile }));
      reload();
    },
    [update, reload],
  );
  return (
    <>
      <header className="prohead">
        <h1>{t('application.title')}</h1>
      </header>
      <div className="body stack">
        <ResourceState state={state} reload={reload}>
          {(view) => (
            <>
              <StatusCard view={view} onChange={onChange} />
              <Timeline view={view} />
              {view.profile.status !== 'draft' && <Summary profile={view.profile} />}
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
