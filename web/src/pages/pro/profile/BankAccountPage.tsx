import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../../api/ApiContext';
import { useResource } from '../../../api/useResource';
import { useUser } from '../../../auth/AuthContext';
import { ErrorText } from '../../../components/ErrorText';
import { Icon } from '../../../components/Icon';
import { ResourceState } from '../../../components/ResourceState';
import { euro, longDate } from '../../../lib/format';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';
import { PRO_PROFILE_PATHS, type BankSummary } from './types';

/** Payout days are calendar dates, so they are read in UTC like the API writes them. */
const DATE_ZONE = 'UTC';

/** Sends the pro to the payment provider, to set up payouts or to change the bank account. */
function useProviderLink(path: string) {
  const api = useApi();
  const action = useAction();
  const go = () =>
    void action.run(() => api.post<{ url: string }>(path)).then((result) => {
      if (result) window.location.assign(result.url);
    });
  return { go, busy: action.busy, error: action.error };
}

/** Before payouts work: set them up (or finish the setup) with the payment provider. */
function PayoutSetup({ summary }: { summary: BankSummary }) {
  const { t } = useTranslation();
  const link = useProviderLink('/pro/payouts/link');
  return (
    <section className="card stack" aria-labelledby="payout-setup-heading">
      <h2 id="payout-setup-heading" className="b">
        {t('payouts.title')}
      </h2>
      <p className="small muted">{summary.hasPayoutAccount ? t('payouts.unfinished') : t('payouts.explain')}</p>
      <ErrorText error={link.error} />
      <button type="button" className="cta dark" disabled={link.busy} onClick={link.go}>
        <Icon name="card" /> {summary.hasPayoutAccount ? t('payouts.continue') : t('payouts.start')}
      </button>
    </section>
  );
}

/** The account card: the last 4 digits, the holder and "Active", or "Being checked" while the provider checks it. */
function AccountCard({ summary }: { summary: BankSummary }) {
  const { t } = useTranslation();
  const user = useUser();
  const { bank } = summary;
  if (summary.bankError) {
    return <p className="card small muted">{t('bank.unavailable')}</p>;
  }
  if (!bank) return null;
  const holder = bank.holderName ?? [user.firstName, user.lastName].filter(Boolean).join(' ');
  return (
    <section className="card row bank-card" aria-label={t('bank.account')}>
      <span className="tile-icon" aria-hidden="true">
        <Icon name="card" />
      </span>
      <span className="grow min0">
        <span className="b block">{t('bank.number', { last4: bank.last4 })}</span>
        <span className="tiny muted block">{holder}</span>
      </span>
      {bank.active ? (
        <span className="badge g">
          <Icon name="check" /> {t('bank.active')}
        </span>
      ) : (
        <span className="badge b">{t('bank.checking')}</span>
      )}
    </section>
  );
}

/** The yearly statement for taxes as a PDF, for the chosen year (the last full year at first). */
function TaxStatement({ summary }: { summary: BankSummary }) {
  const { t } = useTranslation();
  const api = useApi();
  const [year, setYear] = useState(summary.defaultStatementYear);
  return (
    <section className="stack tight" aria-labelledby="tax-heading">
      <h2 id="tax-heading" className="visually-hidden">
        {t('bank.tax')}
      </h2>
      {summary.statementYears.length > 1 && (
        <div className="field">
          <label htmlFor="tax-year">{t('bank.taxYear')}</label>
          <select id="tax-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {summary.statementYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      )}
      <a className="cta ghost" href={`${api.baseUrl}/pro/earnings/tax-statement?year=${year}`} download aria-label={t('bank.taxLabel', { year })}>
        <Icon name="download" /> {t('bank.tax')}
      </a>
      <p className="tiny muted">{t('bank.taxHint', { year })}</p>
    </section>
  );
}

/**
 * Bank account (D100): the account payouts go to with "Active", the payout schedule set by MISK, the next payout day
 * and amount, "Change bank account" (the provider checks a new account before the next payout) and the yearly
 * statement for taxes.
 */
export function BankAccountPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ bank: BankSummary }>('/pro/bank'), [api]);
  const { state, reload } = useResource(load);
  const change = useProviderLink('/pro/bank/change-link');
  const [params, setParams] = useSearchParams();
  const returning = params.get('payouts');

  // Back from the payment provider's setup: ask the API whether payouts work now, then show the account.
  useEffect(() => {
    if (!returning) return;
    let current = true;
    api.post('/pro/payouts/refresh').then(
      () => current && reload(),
      (error: unknown) => console.error('Payout status check failed', error),
    );
    setParams({}, { replace: true });
    return () => {
      current = false;
    };
  }, [api, returning, reload, setParams]);

  return (
    <>
      <AppHeader title={t('proProfile.bank')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ bank: summary }) => (
            <div className="stack">
              {!summary.payoutsEnabled && !summary.bank && <PayoutSetup summary={summary} />}
              <AccountCard summary={summary} />
              <ul className="lgroup plist" aria-label={t('bank.payouts')}>
                <li className="lrow">
                  <span className="grow">{t('bank.schedule')}</span>
                  <span className="lv wrap-text">{t('bank.scheduleValue', { interval: t(`bank.interval.${summary.interval}`) })}</span>
                </li>
                <li className="lrow">
                  <span className="grow">{t('bank.next')}</span>
                  <span className="lv wrap-text">
                    {t('bank.nextValue', { date: longDate(summary.nextPayoutOn, DATE_ZONE), amount: euro(summary.nextPayoutCents) })}
                  </span>
                </li>
              </ul>
              {summary.hasPayoutAccount && (
                <>
                  <button type="button" className="cta ghost" disabled={change.busy} onClick={change.go} aria-describedby="bank-change-hint">
                    {t('bank.change')}
                  </button>
                  <p id="bank-change-hint" className="tiny muted">
                    {t('bank.changeHint')}
                  </p>
                  <ErrorText error={change.error} />
                </>
              )}
              <TaxStatement summary={summary} />
              <Link to={PRO_PROFILE_PATHS.earnings} className="small brand-text">
                {t('bank.earnings')}
              </Link>
            </div>
          )}
        </ResourceState>
      </div>
    </>
  );
}
