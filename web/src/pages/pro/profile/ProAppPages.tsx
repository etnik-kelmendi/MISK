import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi, useAppConfig } from '../../../api/ApiContext';
import { useResource } from '../../../api/useResource';
import { DataExportRow } from '../../../components/DataExport';
import { ErrorText } from '../../../components/ErrorText';
import { Icon, type IconKey } from '../../../components/Icon';
import { PushToggle } from '../../../components/PushToggle';
import { ResourceState } from '../../../components/ResourceState';
import { SupportContact } from '../../../components/SupportContact';
import { euro } from '../../../lib/format';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';
import { PRO_PROFILE_PATHS, type PayoutInterval } from './types';

/** The pro's switches, in the order shown (D100); the API keeps the same topics. */
export const PRO_TOPICS = ['job_offers', 'offer_sound', 'schedule_changes', 'payouts', 'tips_news'] as const;
export type ProTopic = (typeof PRO_TOPICS)[number];
export type ProTopicSettings = Record<ProTopic, boolean>;

/**
 * Notifications in the pro app (D100): on/off switches for new job offers, the offer sound, schedule changes, payouts
 * and tips & news, each with a short explanation. A switched-off message still shows in Messages; payments, safety,
 * documents and the account always go out.
 */
export function ProNotificationsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ topics: ProTopicSettings }>('/pro/notifications'), [api]);
  const { state, reload } = useResource(load);
  const action = useAction();
  const [saved, setSaved] = useState<ProTopicSettings | null>(null);

  async function toggle(topic: ProTopic, on: boolean) {
    const result = await action.run(() => api.patch<{ topics: ProTopicSettings }>('/pro/notifications', { [topic]: on }));
    if (result) setSaved(result.topics);
  }

  return (
    <>
      <AppHeader title={t('proProfile.notifications')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {(loaded) => {
            const topics = saved ?? loaded.topics;
            return (
              <ul className="lgroup plist" aria-label={t('proNotify.listLabel')}>
                {PRO_TOPICS.map((topic) => (
                  <li key={topic} className="lrow">
                    <span className="grow">
                      <span id={`pro-topic-${topic}`} className="block">
                        {t(`proNotify.topics.${topic}.title`)}
                      </span>
                      <span id={`pro-topic-${topic}-text`} className="tiny muted block topic-text">
                        {t(`proNotify.topics.${topic}.text`)}
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={topics[topic]}
                      aria-labelledby={`pro-topic-${topic}`}
                      aria-describedby={`pro-topic-${topic}-text`}
                      className={`toggle ${topics[topic] ? 'on' : ''}`}
                      disabled={action.busy}
                      onClick={() => void toggle(topic, !topics[topic])}
                    />
                  </li>
                ))}
              </ul>
            );
          }}
        </ResourceState>
        <ErrorText error={action.error} />
        <p className="tiny muted">{t('proNotify.always')}</p>
        <h2 className="h-sm">{t('proNotify.device')}</h2>
        <div className="card">
          <PushToggle />
        </div>
      </div>
    </>
  );
}

/** The pro's common questions, in order (the design's list); each has a question and an answer in the texts. */
export const PRO_FAQ = ['paid', 'notHome', 'cancel', 'moreJobs'] as const;

/** GET /pro/help: the numbers the answers quote, from Settings and the rules in force. */
export interface ProHelpFacts {
  payoutInterval: PayoutInterval;
  releaseHours: number;
  notHomeWaitMinutes: number;
  callOutFeeCents: number;
  freeCancelHours: number;
  lateCancelLimit: number;
  lateCancelWindowDays: number;
  lateCancelPauseDays: number;
  goals: { acceptancePct: number; onTimePct: number; completionPct: number; rating: number };
  support: { email: string | null; phone: string | null };
}

/**
 * Help & support in the pro app (D100): the pros' common questions, each opening its answer under it, with the
 * real numbers from Settings, then "Chat with us" and "Call", always both shown (shared with customers).
 */
export function ProHelpPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ help: ProHelpFacts }>('/pro/help'), [api]);
  const { state, reload } = useResource(load);
  const [open, setOpen] = useState<string | null>(null);

  const answer = (key: (typeof PRO_FAQ)[number], facts: ProHelpFacts) => {
    switch (key) {
      case 'paid':
        return t('proHelp.faq.paid.a', { releaseHours: facts.releaseHours, schedule: t(`bank.interval.${facts.payoutInterval}`).toLowerCase() });
      case 'notHome':
        return t('proHelp.faq.notHome.a', { minutes: facts.notHomeWaitMinutes, fee: euro(facts.callOutFeeCents) });
      case 'cancel':
        return t('proHelp.faq.cancel.a', {
          hours: facts.freeCancelHours,
          limit: facts.lateCancelLimit,
          windowDays: facts.lateCancelWindowDays,
          pauseDays: facts.lateCancelPauseDays,
        });
      case 'moreJobs':
        return t('proHelp.faq.moreJobs.a', {
          acceptance: facts.goals.acceptancePct,
          onTime: facts.goals.onTimePct,
          completion: facts.goals.completionPct,
        });
    }
  };

  return (
    <>
      <AppHeader title={t('proProfile.help')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ help: facts }) => (
            <>
              <ul className="lgroup plist faq" aria-label={t('help.questions')}>
                {PRO_FAQ.map((key) => {
                  const expanded = open === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className="lrow"
                        aria-expanded={expanded}
                        aria-controls={`pro-faq-${key}`}
                        onClick={() => setOpen(expanded ? null : key)}
                      >
                        <span className="grow">{t(`proHelp.faq.${key}.q`)}</span>
                        <span className="lv">
                          <Icon name={expanded ? 'chevD' : 'chevR'} />
                        </span>
                      </button>
                      <p id={`pro-faq-${key}`} className="small muted faq-answer" hidden={!expanded}>
                        {answer(key, facts)}
                      </p>
                    </li>
                  );
                })}
              </ul>
              <SupportContact support={facts.support} mailSubject={t('proHelp.mailSubject')} chatClassName="cta dark grow" />
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}

function TermsRow({ icon, label, children }: { icon: IconKey; label: string; children: (inner: ReactNode) => ReactNode }) {
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
 * Terms & conditions in the pro app (D100): Pro terms, Privacy policy (where the owner published it), Code of
 * conduct and Cancellation rules, each a section of the app's terms, and "Download my data".
 */
export function ProTermsPage() {
  const { t } = useTranslation();
  const config = useAppConfig();
  const section = (id: string, icon: IconKey, label: string) => (
    <TermsRow icon={icon} label={label}>
      {(inner) => (
        <Link to={`/terms#terms-${id}`} className="lrow">
          {inner}
        </Link>
      )}
    </TermsRow>
  );
  return (
    <>
      <AppHeader title={t('proProfile.termsTitle')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ul className="lgroup plist" aria-label={t('proProfile.termsTitle')}>
          {section('pros', 'file', t('legal.proTerms'))}
          <TermsRow icon="lock" label={t('legal.privacy')}>
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
          </TermsRow>
          {section('conduct', 'shield', t('legal.conduct'))}
          {section('proCancelling', 'clock', t('legal.cancellationRules'))}
          <DataExportRow personalPath={PRO_PROFILE_PATHS.personal} />
        </ul>
        <p className="tiny muted">{t('terms.updated')}</p>
      </div>
    </>
  );
}
