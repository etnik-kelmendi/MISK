import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { PaymentStep, Subscription } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, dayParts, euro, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { CardPayment } from '../../payments/CardPayment';
import { AppHeader } from '../../shells/Shells';

function FinishPayment({ subscription, onConfirmed }: { subscription: Subscription; onConfirmed: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ payment: PaymentStep | null }>(`/subscriptions/${subscription.id}/payment`), [api, subscription.id]);
  const { state, reload } = useResource(load);
  return (
    <section aria-label={t('pay.title')}>
      <h2 className="h-sm">{t('pay.finish')}</h2>
      <ResourceState state={state} reload={reload}>
        {({ payment }) =>
          payment ? (
            <CardPayment payment={payment} amountLabel={t('plans.perMonth', { price: euro(subscription.priceCents) })} onConfirmed={onConfirmed} />
          ) : (
            <p className="muted" role="status">
              {t('pay.checking')}
            </p>
          )
        }
      </ResourceState>
    </section>
  );
}

function PlanView({ subscription, onChanged, reload }: { subscription: Subscription; onChanged: (s: Subscription) => void; reload: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const visitAction = useAction();
  const cancel = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const ending = subscription.status === 'active' && subscription.endsAt !== null;
  const canCancel =
    subscription.status === 'active' && !ending && subscription.cancelableFrom !== null && new Date(subscription.cancelableFrom) <= new Date();
  const upcoming = subscription.visits.filter((v) => new Date(v.startsAt) > new Date() && v.status !== 'cancelled');

  async function visit(id: string, action: 'skip' | 'unskip') {
    const result = await visitAction.run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/visits/${id}/${action}`));
    if (result) {
      onChanged(result.subscription);
    }
  }

  return (
    <div className="body">
      <div className="card plan-card">
        <div className="row between">
          <h2 className="b">{subscription.planName}</h2>
          <span className={`badge ${subscription.status === 'active' && !ending ? 'g' : 'grey'}`}>
            {ending ? t('subscription.status.ending') : t(`subscription.status.${subscription.status}`)}
          </span>
        </div>
        <p className="small muted">
          {t(`admin.plans.frequency.${subscription.frequency}`)} · {subscription.days.map((d) => t(`weekday.${d as 1 | 2 | 3 | 4 | 5 | 6 | 7}`)).join(' & ')} ·{' '}
          {t(`subscribe.windows.${subscription.timeWindow}`)}
        </p>
        <p className="b">{t('plans.perMonth', { price: euro(subscription.priceCents) })}</p>
        {subscription.proName && (
          <p className="small row gap4">
            <Icon name="user" /> {t('subscription.regularPro', { name: subscription.proName })}
          </p>
        )}
        {subscription.withAddon && subscription.addonName && <p className="small">{t('subscription.withExtra', { extra: subscription.addonName })}</p>}
        {subscription.currentPeriodEnd && !ending && (
          <p className="small muted row gap4">
            <Icon name="card" />{' '}
            {subscription.billingPaused
              ? t('subscription.seasonPaused')
              : t('subscription.nextCharge', { date: dateTime(subscription.currentPeriodEnd, timezone) })}
          </p>
        )}
        {ending && subscription.endsAt && <p className="small">{t('subscription.endsOn', { date: dateTime(subscription.endsAt, timezone) })}</p>}
      </div>

      {subscription.status === 'awaiting_payment' && <FinishPayment subscription={subscription} onConfirmed={reload} />}
      {subscription.status === 'past_due' && (
        <p className="info amber" role="alert">
          {t('subscription.pastDue')}
        </p>
      )}

      {subscription.status !== 'awaiting_payment' && subscription.status !== 'cancelled' && (
        <section aria-labelledby="visits-heading">
          <div className="row between">
            <h2 id="visits-heading" className="h-sm">
              {t('subscription.upcoming')}
            </h2>
            <span className="small muted">{t('subscription.skipsLeft', { count: subscription.skipsLeftThisMonth })}</span>
          </div>
          {upcoming.length === 0 ? (
            <p className="card small muted">{subscription.billingPaused ? t('subscription.noVisitsWinter') : t('subscription.noVisits')}</p>
          ) : (
            <ul className="stack">
              {upcoming.map((v) => {
                const parts = dayParts(v.startsAt, timezone);
                const skipped = v.status === 'skipped';
                return (
                  <li key={v.id} className={`visit ${skipped ? 'skipped' : ''}`}>
                    <span className="vd">
                      <span className="small muted block">{parts.weekday}</span>
                      <span className="b big block">{parts.day}</span>
                      <span className="tiny muted block">{parts.month}</span>
                    </span>
                    <span className="grow">
                      <span className="b small block">{time(v.startsAt, timezone)}</span>
                      <span className="tiny muted">{skipped ? t('subscription.skipped') : subscription.tasks.slice(0, 3).join(', ')}</span>
                    </span>
                    {skipped ? (
                      <button type="button" className="mini-btn" disabled={visitAction.busy} onClick={() => void visit(v.id, 'unskip')}>
                        {t('subscription.undo')}
                      </button>
                    ) : (
                      <button type="button" className="mini-btn" disabled={visitAction.busy} onClick={() => void visit(v.id, 'skip')}>
                        {t('subscription.skip')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <ErrorText error={visitAction.error} />
        </section>
      )}

      {subscription.status === 'active' && !ending && (
        <section className="stack">
          {canCancel ? (
            confirmCancel ? (
              <div className="card" role="alertdialog" aria-labelledby="cancel-plan">
                <p id="cancel-plan">{t('subscription.cancelQuestion')}</p>
                <div className="row gap8">
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>
                    {t('booking.keep')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={cancel.busy}
                    onClick={() =>
                      void cancel
                        .run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/cancel`))
                        .then((result) => result && onChanged(result.subscription))
                    }
                  >
                    {t('subscription.cancelConfirm')}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="link danger" onClick={() => setConfirmCancel(true)}>
                {t('subscription.cancel')}
              </button>
            )
          ) : (
            subscription.cancelableFrom && (
              <p className="small muted">{t('subscription.cancelFrom', { date: dateTime(subscription.cancelableFrom, timezone) })}</p>
            )
          )}
          <ErrorText error={cancel.error} />
        </section>
      )}
    </div>
  );
}

export function MyPlanPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ subscription: Subscription }>(`/subscriptions/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  // Picks up the first payment going through.
  usePolling(reload, 8_000, state.status === 'ready' && state.data.subscription.status === 'awaiting_payment');
  return (
    <>
      <AppHeader title={t('subscription.title')} back="/plans" />
      <ResourceState state={state} reload={reload}>
        {({ subscription }) => <PlanView subscription={subscription} reload={reload} onChanged={(next) => update(() => ({ subscription: next }))} />}
      </ResourceState>
    </>
  );
}
