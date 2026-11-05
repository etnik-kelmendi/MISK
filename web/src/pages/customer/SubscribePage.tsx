import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { JobSize, PaymentStep, Plan, Postcode, Subscription, TimeWindow } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { euro } from '../../lib/format';
import { currentMonth, DAYS_PER_WEEK, planSizePrice, VISITS_PER_MONTH } from '../../lib/plans';
import { useAction } from '../../lib/useAction';
import { CardPayment } from '../../payments/CardPayment';
import { AppHeader } from '../../shells/Shells';

const SIZES: JobSize[] = ['S', 'M', 'L'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const WINDOWS: TimeWindow[] = ['morning', 'afternoon'];

function SubscribeForm({ plan, postcodes }: { plan: Plan; postcodes: Postcode[] }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone } = useMarket();
  const { run, busy, error } = useAction();
  const [size, setSize] = useState<JobSize>('M');
  const [days, setDays] = useState<number[]>([]);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('morning');
  const [withAddon, setWithAddon] = useState(false);
  const [address, setAddress] = useState('');
  const [postcode, setPostcode] = useState('');
  const [notes, setNotes] = useState('');
  const [paying, setPaying] = useState<{ subscription: Subscription; payment: PaymentStep } | null>(null);

  const needed = DAYS_PER_WEEK[plan.frequency];
  const base = planSizePrice(plan.priceCents ?? 0, size);
  const total = base + (withAddon ? (plan.addonPriceCents ?? 0) : 0);
  const perVisit = Math.round(total / VISITS_PER_MONTH[plan.frequency]);
  const month = currentMonth(timezone);
  const offSeason = plan.seasonal && (month < (plan.seasonFrom ?? 1) || month > (plan.seasonTo ?? 12));
  const ready = days.length === needed && address.trim().length >= 3 && postcode !== '' && !offSeason;

  function toggleDay(day: number) {
    setDays((current) => {
      if (current.includes(day)) {
        return current.filter((d) => d !== day);
      }
      // With one day to pick, a new choice replaces the old one.
      return needed === 1 ? [day] : current.length < needed ? [...current, day] : current;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() =>
      api.post<{ subscription: Subscription; payment: PaymentStep | null }>('/subscriptions', {
        planId: plan.id,
        size,
        days,
        timeWindow,
        address,
        postcode,
        notes,
        withAddon,
      }),
    );
    if (!result) {
      return;
    }
    if (result.payment) {
      setPaying({ subscription: result.subscription, payment: result.payment });
    } else {
      navigate(`/my-plans/${result.subscription.id}`, { replace: true });
    }
  }

  if (paying) {
    return (
      <div className="body">
        <h2 className="h-sm">{t('pay.title')}</h2>
        <CardPayment
          payment={paying.payment}
          amountLabel={t('plans.perMonth', { price: euro(paying.subscription.priceCents) })}
          onConfirmed={() => navigate(`/my-plans/${paying.subscription.id}`, { replace: true })}
        />
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="body">
        <p className="small muted">{t('subscribe.included', { tasks: plan.tasks.join(' · ') })}</p>
        <p className="small muted">
          {t(`admin.plans.frequency.${plan.frequency}`)} · {t('admin.plans.minutes', { minutes: plan.visitMinutes })}
        </p>

        <fieldset>
          <legend className="h-sm">{t('subscribe.size')}</legend>
          <div className="seg wide-seg">
            {SIZES.map((s) => (
              <button key={s} type="button" className={s === size ? 'on' : ''} aria-pressed={s === size} onClick={() => setSize(s)}>
                {t(`book.size.${s}`)} · {euro(planSizePrice(plan.priceCents ?? 0, s))}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="h-sm">{t('subscribe.days', { count: needed })}</legend>
          <div className="wk">
            {WEEKDAYS.map((day) => (
              <label key={day} className={days.includes(day) ? 'on' : ''}>
                <input type="checkbox" className="visually-hidden" checked={days.includes(day)} onChange={() => toggleDay(day)} />
                {t(`weekday.${day}`)}
              </label>
            ))}
          </div>
          <div className="seg wide-seg" role="group" aria-label={t('subscribe.window')}>
            {WINDOWS.map((w) => (
              <button key={w} type="button" className={w === timeWindow ? 'on' : ''} aria-pressed={w === timeWindow} onClick={() => setTimeWindow(w)}>
                {t(`subscribe.windows.${w}`)}
              </button>
            ))}
          </div>
        </fieldset>

        {plan.addonName && (
          <fieldset>
            <legend className="h-sm">{t('subscribe.extras')}</legend>
            <label className={`addon ${withAddon ? 'on' : ''}`}>
              <input type="checkbox" checked={withAddon} onChange={(e) => setWithAddon(e.target.checked)} />
              <span className="grow b small">{plan.addonName}</span>
              <span className="b small">{t('admin.plans.addonPreviewPrice', { price: euro(plan.addonPriceCents ?? 0) })}</span>
            </label>
          </fieldset>
        )}

        <div className="field">
          <label htmlFor="sub-address">{t('book.address')}</label>
          <input id="sub-address" autoComplete="street-address" required maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sub-postcode">{t('book.postcode')}</label>
          <select id="sub-postcode" required value={postcode} onChange={(e) => setPostcode(e.target.value)}>
            <option value="">{t('book.choosePostcode')}</option>
            {postcodes.map((p) => (
              <option key={p.code} value={p.code}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sub-notes">{t('book.notes')}</label>
          <textarea id="sub-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <section className="sumbox" aria-label={t('subscribe.summary')}>
          <div className="row between">
            <div>
              <p className="sub">{t('subscribe.monthly')}</p>
              <p className="big-price">
                {euro(total)}
                <span className="small">{t('admin.plans.perMonthSuffix')}</span>
              </p>
            </div>
            <p className="right small">{t('admin.plans.perVisit', { price: euro(perVisit) })}</p>
          </div>
          <ul className="small sub stack tight">
            <li>✓ {t('subscribe.regularPro', { visits: VISITS_PER_MONTH[plan.frequency] })}</li>
            <li>✓ {plan.seasonal ? t('admin.plans.seasonShort') : t('subscribe.allYear')}</li>
            <li>✓ {t('subscribe.skips', { count: plan.skipsPerMonth })}</li>
            <li>✓ {t('subscribe.term', { months: plan.minTermMonths })}</li>
          </ul>
        </section>
        {offSeason && (
          <p className="info amber" role="status">
            {t('subscribe.offSeason')}
          </p>
        )}
        <ErrorText error={error} />
      </div>
      <div className="cta-bar">
        <button className="cta" type="submit" disabled={busy || !ready}>
          <Icon name="repeat" />{' '}
          {days.length !== needed
            ? t('subscribe.pickDays', { count: needed - days.length })
            : t('subscribe.submit', { price: euro(total) })}
        </button>
      </div>
    </form>
  );
}

export function SubscribePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(
    () => Promise.all([api.get<{ plans: Plan[] }>('/plans'), api.get<{ postcodes: Postcode[] }>('/postcodes')]),
    [api],
  );
  const { state, reload } = useResource(load);
  return (
    <ResourceState state={state} reload={reload}>
      {([{ plans }, { postcodes }]) => {
        const plan = plans.find((p) => p.id === id);
        if (!plan) {
          return <Navigate to="/plans" replace />;
        }
        return (
          <>
            <AppHeader title={plan.name ?? t('plans.title')} back="/plans" />
            <SubscribeForm plan={plan} postcodes={postcodes} />
          </>
        );
      }}
    </ResourceState>
  );
}
