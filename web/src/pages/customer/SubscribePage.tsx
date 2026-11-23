import type { TFunction } from 'i18next';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { Frequency, JobSize, PaymentStep, PlanStart, Postcode, PublicPlan, SavedAddress, Subscription, TimeWindow } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { Sheet } from '../../components/Sheet';
import { dayName, euro, longDate } from '../../lib/format';
import {
  builderPrice,
  currentMonth,
  DAYS_PER_WEEK,
  firstVisitDay,
  planRuleTexts,
  seasonText,
  SKIPS_PER_MONTH,
  todayIn,
  VISITS_PER_MONTH,
} from '../../lib/plans';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { CardPayment, confirmSavedCard } from '../../payments/CardPayment';
import {
  brandName,
  initialOption,
  paymentMethodBody,
  PaymentOptionList,
  walletOf,
  type PaymentMethods,
  type PaymentOption,
} from '../../payments/PaymentOptions';
import { WalletButton, type Wallet } from '../../payments/WalletButton';
import { AppHeader } from '../../shells/Shells';
import { CATEGORY_COLORS } from './categoryColors';

const FREQUENCIES: Frequency[] = ['every_2_weeks', 'weekly', 'twice_weekly', 'three_times_weekly'];
const SIZES: JobSize[] = ['S', 'M', 'L'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const WINDOWS: TimeWindow[] = ['morning', 'afternoon'];
const STARTS: PlanStart[] = ['asap', 'next_week', 'in_2_weeks'];

/** "Tue 1 Dec" for a calendar day 'YYYY-MM-DD'. */
const calendarDay = (day: string) => dayName(`${day}T12:00:00Z`, 'UTC');
const weekdayName = (day: number) => `weekday.${day as 1 | 2 | 3 | 4 | 5 | 6 | 7}` as const;

/** A row of choices that are radio buttons, styled as a segmented control. */
function RadioSeg<T extends string>({
  legend,
  name,
  value,
  options,
  label,
  onChange,
  wrap = false,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly T[];
  label: (option: T) => string;
  onChange: (option: T) => void;
  wrap?: boolean;
}) {
  return (
    <fieldset>
      <legend className="h-sm">{legend}</legend>
      <div className={`seg radio-seg ${wrap ? 'wrap-2' : ''}`}>
        {options.map((option) => (
          <label key={option} className={option === value ? 'on' : ''}>
            <input type="radio" name={name} className="visually-hidden" checked={option === value} onChange={() => onChange(option)} />
            {label(option)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The subscription terms of one plan, with its own rules from the control panel (D77, D85, D90). */
function TermsSheet({ plan, onClose }: { plan: PublicPlan; onClose: () => void }) {
  const { t } = useTranslation();
  const rules = planRuleTexts(t, plan);
  const items: [string, string][] = [
    [t('subscribe.terms.billing'), t('subscribe.terms.billingText')],
    [t('subscribe.terms.minimum'), rules.term],
    [t('subscribe.terms.skips'), t('subscribe.terms.skipsText', { count: SKIPS_PER_MONTH })],
    [t('subscribe.terms.pauses'), rules.pause],
    [t('subscribe.terms.moves'), t('subscribe.terms.movesText')],
    [t('subscribe.terms.season'), plan.seasonal ? t('subscribe.terms.seasonText', { season: seasonText(t, plan) }) : t('plans.allYear')],
    [t('subscribe.terms.pro'), t('subscribe.terms.proText')],
  ];
  return (
    <Sheet title={t('subscribe.terms.title')} closeLabel={t('common.close')} onClose={onClose}>
      <dl className="stack terms-list">
        {items.map(([title, text]) => (
          <div key={title}>
            <dt className="b">{title}</dt>
            <dd className="small">{text}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}

/** What a payment option is called on the summary after subscribing. */
function methodLabel(t: TFunction, option: PaymentOption, methods: PaymentMethods): string {
  if (option.choice === 'card') {
    const card = methods.cards.find((c) => c.id === option.cardId);
    return card ? t('review.card', { brand: brandName(card.brand), last4: card.last4 }) : t('subscribe.methods.card');
  }
  return t(`subscribe.methods.${option.choice}`);
}

/** After subscribing (D90): the first visit, the regular pro, the monthly price and the end of the minimum term. */
function Subscribed({ subscription, method }: { subscription: Subscription; method: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { timezone } = useMarket();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const days = subscription.days.map((d) => t(weekdayName(d))).join(' & ');
  const firstVisit = subscription.nextVisitAt
    ? `${dayName(subscription.nextVisitAt, timezone)}, ${t(`subscribe.windowShort.${subscription.timeWindow}`)}`
    : subscription.firstVisitOn
      ? `${calendarDay(subscription.firstVisitOn)}, ${t(`subscribe.windowShort.${subscription.timeWindow}`)}`
      : t('subscribe.done.planning');
  return (
    <>
      <div className="body">
        <section className="card center done-card" aria-labelledby="subscribed-heading">
          <span className="done-icon" aria-hidden="true">
            <Icon name="repeat" />
          </span>
          <h2 id="subscribed-heading" className="b big" tabIndex={-1} ref={heading}>
            {subscription.status === 'active'
              ? t('subscribe.done.active', { plan: subscription.planName })
              : t('subscribe.done.starting', { plan: subscription.planName })}
          </h2>
          <p className="small muted">
            {t('plans.perMonth', { price: euro(subscription.priceCents) })} · {t(`admin.plans.frequency.${subscription.frequency}`)} · {days}{' '}
            {t(`subscribe.windowShort.${subscription.timeWindow}`)}
          </p>
        </section>
        <dl className="card kv" aria-label={t('subscribe.done.summary')}>
          <dt>{t('subscribe.done.firstVisit')}</dt>
          <dd className="b">{firstVisit}</dd>
          <dt>{t('subscribe.done.pro')}</dt>
          <dd className="b">{subscription.proName ?? t('subscription.yourPro')}</dd>
          <dt>{t('subscribe.done.billing')}</dt>
          <dd className="b">{t('subscribe.done.billingValue', { price: euro(subscription.priceCents), method })}</dd>
          <dt>{t('subscribe.done.minimum')}</dt>
          <dd className="b">{subscription.minTermEndsAt ? t('subscribe.done.until', { date: longDate(subscription.minTermEndsAt, timezone) }) : '–'}</dd>
        </dl>
        <p className="info">
          <Icon name="user" />
          <span>{t('subscribe.done.note')}</span>
        </p>
      </div>
      <div className="cta-bar">
        <button type="button" className="cta" onClick={() => navigate(`/my-plans/${subscription.id}`, { replace: true })}>
          {t('subscribe.done.seeVisits')} <Icon name="arrowR" />
        </button>
      </div>
    </>
  );
}

interface BuilderProps {
  plans: PublicPlan[];
  plan: PublicPlan;
  postcodes: Postcode[];
  methods: PaymentMethods;
  address: { address: string; postcode: string } | null;
}

/**
 * The Plan builder (D90): the plan, how often, size, extras, days, time of day, start, payment, the live price
 * from the server's own price table, and the subscription terms. Subscribe stays disabled until every day is
 * picked and the terms are ticked; the server checks the same.
 */
function Builder({ plans, plan, postcodes, methods, address: savedAddress }: BuilderProps) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone } = useMarket();
  const { run, busy, error } = useAction();
  const termsId = useId();
  const agreeId = useId();
  const termsLinkId = useId();
  const [frequency, setFrequency] = useState<Frequency>(plan.frequency);
  const [size, setSize] = useState<JobSize>('M');
  const [withAddon, setWithAddon] = useState(false);
  const [days, setDays] = useState<number[]>([]);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('morning');
  const [start, setStart] = useState<PlanStart>('asap');
  const [address, setAddress] = useState(savedAddress?.address ?? '');
  const [postcode, setPostcode] = useState(savedAddress && postcodes.some((p) => p.code === savedAddress.postcode) ? savedAddress.postcode : '');
  const [notes, setNotes] = useState('');
  const [option, setOption] = useState<PaymentOption>(() => initialOption(methods));
  const [unavailable, setUnavailable] = useState<Wallet[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [cardStep, setCardStep] = useState<{ subscription: Subscription; payment: PaymentStep } | null>(null);
  const [done, setDone] = useState<Subscription | null>(null);
  // The plan a wallet payment made, so it shows once the wallet has confirmed.
  const walletPlan = useRef<Subscription | null>(null);

  const needed = DAYS_PER_WEEK[frequency];
  const total = builderPrice(plan, { frequency, size, withAddon });
  const visits = VISITS_PER_MONTH[frequency];
  const perVisit = Math.round(total / visits);
  const month = currentMonth(timezone);
  const offSeason = plan.seasonal && (month < (plan.seasonFrom ?? 1) || month > (plan.seasonTo ?? 12));
  const daysOk = days.length === needed;
  const firstDay = firstVisitDay(todayIn(timezone), start, days, plan);
  const wallet = walletOf(option);
  const key = methods.publishableKey;
  const rules = planRuleTexts(t, plan);
  const form = useValidation(
    {
      address: !address.trim() ? t('validation.addressMissing') : address.trim().length < 3 && t('validation.addressShort'),
      postcode: !postcode && t('validation.postcodeMissing'),
    },
    { address: 'sub-address', postcode: 'sub-postcode' },
  );
  const ready = daysOk && agreed && !offSeason && firstDay !== null;

  function changeFrequency(next: Frequency) {
    setFrequency(next);
    // Keep the days already picked, up to as many as the new frequency needs.
    setDays((current) => current.slice(0, DAYS_PER_WEEK[next]));
  }

  function changePlan(id: string) {
    if (id !== plan.id) navigate(`/plans/${id}`, { replace: true });
  }

  function toggleDay(day: number) {
    setDays((current) => {
      if (current.includes(day)) return current.filter((d) => d !== day);
      // With one day to pick, a new choice replaces the old one; with more, the oldest choice makes room.
      const next = [...current, day];
      return (next.length > needed ? next.slice(next.length - needed) : next).sort((a, b) => a - b);
    });
  }

  async function createPlan(): Promise<{ subscription: Subscription; payment: PaymentStep | null }> {
    return api.post<{ subscription: Subscription; payment: PaymentStep | null }>('/subscriptions', {
      planId: plan.id,
      frequency,
      size,
      days,
      timeWindow,
      start,
      address: address.trim(),
      postcode,
      notes,
      withAddon,
      paymentMethod: paymentMethodBody(option),
      acceptTerms: true,
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !form.check()) return;
    const result = await run(async () => {
      const created = await createPlan();
      if (created.payment && option.choice === 'card') {
        // The bank wants the customer to confirm the saved card (3-D Secure). If that fails, My plan shows how
        // to finish paying.
        try {
          await confirmSavedCard(created.payment);
        } catch (caught) {
          console.warn('Saved card confirmation did not finish', caught);
        }
        return { ...created, payment: null };
      }
      return created;
    });
    if (!result) return;
    if (result.payment) setCardStep({ subscription: result.subscription, payment: result.payment });
    else setDone(result.subscription);
  }

  /** The plan as the server has it now, e.g. once the first payment went through. */
  async function showDone(subscription: Subscription) {
    try {
      const fresh = await api.get<{ subscription: Subscription }>(`/subscriptions/${subscription.id}`);
      setDone(fresh.subscription);
    } catch {
      setDone(subscription);
    }
  }

  if (done) {
    return <Subscribed subscription={done} method={methodLabel(t, option, methods)} />;
  }
  if (cardStep) {
    return (
      <div className="body">
        <section aria-label={t('pay.title')}>
          <h2 className="h-sm">{t('pay.title')}</h2>
          <CardPayment
            payment={cardStep.payment}
            amountLabel={t('plans.perMonth', { price: euro(cardStep.subscription.priceCents) })}
            onConfirmed={() => void showDone(cardStep.subscription)}
          />
        </section>
      </div>
    );
  }

  const ctaText = !daysOk
    ? t('subscribe.pickDays', { count: needed - days.length })
    : !agreed
      ? t('subscribe.acceptFirst')
      : t('subscribe.submit', { price: euro(total) });

  return (
    <form onSubmit={submit} noValidate>
      <div className="body">
        <fieldset>
          <legend className="visually-hidden">{t('subscribe.choosePlan')}</legend>
          <div className="plancards">
            {plans.map((p) => {
              const icon = p.categoryIcon ?? 'leaf';
              const color = CATEGORY_COLORS[icon];
              return (
                <label key={p.id} className={`plancard ${p.id === plan.id ? 'on' : ''}`}>
                  <input type="radio" name="plan" className="visually-hidden" checked={p.id === plan.id} onChange={() => changePlan(p.id)} />
                  <span className="ci" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
                    <Icon name={icon} />
                  </span>
                  <span className="b small block">{p.name}</span>
                  <span className="tiny muted block">{t('plans.from', { price: euro(p.fromCents) })}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <p className="small muted">{t('subscribe.included', { tasks: plan.tasks.join(' · ') })}</p>

        <RadioSeg
          legend={t('subscribe.howOften')}
          name="frequency"
          value={frequency}
          options={FREQUENCIES}
          label={(f) => t(`admin.plans.frequency.${f}`)}
          onChange={changeFrequency}
          wrap
        />
        <RadioSeg legend={t('subscribe.size')} name="size" value={size} options={SIZES} label={(s) => t(`book.size.${s}`)} onChange={setSize} />

        <fieldset className="stack tight">
          <legend className="h-sm">{t('subscribe.extras')}</legend>
          {plan.addonName ? (
            <label className={`addon ${withAddon ? 'on' : ''}`}>
              <input type="checkbox" checked={withAddon} onChange={(e) => setWithAddon(e.target.checked)} />
              <span className="grow b small">{plan.addonName}</span>
              <span className="b small">{t('subscribe.extraPrice', { price: euro(plan.addonPriceCents ?? 0) })}</span>
            </label>
          ) : (
            <p className="small muted">{t('plans.noExtras')}</p>
          )}
        </fieldset>

        <fieldset>
          <legend className="h-sm">{t('subscribe.days', { count: needed })}</legend>
          <div className="wk">
            {WEEKDAYS.map((day) => (
              <label key={day} className={days.includes(day) ? 'on' : ''}>
                <input type="checkbox" className="visually-hidden" checked={days.includes(day)} onChange={() => toggleDay(day)} />
                {t(weekdayName(day))}
              </label>
            ))}
          </div>
        </fieldset>
        <RadioSeg
          legend={t('subscribe.window')}
          name="window"
          value={timeWindow}
          options={WINDOWS}
          label={(w) => t(`subscribe.windows.${w}`)}
          onChange={setTimeWindow}
        />

        <RadioSeg legend={t('subscribe.start')} name="start" value={start} options={STARTS} label={(s) => t(`subscribe.starts.${s}`)} onChange={setStart} />
        <p className="small muted row gap4" role="status">
          <Icon name="calendar" />
          <span>
            {firstDay
              ? t('subscribe.firstVisit', { date: calendarDay(firstDay), window: t(`subscribe.windowShort.${timeWindow}`) })
              : days.length === 0
                ? t('subscribe.firstVisitPick')
                : t('subscribe.noFirstVisit')}
          </span>
        </p>

        <fieldset className="stack tight">
          <legend className="h-sm">{t('subscribe.where')}</legend>
          <div className="field">
            <label htmlFor="sub-address">{t('book.address')}</label>
            <input
              id="sub-address"
              autoComplete="street-address"
              required
              maxLength={200}
              value={address}
              {...form.describe('address')}
              onChange={(e) => setAddress(e.target.value)}
            />
            <FieldError id="sub-address" message={form.message('address')} />
          </div>
          <div className="field">
            <label htmlFor="sub-postcode">{t('book.postcode')}</label>
            <select id="sub-postcode" required value={postcode} {...form.describe('postcode')} onChange={(e) => setPostcode(e.target.value)}>
              <option value="">{t('book.choosePostcode')}</option>
              {postcodes.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
            <FieldError id="sub-postcode" message={form.message('postcode')} />
          </div>
          <div className="field">
            <label htmlFor="sub-notes">{t('book.notes')}</label>
            <textarea id="sub-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </fieldset>

        <PaymentOptionList methods={methods} option={option} onChange={setOption} unavailable={unavailable} legend={t('subscribe.payWith')} />

        <section className="sumbox" aria-label={t('subscribe.summary')}>
          <div className="row between">
            <div>
              <p className="sub">{t('subscribe.monthly')}</p>
              <p className="big-price" aria-live="polite">
                {euro(total)}
                <span className="small">{t('admin.plans.perMonthSuffix')}</span>
              </p>
            </div>
            <p className="right">
              <span className="sub block">{t('subscribe.about')}</span>
              <span className="b block">{euro(perVisit)}</span>
              <span className="sub block">{t('subscribe.perVisit')}</span>
            </p>
          </div>
          <ul className="small sub stack tight">
            <li>✓ {t('subscribe.regularPro', { visits })}</li>
            <li>✓ {plan.seasonal ? t('subscribe.seasonLine', { season: seasonText(t, plan) }) : t('subscribe.allYear')}</li>
            <li>✓ {t('subscribe.skipsLine', { count: SKIPS_PER_MONTH })}</li>
            <li>✓ {rules.pause}</li>
            <li>✓ {rules.term}</li>
            <li>✓ {t('subscribe.firstCharge')}</li>
          </ul>
        </section>

        <div className={`addon ${agreed ? 'on' : ''}`}>
          <input
            id={termsId}
            type="checkbox"
            aria-labelledby={`${agreeId} ${termsLinkId}`}
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span className="small grow">
            <label id={agreeId} htmlFor={termsId}>
              {t('subscribe.agree')}
            </label>{' '}
            <button id={termsLinkId} type="button" className="link" aria-haspopup="dialog" onClick={() => setShowTerms(true)}>
              {t('subscribe.termsLink')}
            </button>
          </span>
        </div>

        {offSeason && (
          <p className="info amber" role="status">
            {t('subscribe.offSeason')}
          </p>
        )}
        <ErrorText error={error} />
      </div>
      <div className="cta-bar">
        {ready && wallet && key ? (
          unavailable.includes(wallet) ? (
            <button className="cta" type="button" disabled>
              {t('review.walletUnavailable')}
            </button>
          ) : (
            <WalletButton
              key={wallet}
              publishableKey={key}
              wallet={wallet}
              amountCents={total}
              purpose="subscription"
              onApproved={async () => {
                if (!form.check()) throw new Error(t('subscribe.checkDetails'));
                const created = await createPlan();
                walletPlan.current = created.subscription;
                return created.payment?.clientSecret ?? null;
              }}
              onDone={() => {
                if (walletPlan.current) void showDone(walletPlan.current);
              }}
              onUnavailable={() => setUnavailable((current) => (current.includes(wallet) ? current : [...current, wallet]))}
            />
          )
        ) : (
          <button className="cta" type="submit" disabled={busy || !ready}>
            <Icon name="repeat" /> {ctaText}
          </button>
        )}
      </div>
      {showTerms && <TermsSheet plan={plan} onClose={() => setShowTerms(false)} />}
    </form>
  );
}

/** The Plan builder page: the plans, served postcodes, ways to pay and the selected address. */
export function SubscribePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(
    () =>
      Promise.all([
        api.get<{ plans: PublicPlan[] }>('/plans'),
        api.get<{ postcodes: Postcode[] }>('/postcodes'),
        api.get<PaymentMethods>('/payment-methods'),
        // The address selected on Home (D89) fills in where; without it the customer types one.
        api.get<{ addresses: SavedAddress[] }>('/addresses').catch((error: unknown) => {
          console.warn('Could not load the saved addresses', error);
          return { addresses: [] as SavedAddress[] };
        }),
      ]),
    [api],
  );
  const { state, reload } = useResource(load);
  return (
    <ResourceState state={state} reload={reload}>
      {([{ plans }, { postcodes }, methods, { addresses }]) => {
        const plan = plans.find((p) => p.id === id);
        if (!plan) {
          return <Navigate to="/plans" replace />;
        }
        const selected = addresses.find((a) => a.selected && a.served) ?? null;
        return (
          <>
            <AppHeader title={t('subscribe.title')} back="/plans" />
            {/* A new plan starts a fresh builder: its own frequency, no extra, the days picked again. */}
            <Builder key={plan.id} plans={plans} plan={plan} postcodes={postcodes} methods={methods} address={selected} />
          </>
        );
      }}
    </ResourceState>
  );
}
