import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';
import {
  AddressSection,
  ApplicationProgress,
  DaysSection,
  DocumentsSection,
  SaveState,
  TradesSection,
  TravelSection,
  useApplicationDraft,
} from './ApplicationForm';

function ApplicationSteps({ profile, onChange }: { profile: ProProfile; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const draft = useApplicationDraft(profile, onChange);
  const submit = useAction();
  const agreed = draft.draft.backgroundConsent;

  async function send() {
    // Whatever is still waiting to be saved goes first, so the team gets the application as shown.
    const result = await submit.run(async () => {
      await draft.flush();
      return api.post<{ profile: ProProfile }>('/pro/submit');
    });
    if (result) {
      navigate('/pro/application');
    }
  }

  return (
    <>
      <header className="prohead">
        <div className="row gap8">
          <Link to="/pro/profile" className="iconbtn dark" aria-label={t('common.back')}>
            <Icon name="chevL" />
          </Link>
          <h1>{t('apply.title')}</h1>
        </div>
        <ApplicationProgress profile={profile} draft={draft.draft} />
      </header>
      <div className="body stack">
        {profile.status === 'info_requested' && profile.reviewNote && (
          <div className="info amber" role="note">
            <Icon name="bell" />
            <p>
              {t('apply.infoRequested')} <b>{profile.reviewNote}</b> {t('apply.infoRequestedHint')}
            </p>
          </div>
        )}
        <p className="muted small">{t('apply.intro')}</p>
        <TradesSection profile={profile} draft={draft} />
        <AddressSection draft={draft} />
        <TravelSection draft={draft} />
        <DocumentsSection profile={profile} onChange={onChange} />
        <section aria-labelledby="background-heading" className="stack tight">
          <h2 id="background-heading" className="h-sm">
            {t('apply.backgroundTitle')}
          </h2>
          <label className={`addon consent ${agreed ? 'on' : ''}`}>
            <input
              type="checkbox"
              className="cbox"
              checked={agreed}
              onChange={(event) => draft.change({ backgroundConsent: event.target.checked })}
            />
            <span className="small grow">
              <b>{t('apply.backgroundConsent')}</b> {t('apply.backgroundConsentText')}
            </span>
          </label>
        </section>
        <DaysSection draft={draft} />
        <SaveState draft={draft} />
      </div>
      <div className="cta-bar">
        <ErrorText error={submit.error} />
        <button type="button" className="cta dark" disabled={!agreed || submit.busy} onClick={() => void send()}>
          {!agreed ? t('apply.agreeFirst') : profile.status === 'info_requested' ? t('apply.sendAgain') : t('apply.submit')}
        </button>
      </div>
    </>
  );
}

/**
 * The Application page (D93): trades, home address and travel distance, documents, the background check
 * and working days, saved as the pro goes. An application already with the team opens its status page.
 */
export function ApplicationPage() {
  const api = useApi();
  const load = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const { state, reload, update } = useResource(load);
  const onChange = useCallback((next: ProProfile) => update(() => ({ profile: next })), [update]);
  return (
    <ResourceState state={state} reload={reload}>
      {({ profile }) =>
        profile.editable ? <ApplicationSteps profile={profile} onChange={onChange} /> : <Navigate to="/pro/application" replace />
      }
    </ResourceState>
  );
}
