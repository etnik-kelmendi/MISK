import { useCallback, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { PayoutInterval, PlatformSettings } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
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

/** One setting: what it is and what it does on the left, its control on the right. */
function SettingRow({
  label,
  labelFor,
  children,
  control,
}: {
  label: string;
  labelFor?: string;
  children?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="srow">
      <div>
        {labelFor ? (
          <label className="sl" htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <span className="sl">{label}</span>
        )}
        {children}
      </div>
      <div className="ctrl">{control}</div>
    </div>
  );
}

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
    <SettingRow
      label={t('admin.settings.fees.fee')}
      labelFor="service-fee"
      control={
        <>
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
          {invalid && (
            <span id={errorId} className="error-text small" role="alert">
              {t('admin.settings.fees.feeInvalid')}
            </span>
          )}
        </>
      }
    >
      <p id="service-fee-hint" className="sd">
        {t('admin.settings.fees.feeHint')}
      </p>
    </SettingRow>
  );
}

/** The commission slider saves itself a moment after the admin stops moving it. */
function CommissionSlider({ value, saved, onChange, onSave }: { value: number; saved: number; onChange: (pct: number) => void; onSave: (pct: number) => void }) {
  const { t } = useTranslation();
  const pro = 100 - value;

  useEffect(() => {
    if (value === saved) return;
    const timer = setTimeout(() => onSave(value), SLIDER_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value, saved, onSave]);

  return (
    <SettingRow
      label={t('admin.settings.fees.commissionTitle')}
      labelFor="commission"
      control={
        <div className="commission-ctrl">
          <div className="row between small">
            <span>
              {t('admin.settings.fees.miskShare')} <b>{value}%</b>
            </span>
            <span className="muted">{t('admin.settings.fees.proShare', { pct: pro })}</span>
          </div>
          <input
            id="commission"
            type="range"
            min={COMMISSION_MIN}
            max={COMMISSION_MAX}
            step={1}
            value={value}
            aria-label={t('admin.settings.fees.commission', { pct: value })}
            aria-valuetext={t('admin.settings.fees.split', { misk: value, pro })}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </div>
      }
    >
      <p className="sd">
        {t('admin.settings.fees.commissionHint')}{' '}
        {t('admin.settings.fees.splitExample', {
          price: euro(EXAMPLE_JOB_CENTS),
          pro: euro(proShare(EXAMPLE_JOB_CENTS, pro)),
          misk: euro(EXAMPLE_JOB_CENTS - proShare(EXAMPLE_JOB_CENTS, pro)),
        })}
      </p>
      <p className="sd">
        {t('admin.settings.fees.plansNote')} <Link to="/admin/plans">{t('admin.settings.fees.plansLink')}</Link>.
      </p>
    </SettingRow>
  );
}

/** How a one-off job is paid: reserved, 24 hours to review, then charged. */
function ChargeFlow({ hours }: { hours: number }) {
  const { t } = useTranslation();
  const steps = [
    { icon: 'check' as const, title: t('admin.settings.fees.flow.doneTitle'), text: t('admin.settings.fees.flow.doneText') },
    { icon: 'clock' as const, title: t('admin.settings.fees.flow.reviewTitle', { hours }), text: t('admin.settings.fees.flow.reviewText') },
    { icon: 'card' as const, title: t('admin.settings.fees.flow.paidTitle'), text: t('admin.settings.fees.flow.paidText') },
  ];
  return (
    <div className="srow block">
      <span className="sl">{t('admin.settings.fees.paymentTitle')}</span>
      <p className="sd">{t('admin.settings.fees.paymentHeld')}</p>
      <ol className="flowx" aria-label={t('admin.settings.fees.paymentTitle')}>
        {steps.map((step, index) => (
          <li key={step.icon} className="flowstep">
            <div className="fx">
              <span className="fxi" aria-hidden="true">
                <Icon name={step.icon} />
              </span>
              <b>{step.title}</b>
              <span>{step.text}</span>
            </div>
            {index < steps.length - 1 && (
              <span className="fxa" aria-hidden="true">
                <Icon name="arrowR" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="info amber flow-note">
        <Icon name="bell" />
        <div>
          {t('admin.settings.fees.paymentProblem', { hours })}{' '}
          <Link to="/admin/bookings?tab=needs_action">{t('admin.settings.fees.needsAction')}</Link>.
        </div>
      </div>
    </div>
  );
}

function FeesForm({ settings, onSaved }: { settings: PlatformSettings; onSaved: (s: PlatformSettings) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  // The slider's position, so the splits below follow it while it moves.
  const [commission, setCommission] = useState(settings.commissionPct);
  // When a saved commission comes back, the slider moves to it (React's "adjust state on prop change").
  const [savedCommission, setSavedCommission] = useState(settings.commissionPct);
  if (settings.commissionPct !== savedCommission) {
    setSavedCommission(settings.commissionPct);
    setCommission(settings.commissionPct);
  }
  const pro = 100 - commission;
  const split = t('admin.settings.fees.splitShort', { pro, misk: commission });

  const save = useCallback(
    async (patch: Patch) => {
      const result = await track(() => api.patch<{ settings: PlatformSettings }>('/admin/settings', patch));
      if (result) onSaved(result.settings);
    },
    [api, track, onSaved],
  );
  const saveCommission = useCallback((commissionPct: number) => void save({ commissionPct }), [save]);

  return (
    <section className="panel" aria-labelledby="fees-heading">
      <h2 id="fees-heading">{t('admin.settings.tabs.fees')}</h2>
      <FeeInput key={settings.serviceFeeCents} cents={settings.serviceFeeCents} onSave={(serviceFeeCents) => void save({ serviceFeeCents })} />
      <CommissionSlider value={commission} saved={settings.commissionPct} onChange={setCommission} onSave={saveCommission} />
      <ChargeFlow hours={settings.chargeDelayHours} />

      <SettingRow
        label={t('admin.settings.fees.payoutTitle')}
        control={
          <fieldset className="seg" aria-label={t('admin.settings.fees.payoutTitle')}>
            {INTERVALS.map((interval) => (
              <label key={interval} className={settings.payoutInterval === interval ? 'on' : ''}>
                <input
                  type="radio"
                  className="visually-hidden"
                  name="payout-interval"
                  checked={settings.payoutInterval === interval}
                  aria-label={t(`admin.settings.fees.payout.${interval}`)}
                  onChange={() => void save({ payoutInterval: interval })}
                />
                {t(`admin.settings.fees.payout.${interval}Short`)}
              </label>
            ))}
          </fieldset>
        }
      >
        <p className="sd">{t('admin.settings.fees.payoutBank')}</p>
        <p className="sd">
          {t('admin.settings.fees.payoutNext', {
            date: longDate(settings.nextPayoutOn, 'UTC'),
            when: t(`admin.settings.fees.payout.${settings.payoutInterval}Hint`),
          })}
        </p>
      </SettingRow>

      <SettingRow
        label={t('admin.settings.fees.cancelTitle')}
        control={
          <span className="badge g">
            <Icon name="clock" /> {t('admin.settings.fees.hoursBadge', { hours: settings.freeCancelHours })}
          </span>
        }
      >
        <p className="sd">
          <Trans
            i18nKey="admin.settings.fees.cancelText"
            values={{ hours: settings.freeCancelHours, split }}
            components={{ b: <b /> }}
          />
        </p>
        <p className="sd">
          {t('admin.settings.fees.cancelSplit', {
            price: euro(EXAMPLE_JOB_CENTS),
            pro: euro(proShare(EXAMPLE_JOB_CENTS, pro)),
            misk: euro(EXAMPLE_JOB_CENTS - proShare(EXAMPLE_JOB_CENTS, pro)),
          })}
        </p>
      </SettingRow>

      <SettingRow label={t('admin.settings.fees.tipsTitle')} control={<span className="badge g">{split}</span>}>
        <p className="sd">{t('admin.settings.fees.tipsText')}</p>
        <p className="sd">
          {t('admin.settings.fees.tipsSplit', {
            tip: euro(EXAMPLE_TIP_CENTS),
            pro: euro(proShare(EXAMPLE_TIP_CENTS, pro)),
            misk: euro(EXAMPLE_TIP_CENTS - proShare(EXAMPLE_TIP_CENTS, pro)),
          })}
        </p>
      </SettingRow>
    </section>
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
