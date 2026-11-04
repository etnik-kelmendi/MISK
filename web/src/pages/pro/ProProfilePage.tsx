import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';
import { ApplicationForm } from './ApplicationForm';

function Payouts({ profile, onChange }: { profile: ProProfile; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const link = useAction();
  const [params, setParams] = useSearchParams();
  const returning = params.get('payouts');

  // Coming back from Stripe: ask the API whether payouts work now.
  useEffect(() => {
    if (!returning) {
      return;
    }
    let current = true;
    api.post<{ profile: ProProfile }>('/pro/payouts/refresh').then(
      (result) => current && onChange(result.profile),
      (error: unknown) => console.error('Payout status check failed', error),
    );
    setParams({}, { replace: true });
    return () => {
      current = false;
    };
  }, [api, returning, onChange, setParams]);

  if (profile.status !== 'approved') {
    return null;
  }
  return (
    <section className="card stack" aria-labelledby="payouts-heading">
      <h2 id="payouts-heading" className="b">
        {t('payouts.title')}
      </h2>
      {profile.payoutsEnabled ? (
        <p className="row small">
          <Icon name="check" /> {t('payouts.ready')}
        </p>
      ) : (
        <>
          <p className="small muted">{profile.hasPayoutAccount ? t('payouts.unfinished') : t('payouts.explain')}</p>
          <ErrorText error={link.error} />
          <button
            type="button"
            className="btn btn-primary"
            disabled={link.busy}
            onClick={() =>
              void link.run(() => api.post<{ url: string }>('/pro/payouts/link')).then((result) => {
                if (result) {
                  window.location.assign(result.url);
                }
              })
            }
          >
            <Icon name="card" /> {profile.hasPayoutAccount ? t('payouts.continue') : t('payouts.start')}
          </button>
        </>
      )}
    </section>
  );
}

export function ProProfilePage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const { state, reload, update } = useResource(load);
  const onChange = useCallback((next: ProProfile) => update(() => ({ profile: next })), [update]);

  return (
    <>
      <header className="prohead">
        <h1>{t('nav.profile')}</h1>
      </header>
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ profile }) => (
            <div className="stack">
              <Payouts profile={profile} onChange={onChange} />
              <p className="small muted">{t(`apply.statusLine.${profile.status}`)}</p>
              <ApplicationForm profile={profile} onChange={onChange} />
            </div>
          )}
        </ResourceState>
        <Link to="/pro/account" className="btn btn-ghost wide">
          <Icon name="user" /> {t('account.title')}
        </Link>
      </div>
    </>
  );
}
