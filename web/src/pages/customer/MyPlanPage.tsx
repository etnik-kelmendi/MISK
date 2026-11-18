import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { PaymentStep, Subscription, SubscriptionVisit, VisitMoveOptions } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { Sheet } from '../../components/Sheet';
import { dateTime, dayParts, euro, longDate, time } from '../../lib/format';
import { planRuleTexts } from '../../lib/plans';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { CardPayment } from '../../payments/CardPayment';
import { AppHeader } from '../../shells/Shells';
import { PlanPause } from './PlanPause';

/** After the minimum term a plan ends this many days after the customer cancels (D77). */
const CANCEL_NOTICE_DAYS = 30;

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

/**
 * Move one visit (D77): the other days of the same week when the pro is free at the same time, or why the
 * visit cannot move. The pro confirms the new day; until then the visit keeps its time.
 */
function MoveSheet({
  subscription,
  visit,
  onClose,
  onRequested,
}: {
  subscription: Subscription;
  visit: SubscriptionVisit;
  onClose: () => void;
  onRequested: (next: Subscription) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const pro = subscription.proName ?? t('subscription.yourPro');
  const load = useCallback(
    () => api.get<VisitMoveOptions>(`/subscriptions/${subscription.id}/visits/${visit.id}/move-options`),
    [api, subscription.id, visit.id],
  );
  const { state, reload } = useResource(load);
  const [chosen, setChosen] = useState<string | null>(null);
  const { run, busy, error } = useAction();

  async function send() {
    if (!chosen) return;
    const result = await run(() =>
      api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/visits/${visit.id}/move`, { startsAt: chosen }),
    );
    if (result) onRequested(result.subscription);
  }

  const hasOptions = state.status === 'ready' && state.data.options.length > 0;
  return (
    <Sheet
      title={t('subscription.moveTitle')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        hasOptions && (
          <button type="button" className="cta" disabled={busy || !chosen} onClick={() => void send()}>
            {t('subscription.moveSend', { pro })}
          </button>
        )
      }
    >
      <div className="stack">
        <p className="small muted">{t('subscription.moveNow', { date: dateTime(visit.startsAt, timezone) })}</p>
        <ResourceState state={state} reload={reload}>
          {({ options, reason }) =>
            reason || options.length === 0 ? (
              <p className="info amber" role="status">
                {t(`subscription.moveReasons.${reason ?? 'no_free_day'}`, { pro })}
              </p>
            ) : (
              <>
                <p className="small">{t('subscription.moveIntro', { pro, time: time(visit.startsAt, timezone) })}</p>
                <fieldset className="choices">
                  <legend className="h-sm">{t('subscription.moveChoose')}</legend>
                  {options.map((option) => (
                    <label key={option.startsAt} className={`choice ${chosen === option.startsAt ? 'on' : ''}`}>
                      <input
                        type="radio"
                        name="move-day"
                        checked={chosen === option.startsAt}
                        onChange={() => setChosen(option.startsAt)}
                      />
                      <span className="b">{dateTime(option.startsAt, timezone)}</span>
                    </label>
                  ))}
                </fieldset>
                <p className="tiny muted">{t('subscription.moveHelp', { pro })}</p>
              </>
            )
          }
        </ResourceState>
        <ErrorText error={error} />
      </div>
    </Sheet>
  );
}

function PlanView({ subscription, onChanged, reload }: { subscription: Subscription; onChanged: (s: Subscription) => void; reload: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const visitAction = useAction();
  const cancel = useAction();
  /** When the plan would end if cancelled now, while the customer confirms (30 days' notice). */
  const [cancelEnds, setCancelEnds] = useState<string | null>(null);
  const [moving, setMoving] = useState<SubscriptionVisit | null>(null);
  const running = subscription.status === 'active' || subscription.status === 'past_due';
  const ending = running && subscription.endsAt !== null;
  const canCancel = running && !ending && subscription.cancelableFrom !== null && new Date(subscription.cancelableFrom) <= new Date();
  // Visits called off by a pause stay listed, marked Paused (D78).
  const upcoming = subscription.visits.filter((v) => new Date(v.startsAt) > new Date() && (v.status !== 'cancelled' || Boolean(v.pausedBy)));
  const pro = subscription.proName ?? t('subscription.yourPro');
  const rules = planRuleTexts(t, subscription);

  async function withdraw(visit: SubscriptionVisit) {
    const result = await visitAction.run(() =>
      api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/visits/${visit.id}/move/withdraw`),
    );
    if (result) onChanged(result.subscription);
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
        {ending && subscription.endsAt && <p className="small">{t('subscription.endsOn', { date: longDate(subscription.endsAt, timezone) })}</p>}
        <ul className="small muted stack tight" aria-label={t('subscription.rules')}>
          <li>{rules.term}</li>
          <li>{rules.pause}</li>
        </ul>
      </div>

      {subscription.status === 'awaiting_payment' && <FinishPayment subscription={subscription} onConfirmed={reload} />}
      {subscription.status === 'past_due' && (
        <p className="info amber" role="alert">
          {t('subscription.pastDue')}
        </p>
      )}

      {subscription.status !== 'awaiting_payment' && subscription.status !== 'cancelled' && (
        <section aria-labelledby="visits-heading">
          <h2 id="visits-heading" className="h-sm">
            {t('subscription.upcoming')}
          </h2>
          {upcoming.length === 0 ? (
            <p className="card small muted">{subscription.billingPaused ? t('subscription.noVisitsWinter') : t('subscription.noVisits')}</p>
          ) : (
            <ul className="stack">
              {upcoming.map((v) => {
                const parts = dayParts(v.startsAt, timezone);
                const skipped = v.status === 'skipped';
                const paused = v.status === 'cancelled' && Boolean(v.pausedBy);
                const when = dateTime(v.startsAt, timezone);
                return (
                  <li key={v.id} className={`visit ${skipped || paused ? 'skipped' : ''}`}>
                    <span className="vd">
                      <span className="small muted block">{parts.weekday}</span>
                      <span className="b big block">{parts.day}</span>
                      <span className="tiny muted block">{parts.month}</span>
                    </span>
                    <span className="grow">
                      <span className="b small block">{time(v.startsAt, timezone)}</span>
                      <span className="tiny muted block">{skipped ? t('subscription.skipped') : paused ? t('subscription.pause.visitPaused') : subscription.tasks.slice(0, 3).join(', ')}</span>
                      {v.movedFrom && !skipped && (
                        <span className="tiny muted block">{t('subscription.movedFrom', { date: dateTime(v.movedFrom, timezone) })}</span>
                      )}
                      {v.pendingMove && (
                        <span className="tiny block move-waiting" role="status">
                          {t('subscription.moveWaiting', { pro, date: dateTime(v.pendingMove.toStartsAt, timezone) })}{' '}
                          <button
                            type="button"
                            className="link"
                            disabled={visitAction.busy}
                            aria-label={t('subscription.withdrawLabel', { date: when })}
                            onClick={() => void withdraw(v)}
                          >
                            {t('subscription.withdraw')}
                          </button>
                        </span>
                      )}
                    </span>
                    {v.status === 'planned' && !v.pendingMove && running && (
                      <button
                        type="button"
                        className="mini-btn"
                        aria-haspopup="dialog"
                        aria-label={t('subscription.moveLabel', { date: when })}
                        onClick={() => setMoving(v)}
                      >
                        {t('subscription.move')}
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

      <PlanPause subscription={subscription} onChanged={onChanged} />

      {moving && (
        <MoveSheet
          subscription={subscription}
          visit={moving}
          onClose={() => setMoving(null)}
          onRequested={(next) => {
            setMoving(null);
            onChanged(next);
          }}
        />
      )}

      {running && !ending && (
        // Always shown (D77): until the minimum term is over it is disabled and says from when.
        <section className="stack">
          {cancelEnds && canCancel ? (
            <div className="card" role="alertdialog" aria-labelledby="cancel-plan">
              <p id="cancel-plan">
                {t('subscription.cancelQuestion', { date: longDate(cancelEnds, timezone) })}
              </p>
              <div className="row gap8">
                <button type="button" className="btn btn-ghost" onClick={() => setCancelEnds(null)}>
                  {t('booking.keep')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={cancel.busy}
                  onClick={() =>
                    void cancel
                      .run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/cancel`))
                      .then((result) => {
                        if (result) {
                          setCancelEnds(null);
                          onChanged(result.subscription);
                        }
                      })
                  }
                >
                  {t('subscription.cancelConfirm')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost cancel-plan"
                disabled={!canCancel}
                aria-describedby={!canCancel && subscription.cancelableFrom ? 'cancel-from' : undefined}
                onClick={() => setCancelEnds(new Date(Date.now() + CANCEL_NOTICE_DAYS * 24 * 3600 * 1000).toISOString())}
              >
                {t('subscription.cancel')}
              </button>
              {!canCancel && subscription.cancelableFrom && (
                <p id="cancel-from" className="small muted">
                  {t('subscription.cancelFrom', { date: longDate(subscription.cancelableFrom, timezone) })}
                </p>
              )}
            </>
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
