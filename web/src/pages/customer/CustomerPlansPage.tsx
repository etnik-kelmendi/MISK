import type { TFunction } from 'i18next';
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { PublicPlan, Subscription } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dayName, euro } from '../../lib/format';
import { SKIPS_PER_MONTH, seasonText } from '../../lib/plans';
import { AppHeader } from '../../shells/Shells';
import { CATEGORY_COLORS } from './categoryColors';
import { openPause } from './PlanPause';

type View = 'cards' | 'table';

/** How a customer's plan stands, as its badge says it (D90): Active, Paused, Ending, or a payment state. */
export function planStatus(subscription: Subscription): { label: 'active' | 'paused' | 'ending' | Subscription['status']; tone: string } {
  const running = subscription.status === 'active' || subscription.status === 'past_due';
  if (running && subscription.endsAt) return { label: 'ending', tone: 'r' };
  if (subscription.status === 'active' && openPause(subscription)?.status === 'running') return { label: 'paused', tone: 'grey' };
  if (subscription.status === 'active') return { label: 'active', tone: 'g' };
  return { label: subscription.status, tone: subscription.status === 'past_due' ? 'r' : 'grey' };
}

/** The pause rule of one plan in a few words: "up to 4 weeks a year, 7 days' notice", or "not allowed". */
function pauseShort(t: TFunction, plan: PublicPlan): string {
  if (plan.maxPauseWeeks === 0) return t('plans.pauseNone');
  const notice = plan.pauseNoticeDays === 0 ? t('planRules.noticeNone') : t('planRules.notice', { count: plan.pauseNoticeDays });
  return t('plans.pauseShort', { count: plan.maxPauseWeeks, notice });
}

/**
 * The box under the plans (D90): what every plan includes, with each plan's own minimum term and pause rules from
 * the control panel, given once when all plans share them and per plan where they differ.
 */
function IncludedBox({ plans }: { plans: PublicPlan[] }) {
  const { t } = useTranslation();
  const terms = new Set(plans.map((plan) => plan.minTermMonths));
  const pauses = new Set(plans.map((plan) => pauseShort(t, plan)));
  const [first] = plans;
  const termLine =
    terms.size === 1 && first
      ? t('plans.includes.termSame', { count: first.minTermMonths })
      : t('plans.includes.termEach', {
          list: plans.map((plan) => `${plan.name ?? ''}: ${t('plans.termMonths', { count: plan.minTermMonths })}`).join(' · '),
        });
  const pauseLine =
    pauses.size === 1 && first
      ? first.maxPauseWeeks === 0
        ? t('plans.includes.pauseNone')
        : t('plans.includes.pauseSame', { rule: pauseShort(t, first) })
      : t('plans.includes.pauseEach', { list: plans.map((plan) => `${plan.name ?? ''}: ${pauseShort(t, plan)}`).join(' · ') });
  return (
    <section className="card included-box" aria-labelledby="included-heading">
      <h2 id="included-heading" className="b small">
        {t('plans.includes.title')}
      </h2>
      <ul className="small stack tight">
        <li>✓ {t('plans.includes.samePro')}</li>
        <li>✓ {t('plans.includes.skips', { count: SKIPS_PER_MONTH })}</li>
        <li>✓ {pauseLine}</li>
        <li>✓ {termLine}</li>
        <li>✓ {t('plans.includes.oneCharge')}</li>
      </ul>
    </section>
  );
}

function PlanIcon({ plan }: { plan: { categoryIcon: PublicPlan['categoryIcon'] } }) {
  const icon = plan.categoryIcon ?? 'leaf';
  const color = CATEGORY_COLORS[icon];
  return (
    <span className="ci plan-icon" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
      <Icon name={icon} />
    </span>
  );
}

const extrasText = (t: TFunction, plan: PublicPlan) => (plan.addonName ? plan.addonName : t('plans.noExtras'));

/** "All plans": one card per plan with its price, how often, season, tasks, extras and Choose. */
function PlanCards({ plans }: { plans: PublicPlan[] }) {
  const { t } = useTranslation();
  return (
    <ul className="stack">
      {plans.map((plan) => (
        <li key={plan.id} className="card plan-offer">
          <div className="row">
            <PlanIcon plan={plan} />
            <div className="grow">
              <h3 className="b">{plan.name}</h3>
              <p className="tiny muted">
                {t(`admin.plans.frequency.${plan.frequency}`)} · {seasonText(t, plan)}
              </p>
            </div>
            <p className="right">
              <span className="tiny muted block">{t('plans.fromLabel')}</span>
              <span className="b plan-price">
                {euro(plan.fromCents)}
                <span className="tiny muted">{t('plans.perMonthShort')}</span>
              </span>
            </p>
          </div>
          <ul className="small stack tight plan-tasks" aria-label={t('plans.eachVisitLabel', { name: plan.name })}>
            {plan.tasks.map((task) => (
              <li key={task} className="row gap4">
                <Icon name="check" /> {task}
              </li>
            ))}
          </ul>
          <p className="tiny muted">{t('plans.extras', { extras: extrasText(t, plan) })}</p>
          <Link to={`/plans/${plan.id}`} className="cta plan-choose">
            {t('plans.choose', { name: (plan.name ?? '').toLowerCase() })} <Icon name="arrowR" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** "Compare side by side": every plan in a table, one column per plan, scrolling sideways on a phone. */
function CompareTable({ plans }: { plans: PublicPlan[] }) {
  const { t } = useTranslation();
  const rows: { label: string; value: (plan: PublicPlan) => ReactNode }[] = [
    { label: t('plans.rows.from'), value: (plan) => <b>{t('plans.from', { price: euro(plan.fromCents) })}</b> },
    { label: t('plans.rows.howOften'), value: (plan) => t(`admin.plans.frequency.${plan.frequency}`) },
    { label: t('plans.rows.season'), value: (plan) => seasonText(t, plan) },
    { label: t('plans.rows.eachVisit'), value: (plan) => plan.tasks.join(', ') },
    { label: t('plans.rows.extras'), value: (plan) => (plan.addonName ? `${plan.addonName} (+${euro(plan.addonPriceCents ?? 0)}${t('plans.perMonthShort')})` : t('plans.noExtras')) },
    { label: t('plans.rows.term'), value: (plan) => t('plans.termMonths', { count: plan.minTermMonths }) },
    { label: t('plans.rows.pause'), value: (plan) => pauseShort(t, plan) },
  ];
  return (
    <>
      {/* Focusable, so the table can be scrolled sideways with the keyboard too (a scrollable region). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="table-scroll" role="region" aria-labelledby="compare-caption" tabIndex={0}>
        <table className="ctable">
          <caption id="compare-caption" className="visually-hidden">
            {t('plans.compareCaption')}
          </caption>
          <thead>
            <tr>
              <td />
              {plans.map((plan) => (
                <th key={plan.id} scope="col">
                  <PlanIcon plan={plan} />
                  <span className="block">{plan.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {plans.map((plan) => (
                  <td key={plan.id}>{row.value(plan)}</td>
                ))}
              </tr>
            ))}
            <tr>
              <td />
              {plans.map((plan) => (
                <td key={plan.id}>
                  <Link to={`/plans/${plan.id}`} className="mini-btn green" aria-label={t('plans.choose', { name: (plan.name ?? '').toLowerCase() })}>
                    {t('plans.chooseShort')}
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="tiny muted">{t('plans.swipe')}</p>
    </>
  );
}

/** The customer's own plan at the top of Plans (D90), opening My plan. */
function MyPlanCard({ subscription }: { subscription: Subscription }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const status = planStatus(subscription);
  return (
    <Link to={`/my-plans/${subscription.id}`} className="card row link-card my-plan-card">
      <PlanIcon plan={{ categoryIcon: subscription.categoryIcon ?? null }} />
      <span className="grow">
        <span className="tiny muted block">{t('plans.myPlan')}</span>
        <span className="b block">{subscription.planName}</span>
        <span className="small muted block">
          {t('plans.perMonth', { price: euro(subscription.priceCents) })}
          {subscription.nextVisitAt && ` · ${t('plans.nextVisit', { date: dayName(subscription.nextVisitAt, timezone) })}`}
        </span>
      </span>
      <span className={`badge ${status.tone}`}>{t(`subscription.status.${status.label}`)}</span>
      <Icon name="chevR" />
    </Link>
  );
}

/** The customer's Plans page (D90): their plan first, then every published plan as cards or side by side. */
export function CustomerPlansPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [view, setView] = useState<View>('cards');
  const load = useCallback(
    () => Promise.all([api.get<{ plans: PublicPlan[] }>('/plans'), api.get<{ subscriptions: Subscription[] }>('/subscriptions')]),
    [api],
  );
  const { state, reload } = useResource(load);

  return (
    <>
      <AppHeader title={t('plans.title')} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {([{ plans }, { subscriptions }]) => (
            <>
              {subscriptions.length > 0 && (
                <section aria-label={t('plans.myPlan')} className="stack">
                  {subscriptions.map((s) => (
                    <MyPlanCard key={s.id} subscription={s} />
                  ))}
                </section>
              )}
              <p className="muted small">{t('plans.intro')}</p>
              {plans.length === 0 ? (
                <p className="card muted">{t('plans.none')}</p>
              ) : (
                <>
                  <div className="seg" role="group" aria-label={t('plans.view')}>
                    {(['cards', 'table'] as const).map((v) => (
                      <button key={v} type="button" className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
                        {t(`plans.views.${v}`)}
                      </button>
                    ))}
                  </div>
                  {view === 'table' ? <CompareTable plans={plans} /> : <PlanCards plans={plans} />}
                  <IncludedBox plans={plans} />
                </>
              )}
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
