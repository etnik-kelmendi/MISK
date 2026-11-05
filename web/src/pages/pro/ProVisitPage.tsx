import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { ProPlan, ProVisit } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { AppHeader } from '../../shells/Shells';

/** One visit of a monthly plan: the pro ticks off the plan's tasks and completes it. */
function VisitView({ visit, onDone }: { visit: ProVisit; onDone: (v: ProVisit) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [done, setDone] = useState<string[]>(visit.tasksDone);
  const { run, busy, error } = useAction();
  const completed = visit.status === 'completed';

  async function complete() {
    const result = await run(() => api.post<{ visit: Pick<ProVisit, 'status' | 'tasksDone'> }>(`/pro/visits/${visit.id}/complete`, { tasksDone: done }));
    if (result) {
      onDone({ ...visit, ...result.visit });
    }
  }

  return (
    <>
      <div className="body">
        <div className="card">
          <div className="row between">
            <h2 className="b">{visit.planName}</h2>
            <span className="badge a">
              <Icon name="repeat" /> {t('visit.plan')}
            </span>
          </div>
          <p className="small muted">
            {dateTime(visit.startsAt, timezone)} · {visit.address}, {visit.postcode}
          </p>
          <p className="small">{t('job.customer', { name: visit.customerName ?? '' })}</p>
          {visit.notes && <p className="small">“{visit.notes}”</p>}
          <p className="small muted">{t('visit.earns', { amount: euro(visit.earningsCents) })}</p>
        </div>
        <fieldset className="card stack" disabled={completed}>
          <legend className="b small">{t('visit.checklist')}</legend>
          {visit.tasks.map((task) => (
            <label key={task} className="row small check-row">
              <input
                type="checkbox"
                checked={done.includes(task)}
                onChange={() => setDone((current) => (current.includes(task) ? current.filter((x) => x !== task) : [...current, task]))}
              />
              {task}
            </label>
          ))}
        </fieldset>
        {completed && (
          <p className="info" role="status">
            <Icon name="check" /> {t('visit.completed')}
          </p>
        )}
        <ErrorText error={error} />
      </div>
      {!completed && visit.status === 'planned' && (
        <div className="cta-bar">
          <button type="button" className="cta dark" disabled={busy} onClick={() => void complete()}>
            <Icon name="check" /> {done.length === visit.tasks.length ? t('visit.complete') : t('visit.completePartly', { done: done.length, total: visit.tasks.length })}
          </button>
        </div>
      )}
    </>
  );
}

export function ProVisitPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ visit: ProVisit }>(`/pro/visits/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  return (
    <>
      <AppHeader title={t('visit.title')} back="/pro/week" />
      <ResourceState state={state} reload={reload}>
        {({ visit }) => <VisitView visit={visit} onDone={(next) => update(() => ({ visit: next }))} />}
      </ResourceState>
    </>
  );
}

/** Published plans in the pro's trades, with what each pays them and how many of their customers have it. */
export function ProPlansSection() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ plans: ProPlan[] }>('/pro/plans'), [api]);
  const { state, reload } = useResource(load);
  return (
    <section aria-labelledby="pro-plans-heading">
      <h2 id="pro-plans-heading" className="h-sm">
        {t('proPlans.title')}
      </h2>
      <ResourceState state={state} reload={reload}>
        {({ plans }) =>
          plans.length === 0 ? (
            <p className="small muted">{t('proPlans.none')}</p>
          ) : (
            <ul className="stack">
              {plans.map((plan) => (
                <li key={plan.id} className="job">
                  <span className="grow">
                    <span className="b small block">{plan.name}</span>
                    <span className="tiny muted">
                      {t(`admin.plans.frequency.${plan.frequency}`)} · {plan.tasks.join(', ')}
                    </span>
                  </span>
                  <span className="right">
                    <span className="b small block">{t('proPlans.earns', { amount: euro(plan.earningsPerMonthCents) })}</span>
                    <span className="tiny muted">{t('proPlans.mine', { count: plan.mySubscribers })}</span>
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </ResourceState>
      <p className="tiny muted">
        <Link to="/pro/week">{t('proPlans.seeWeek')}</Link>
      </p>
    </section>
  );
}
