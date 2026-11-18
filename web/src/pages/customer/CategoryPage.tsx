import type { TFunction } from 'i18next';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { Category, Plan, Service } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { euro, PACKAGE_DISCOUNT_PCT } from '../../lib/format';
import { planRuleTexts, planSizePrice } from '../../lib/plans';
import { AppHeader } from '../../shells/Shells';
import { CATEGORY_COLORS } from './categoryColors';

type Mode = 'one' | 'plan';

/** The lowest price of a service: its base price, or for hourly work its rate times its usual length. */
function fromCents(service: Service): number {
  return service.pricing === 'hourly' ? Math.round((service.priceCents * service.durationMinutes) / 60) : service.priceCents;
}

/** The lowest price of the ticked services together, with the package discount for two or more (D68). */
export function packageFromCents(services: Service[]): number {
  const sum = services.reduce((total, service) => total + fromCents(service), 0);
  return services.length > 1 ? sum - Math.round((sum * PACKAGE_DISCOUNT_PCT) / 100) : sum;
}

/** Services (D68): a trade's services to tick for one visit, or its monthly plans. */
export function CategoryPage() {
  const { slug } = useParams();
  const market = useMarket();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const category = market.categories.find((c) => c.slug === slug);
  const mode: Mode = params.get('mode') === 'plan' ? 'plan' : 'one';

  if (!category) {
    return <Navigate to="/" replace />;
  }
  return (
    <>
      <AppHeader title={category.name} back="/" />
      <CategoryView
        category={category}
        mode={mode}
        initial={params.get('service')}
        onMode={(next) => setParams(next === 'plan' ? { mode: 'plan' } : {}, { replace: true })}
        onContinue={(services) => navigate(`/book?services=${services.map((s) => s.id).join(',')}`)}
      />
    </>
  );
}

/** The month names of a season, e.g. "March to October". */
function seasonText(plan: Plan, t: TFunction): string {
  if (!plan.seasonal || plan.seasonFrom === null || plan.seasonTo === null) return t('services.allYear');
  const month = (m: number) => new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m - 1, 1)));
  return t('services.season', { from: month(plan.seasonFrom), to: month(plan.seasonTo) });
}

function PlanList({ category }: { category: Category }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ plans: Plan[] }>('/plans'), [api]);
  const { state, reload } = useResource(load);
  const [chosen, setChosen] = useState<string | null>(null);
  const color = CATEGORY_COLORS[category.icon];

  return (
    <ResourceState state={state} reload={reload}>
      {({ plans: all }) => {
        const plans = all.filter((plan) => plan.categoryId === category.id);
        if (plans.length === 0) {
          return (
            <>
              <div className="card center stack no-plans">
                <p className="b">{t('services.noPlans', { trade: category.name })}</p>
                <p className="small muted">{t('services.noPlansText')}</p>
                <Link to="/plans" className="mini-btn green self-center">
                  {t('services.seeAllPlans')}
                </Link>
              </div>
            </>
          );
        }
        const plan = plans.find((p) => p.id === chosen) ?? null;
        return (
          <>
            <fieldset className="choices">
              <legend className="h-sm">{t('services.choosePlan')}</legend>
              {plans.map((p) => (
                <label key={p.id} className={`pcard ${chosen === p.id ? 'on' : ''}`} aria-label={p.name ?? ''}>
                  <input type="radio" name="plan" className="visually-hidden" checked={chosen === p.id} onChange={() => setChosen(p.id)} />
                  <span className="row">
                    <span className="ci" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
                      <Icon name={category.icon} />
                    </span>
                    <span className="grow">
                      <span className="b block">{p.name}</span>
                      <span className="tiny muted block">{t('services.planFrom', { price: euro(planSizePrice(p.priceCents ?? 0, 'S')) })}</span>
                    </span>
                    <span className="radio" aria-hidden="true" />
                  </span>
                  <dl className="kv">
                    <dt>{t('services.howOften')}</dt>
                    <dd className="b">{t('services.howOftenValue', { frequency: t(`admin.plans.frequency.${p.frequency}`) })}</dd>
                    <dt>{t('services.eachVisit')}</dt>
                    <dd>{p.tasks.join(', ')}</dd>
                    <dt>{t('services.seasonLabel')}</dt>
                    <dd>{seasonText(p, t)}</dd>
                    <dt>{t('services.yourPro')}</dt>
                    <dd>{t('services.samePro')}</dd>
                    <dt>{t('services.contract')}</dt>
                    <dd>{planRuleTexts(t, p).term}</dd>
                    <dt>{t('services.pause')}</dt>
                    <dd>{planRuleTexts(t, p).pause}</dd>
                  </dl>
                </label>
              ))}
            </fieldset>
            <p className="tiny muted center">{t('services.planNext')}</p>
            <div className="cta-bar">
              {plan ? (
                <Link to={`/plans/${plan.id}`} className="cta">
                  {t('services.customise', { name: plan.name })} <Icon name="arrowR" />
                </Link>
              ) : (
                <button className="cta" type="button" disabled>
                  {t('services.pickPlan')}
                </button>
              )}
            </div>
          </>
        );
      }}
    </ResourceState>
  );
}

/**
 * A trade's screen in the customer app: its pros, the services to tick, and its monthly plans. Also the
 * admin preview, which shows the services only.
 */
export function CategoryView({
  category,
  mode = 'one',
  initial = null,
  onMode,
  onContinue,
}: {
  category: Category;
  mode?: Mode;
  /** A service already ticked, e.g. from a search result. */
  initial?: string | null;
  /** Without it there is no one-off / plan switch (the admin preview). */
  onMode?: (mode: Mode) => void;
  onContinue: (services: Service[]) => void;
}) {
  const { t } = useTranslation();
  const [ticked, setTicked] = useState<string[]>(() => (initial && category.services.some((s) => s.id === initial) ? [initial] : []));
  const color = CATEGORY_COLORS[category.icon];
  // Ticked services in the order of the list.
  const chosen = category.services.filter((s) => ticked.includes(s.id));
  const n = chosen.length;
  const from = packageFromCents(chosen);
  const onlyHourly = n === 1 && chosen[0]?.pricing === 'hourly';

  function toggle(id: string) {
    setTicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  return (
    <>
      <div className="body">
        <div className="card row" style={{ background: color.bg, boxShadow: 'none' }}>
          <span className="ci" style={{ background: '#fff', color: color.fg }}>
            <Icon name={category.icon} />
          </span>
          <div>
            <p className="b">{t('category.pros', { count: category.approvedPros })}</p>
            <p className="small muted">{t('category.checked')}</p>
          </div>
        </div>
        {onMode && (
          <div className="seg seg-full" role="group" aria-label={t('services.kind')}>
            <button type="button" className={mode === 'one' ? 'on' : ''} aria-pressed={mode === 'one'} onClick={() => onMode('one')}>
              {t('services.oneOff')}
            </button>
            <button type="button" className={mode === 'plan' ? 'on' : ''} aria-pressed={mode === 'plan'} onClick={() => onMode('plan')}>
              {t('services.monthly')} <Icon name="repeat" />
            </button>
          </div>
        )}
        {mode === 'plan' && onMode ? (
          <PlanList category={category} />
        ) : (
          <>
            <fieldset className="choices">
              <legend className="h-sm">{t('category.choose')}</legend>
              {category.services.length === 0 && <p className="muted">{t('category.noServices')}</p>}
              {category.services.map((service) => {
                const on = ticked.includes(service.id);
                return (
                  <label key={service.id} className={`svc ${on ? 'on' : ''}`}>
                    <input type="checkbox" className="visually-hidden" checked={on} onChange={() => toggle(service.id)} />
                    <span className={`cbox ${on ? 'on' : ''}`} aria-hidden="true">
                      {on && <Icon name="check" />}
                    </span>
                    <span className="grow">
                      <span className="b block">
                        {service.name} {service.isNew && <span className="badge g">{t('category.new')}</span>}
                      </span>
                      {service.description && <span className="small muted block">{service.description}</span>}
                      <span className="tiny muted row gap4">
                        <Icon name="clock" /> {t('category.duration', { minutes: service.durationMinutes })}
                      </span>
                    </span>
                    <span className="price">
                      {service.pricing === 'hourly'
                        ? t('category.perHour', { price: euro(service.priceCents) })
                        : t('category.from', { price: euro(service.priceCents) })}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {category.services.length > 1 &&
              (n > 1 ? (
                <p className="info" role="status">
                  <Icon name="tag" />
                  <span>
                    <b>{t('services.packageTitle', { pct: PACKAGE_DISCOUNT_PCT })}</b> {t('services.packageText', { count: n })}
                  </span>
                </p>
              ) : (
                <p className="tiny muted center row gap4 center-row">
                  <Icon name="tag" /> {t('services.packageHint', { pct: PACKAGE_DISCOUNT_PCT })}
                </p>
              ))}
          </>
        )}
      </div>
      {!(mode === 'plan' && onMode) && (
        <div className="cta-bar">
          <button className="cta" type="button" disabled={n === 0} onClick={() => n > 0 && onContinue(chosen)}>
            {n === 0
              ? t('category.pickOne')
              : onlyHourly && chosen[0]
                ? t('category.continuePerHour', { price: euro(chosen[0].priceCents) })
                : n > 1
                  ? t('services.continuePackage', { count: n, price: euro(from) })
                  : t('category.continueFrom', { price: euro(from) })}
          </button>
        </div>
      )}
    </>
  );
}
