import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { Plan, Subscription } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { euro } from '../../lib/format';
import { AppHeader } from '../../shells/Shells';
import { CATEGORY_COLORS } from './categoryColors';

/** The customer's Plans tab: their own plans first, then every plan they can subscribe to. */
export function CustomerPlansPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(
    () => Promise.all([api.get<{ plans: Plan[] }>('/plans'), api.get<{ subscriptions: Subscription[] }>('/subscriptions')]),
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
                <section aria-labelledby="mine-heading" className="stack">
                  <h2 id="mine-heading" className="h-sm">
                    {t('plans.mine')}
                  </h2>
                  {subscriptions.map((s) => (
                    <Link key={s.id} to={`/my-plans/${s.id}`} className="card row link-card">
                      <span className="grow">
                        <span className="b block">{s.planName}</span>
                        <span className="small muted">{t('plans.perMonth', { price: euro(s.priceCents) })}</span>
                      </span>
                      <span className={`badge ${s.status === 'active' && !s.endsAt ? 'g' : 'grey'}`}>
                        {s.endsAt && s.status === 'active' ? t('subscription.status.ending') : t(`subscription.status.${s.status}`)}
                      </span>
                    </Link>
                  ))}
                </section>
              )}
              <p className="muted small">{t('plans.intro')}</p>
              {plans.length === 0 ? (
                <p className="card muted">{t('plans.none')}</p>
              ) : (
                <ul className="stack">
                  {plans.map((plan) => {
                    const color = CATEGORY_COLORS[plan.categoryIcon ?? 'leaf'];
                    return (
                      <li key={plan.id}>
                        <Link to={`/plans/${plan.id}`} className="card row link-card">
                          <span className="ci" style={{ background: color.bg, color: color.fg }}>
                            <Icon name={plan.categoryIcon ?? 'leaf'} />
                          </span>
                          <span className="grow">
                            <span className="b block">{plan.name}</span>
                            <span className="small muted">
                              {t(`admin.plans.frequency.${plan.frequency}`)} · {plan.tasks.join(' · ')}
                            </span>
                          </span>
                          <span className="price">{t('plans.from', { price: euro(Math.round((plan.priceCents ?? 0) * 0.85)) })}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
