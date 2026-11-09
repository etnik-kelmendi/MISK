import { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { PayoutInterval, PlatformSettings } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { euro, longDate, parseEuroToCents, proShare } from '../../lib/format';
import { useSave } from './settings/SaveStatus';

const COMMISSION_MIN = 10;
const COMMISSION_MAX = 30;
const MAX_FEE_CENTS = 10_000;
/** Example amounts for the explanations: a medium lawn mowing and a €5 tip. */
const EXAMPLE_JOB_CENTS = 4550;
const EXAMPLE_TIP_CENTS = 500;
const SLIDER_SAVE_DELAY_MS = 500;
const INTERVALS: PayoutInterval[] = ['weekly', 'biweekly', 'monthly'];

type Patch = Partial<Pick<PlatformSettings, 'serviceFeeCents' | 'commissionPct' | 'payoutInterval'>>;

function FeeInput({ cents, onSave }: { cents: number; onSave: (cents: number) => void }) {
  const { t } = useTranslation();
  const errorId = useId();
  const [text, setText] = useState((cents / 100).toFixed(2));
  const [invalid, setInvalid] = useState(false);

  function commit() {
    const value = parseEuroToCents(text);
    if (value === null || value > MAX_FEE_CENTS) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText((value / 100).toFixed(2));
    if (value !== cents) onSave(value);
  }

  return (
    <div className="af">
      <label htmlFor="service-fee">{t('admin.settings.fees.fee')}</label>
      <span className="price-input">
        <span aria-hidden="true">€</span>
        <input
          id="service-fee"
          inputMode="decimal"
          value={text}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : 'service-fee-hint'}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </span>
      {invalid ? (
        <span id={errorId} className="error-text small" role="alert">
          {t('admin.settings.fees.feeInvalid')}
        </span>
      ) : (
        <span id="service-fee-hint" className="hint">
          {t('admin.settings.fees.feeHint')}
        </span>
      )}
    </div>
  );
}

/** The commission slider saves itself a moment after the admin stops moving it. */
function CommissionSlider({ commission, onSave }: { commission: number; onSave: (pct: number) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(commission);
  const pro = 100 - value;

  useEffect(() => {
    if (value === commission) return;
    const timer = setTimeout(() => onSave(value), SLIDER_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value, commission, onSave]);

  return (
    <div className="af">
      <label htmlFor="commission">{t('admin.settings.fees.commission', { pct: value })}</label>
      <input
        id="commission"
        type="range"
        min={COMMISSION_MIN}
        max={COMMISSION_MAX}
        value={value}
        aria-valuetext={t('admin.settings.fees.split', { misk: value, pro })}
        onChange={(e) => setValue(Number(e.target.value))}
      />
      <div className="split split-commission" aria-hidden="true">
        <div style={{ width: `${pro}%` }} />
        <div style={{ width: `${value}%` }} />
      </div>
      <p className="row between small">
        <span className="b">{t('admin.settings.fees.split', { misk: value, pro })}</span>
      </p>
      <p className="small muted">
        {t('admin.settings.fees.splitExample', {
          price: euro(EXAMPLE_JOB_CENTS),
          pro: euro(proShare(EXAMPLE_JOB_CENTS, pro)),
          misk: euro(EXAMPLE_JOB_CENTS - proShare(EXAMPLE_JOB_CENTS, pro)),
        })}
      </p>
    </div>
  );
}

function FeesForm({ settings, onSaved }: { settings: PlatformSettings; onSaved: (s: PlatformSettings) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const pro = settings.proSharePct;

  const save = useCallback(
    async (patch: Patch) => {
      const result = await track(() => api.patch<{ settings: PlatformSettings }>('/admin/settings', patch));
      if (result) onSaved(result.settings);
    },
    [api, track, onSaved],
  );
  const saveCommission = useCallback((commissionPct: number) => void save({ commissionPct }), [save]);

  return (
    <div className="stack">
      <section className="panel stack" aria-labelledby="fee-heading">
        <h2 id="fee-heading">{t('admin.settings.fees.feeTitle')}</h2>
        <FeeInput key={settings.serviceFeeCents} cents={settings.serviceFeeCents} onSave={(serviceFeeCents) => void save({ serviceFeeCents })} />
      </section>

      <section className="panel stack" aria-labelledby="commission-heading">
        <h2 id="commission-heading">{t('admin.settings.fees.commissionTitle')}</h2>
        <CommissionSlider key={settings.commissionPct} commission={settings.commissionPct} onSave={saveCommission} />
        <p className="small muted">{t('admin.settings.fees.commissionHint')}</p>
        <p className="small muted">
          {t('admin.settings.fees.plansNote')} <Link to="/admin/plans">{t('admin.settings.fees.plansLink')}</Link>.
        </p>
      </section>

      <section className="panel stack" aria-labelledby="payment-heading">
        <h2 id="payment-heading">{t('admin.settings.fees.paymentTitle')}</h2>
        <ul className="rule-list">
          <li>{t('admin.settings.fees.paymentHeld')}</li>
          <li>{t('admin.settings.fees.paymentCharged', { hours: settings.chargeDelayHours })}</li>
          <li>
            {t('admin.settings.fees.paymentProblem', { hours: settings.chargeDelayHours })}{' '}
            <Link to="/admin/bookings?tab=needs_action">{t('admin.settings.fees.needsAction')}</Link>.
          </li>
        </ul>
      </section>

      <section className="panel stack" aria-labelledby="payout-heading">
        <h2 id="payout-heading">{t('admin.settings.fees.payoutTitle')}</h2>
        <fieldset className="choice-row" aria-labelledby="payout-heading">
          {INTERVALS.map((interval) => (
            <div key={interval} className={`choice ${settings.payoutInterval === interval ? 'on' : ''}`}>
              <input
                id={`payout-${interval}`}
                type="radio"
                name="payout-interval"
                checked={settings.payoutInterval === interval}
                onChange={() => void save({ payoutInterval: interval })}
              />
              <label htmlFor={`payout-${interval}`}>
                <span className="b block">{t(`admin.settings.fees.payout.${interval}`)}</span>
                <span className="small muted">{t(`admin.settings.fees.payout.${interval}Hint`)}</span>
              </label>
            </div>
          ))}
        </fieldset>
        <p className="small muted">{t('admin.settings.fees.payoutNext', { date: longDate(settings.nextPayoutOn, 'UTC') })}</p>
      </section>

      <section className="panel stack" aria-labelledby="cancel-heading">
        <h2 id="cancel-heading">{t('admin.settings.fees.cancelTitle')}</h2>
        <ul className="rule-list">
          <li>{t('admin.settings.fees.cancelFree', { hours: settings.freeCancelHours })}</li>
          <li>{t('admin.settings.fees.cancelLate')}</li>
          <li>
            {t('admin.settings.fees.cancelSplit', {
              price: euro(EXAMPLE_JOB_CENTS),
              pro: euro(proShare(EXAMPLE_JOB_CENTS, pro)),
              misk: euro(EXAMPLE_JOB_CENTS - proShare(EXAMPLE_JOB_CENTS, pro)),
            })}
          </li>
        </ul>
      </section>

      <section className="panel stack" aria-labelledby="tips-heading">
        <h2 id="tips-heading">{t('admin.settings.fees.tipsTitle')}</h2>
        <ul className="rule-list">
          <li>
            {t('admin.settings.fees.tipsSplit', {
              tip: euro(EXAMPLE_TIP_CENTS),
              pro: euro(proShare(EXAMPLE_TIP_CENTS, pro)),
              misk: euro(EXAMPLE_TIP_CENTS - proShare(EXAMPLE_TIP_CENTS, pro)),
            })}
          </li>
          <li>{t('admin.settings.fees.tipsApp')}</li>
        </ul>
      </section>
    </div>
  );
}

/** Settings → Fees & payments. */
export function SettingsPage() {
  const api = useApi();
  const load = useCallback(() => api.get<{ settings: PlatformSettings }>('/admin/settings'), [api]);
  const { state, reload, update } = useResource(load);
  const onSaved = useCallback((settings: PlatformSettings) => update(() => ({ settings })), [update]);
  return (
    <ResourceState state={state} reload={reload}>
      {({ settings }) => <FeesForm settings={settings} onSaved={onSaved} />}
    </ResourceState>
  );
}
