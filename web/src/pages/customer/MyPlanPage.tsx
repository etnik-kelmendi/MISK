import type { TFunction } from 'i18next';
import { useCallback, useId, useState } from 'react';
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
import { dateTime, dayName, dayParts, euro, longDate, time } from '../../lib/format';
import { changeable, PLANNING_DAYS, planRuleTexts, SKIPS_PER_MONTH } from '../../lib/plans';
import { useAction } from '../../lib/useAction';
import { useNow } from '../../lib/useNow';
import { usePolling } from '../../lib/usePolling';
import { CardPayment } from '../../payments/CardPayment';
import { brandName } from '../../payments/PaymentOptions';
import { AppHeader } from '../../shells/Shells';
import { CATEGORY_COLORS } from './categoryColors';
import { planStatus } from './CustomerPlansPage';
import { PlanPause } from './PlanPause';

const DAY_MS = 24 * 3600 * 1000;

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
 * Move one visit (D77, D90): the nearby days of the same week, each saying whether the pro is free then, or why
 * the visit cannot move. The pro confirms the new day; until then the visit keeps its time.
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
          {({ options, days, reason }) => {
            if (reason && reason !== 'no_free_day') {
              return (
                <p className="info amber" role="status">
                  {t(`subscription.moveReasons.${reason}`, { pro })}
                </p>
              );
            }
            // Older answers list only the free days.
            const nearby = days ?? options.map((option) => ({ ...option, free: true }));
            return (
              <>
                <p className="small">{t('subscription.moveIntro', { pro, time: time(visit.startsAt, timezone) })}</p>
                {nearby.length > 0 && (
                  <fieldset className="choices">
                    <legend className="h-sm">{t('subscription.moveChoose')}</legend>
                    {nearby.map((day) => (
                      <label key={day.startsAt} className={`choice ${chosen === day.startsAt ? 'on' : ''} ${day.free ? '' : 'busy'}`}>
                        <input
                          type="radio"
                          name="move-day"
                          disabled={!day.free}
                          checked={chosen === day.startsAt}
                          onChange={() => setChosen(day.startsAt)}
                        />
                        <span className="grow b">{dateTime(day.startsAt, timezone)}</span>
                        <span className={`badge ${day.free ? 'g' : 'grey'}`}>
                          {day.free ? t('subscription.proFree', { pro }) : t('subscription.proBusy', { pro })}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {options.length === 0 ? (
                  <p className="info amber" role="status">
                    {t('subscription.moveReasons.no_free_day', { pro })}
                  </p>
                ) : (
                  <p className="tiny muted">{t('subscription.moveHelp', { pro })}</p>
                )}
              </>
            );
          }}
        </ResourceState>
        <ErrorText error={error} />
      </div>
    </Sheet>
  );
}

/** "Visa •••• 4242", or "Apple Pay (Visa •••• 4242)" for a wallet. */
function cardText(t: TFunction, method: NonNullable<Subscription['paymentMethod']>): string {
  const card = t('review.card', { brand: brandName(method.brand), last4: method.last4 ?? '••••' });
  if (method.wallet === 'apple_pay') return t('subscription.walletCard', { wallet: t('review.applePay'), card });
  if (method.wallet === 'google_pay') return t('subscription.walletCard', { wallet: t('review.googlePay'), card });
  return card;
}

/** Cancel subscription (D90): first says when the minimum term ends and when the plan would end, then confirms. */
function CancelPlan({ subscription, onChanged }: { subscription: Subscription; onChanged: (s: Subscription) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const { run, busy, error } = useAction();
  const [asking, setAsking] = useState(false);
  const now = useNow();

  async function cancel() {
    const result = await run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/cancel`));
    if (result) {
      setAsking(false);
      onChanged(result.subscription);
    }
  }

  return (
    <section className="stack">
      <div className="lgroup">
        <button type="button" className="lrow danger-row" aria-haspopup="dialog" onClick={() => setAsking(true)}>
          <Icon name="x" /> <span className="grow">{t('subscription.cancelSubscription')}</span>
        </button>
      </div>
      {asking && (
        <Sheet
          title={t('subscription.cancelTitle')}
          closeLabel={t('common.close')}
          onClose={() => setAsking(false)}
          footer={
            <div className="row gap8">
              <button type="button" className="btn btn-ghost grow" onClick={() => setAsking(false)}>
                {t('subscription.cancelBack')}
              </button>
              <button type="button" className="btn btn-danger grow" disabled={busy} onClick={() => void cancel()}>
                {t('subscription.cancelConfirm')}
              </button>
            </div>
          }
        >
          <div className="stack">
            {subscription.minTermEndsAt && (
              <p className="info amber">
                <Icon name="calendar" />
                <span>
                  {new Date(subscription.minTermEndsAt).getTime() > now
                    ? t('subscription.cancelMinTerm', { count: subscription.minTermMonths, date: longDate(subscription.minTermEndsAt, timezone) })
                    : t('subscription.cancelMinTermOver', { count: subscription.minTermMonths, date: longDate(subscription.minTermEndsAt, timezone) })}
                </span>
              </p>
            )}
            {subscription.cancelEndsAt && <p>{t('subscription.cancelEnds', { date: longDate(subscription.cancelEndsAt, timezone) })}</p>}
            <p className="small muted">{t('subscription.cancelRule')}</p>
            <ErrorText error={error} />
          </div>
        </Sheet>
      )}
    </section>
  );
}

/** The plan is ending (D90): until when, why, and "Keep my plan" to take the cancellation back. */
function EndingNote({ subscription, onChanged }: { subscription: Subscription; onChanged: (s: Subscription) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const { run, busy, error } = useAction();
  if (!subscription.endsAt) return null;
  const endsAt = subscription.endsAt;
  const atTermEnd = subscription.minTermEndsAt !== undefined && Math.abs(new Date(subscription.minTermEndsAt).getTime() - new Date(endsAt).getTime()) < DAY_MS;
  return (
    <div className="info amber" role="status">
      <Icon name="calendar" />
      <span className="stack tight">
        <span>
          <b>{t('subscription.endsTitle', { date: longDate(endsAt, timezone) })}</b>{' '}
          {atTermEnd ? t('subscription.endsAtTerm', { count: subscription.minTermMonths }) : t('subscription.endsAfterNotice')}{' '}
          {t('subscription.endsVisits')}
        </span>
        <span>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() =>
              void run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/keep`)).then((result) => {
                if (result) onChanged(result.subscription);
              })
            }
          >
            {t('subscription.keepPlan')}
          </button>
        </span>
        <ErrorText error={error} />
      </span>
    </div>
  );
}

/** One upcoming visit: its day, time window and pro, with Skip, Undo and Move while they are possible (D90). */
function VisitRow({
  subscription,
  visit,
  running,
  busy,
  now,
  onSkip,
  onUndo,
  onMove,
  onWithdraw,
}: {
  subscription: Subscription;
  visit: SubscriptionVisit;
  running: boolean;
  busy: boolean;
  now: number;
  onSkip: () => void;
  onUndo: () => void;
  onMove: () => void;
  onWithdraw: () => void;
}) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const noteId = useId();
  const parts = dayParts(visit.startsAt, timezone);
  const skipped = visit.status === 'skipped';
  const paused = visit.status === 'cancelled' && Boolean(visit.pausedBy);
  const when = dateTime(visit.startsAt, timezone);
  const pro = subscription.proName ?? t('subscription.yourPro');
  const open = changeable(visit.startsAt, now);
  const monthFull = (visit.skipsUsedInMonth ?? 0) >= (subscription.skipsPerMonth ?? SKIPS_PER_MONTH);
  const planned = visit.status === 'planned' && running;
  return (
    <li className={`visit ${skipped || paused ? 'skipped' : ''}`}>
      <span className="vd" aria-hidden="true">
        <span className="small muted block">{parts.weekday}</span>
        <span className="b big block">{parts.day}</span>
        <span className="tiny muted block">{parts.month}</span>
      </span>
      <span className="grow vt">
        <span className="visually-hidden">{dayName(visit.startsAt, timezone)} </span>
        <span className="b small block">
          {time(visit.startsAt, timezone)} – {time(visit.endsAt, timezone)}
          {visit.movedFrom && !skipped && <span className="badge b moved-badge">{t('subscription.moved')}</span>}
        </span>
        <span className="tiny muted block">
          {skipped ? t('subscription.skipped') : `${pro} · ${subscription.tasks.slice(0, 2).join(', ')}`}
        </span>
        {visit.movedFrom && !skipped && (
          <span className="tiny muted block">{t('subscription.movedFrom', { date: dateTime(visit.movedFrom, timezone) })}</span>
        )}
        {visit.pendingMove && (
          <span className="tiny block move-waiting" role="status">
            {t('subscription.moveWaiting', { pro, date: dateTime(visit.pendingMove.toStartsAt, timezone) })}{' '}
            <button type="button" className="link" disabled={busy} aria-label={t('subscription.withdrawLabel', { date: when })} onClick={onWithdraw}>
              {t('subscription.withdraw')}
            </button>
          </span>
        )}
        {(planned || (skipped && running)) && !open && (
          <span id={noteId} className="tiny muted block">
            {t('subscription.tooLate')}
          </span>
        )}
        {planned && open && monthFull && !visit.pendingMove && (
          <span id={noteId} className="tiny muted block">
            {t('subscription.noSkipsInMonth', { month: parts.month })}
          </span>
        )}
      </span>
      {paused ? (
        <span className="badge grey">{t('subscription.pause.visitPaused')}</span>
      ) : skipped ? (
        running && (
          <button
            type="button"
            className="mini-btn"
            disabled={busy || !open}
            aria-describedby={!open ? noteId : undefined}
            aria-label={t('subscription.undoLabel', { date: when })}
            onClick={onUndo}
          >
            {t('subscription.undo')}
          </button>
        )
      ) : (
        planned &&
        !visit.pendingMove && (
          <span className="row gap4 visit-actions">
            <button
              type="button"
              className="mini-btn"
              aria-haspopup="dialog"
              disabled={!open}
              aria-describedby={!open ? noteId : undefined}
              aria-label={t('subscription.moveLabel', { date: when })}
              onClick={onMove}
            >
              {t('subscription.move')}
            </button>
            <button
              type="button"
              className="mini-btn"
              disabled={busy || !open || monthFull}
              aria-describedby={!open || monthFull ? noteId : undefined}
              aria-label={t('subscription.skipLabel', { date: when })}
              onClick={onSkip}
            >
              {t('subscription.skip')}
            </button>
          </span>
        )
      )}
    </li>
  );
}

function PlanView({ subscription, onChanged, reload }: { subscription: Subscription; onChanged: (s: Subscription) => void; reload: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const visitAction = useAction();
  const [moving, setMoving] = useState<SubscriptionVisit | null>(null);
  const running = subscription.status === 'active' || subscription.status === 'past_due';
  const ending = running && subscription.endsAt !== null;
  const now = useNow();
  // The next 4 weeks; visits called off by a pause stay listed, marked Paused (D78).
  const upcoming = subscription.visits.filter((v) => {
    const at = new Date(v.startsAt).getTime();
    return at > now && at <= now + PLANNING_DAYS * DAY_MS && (v.status !== 'cancelled' || Boolean(v.pausedBy));
  });
  const rules = planRuleTexts(t, subscription);
  const icon = subscription.categoryIcon ?? 'leaf';
  const color = CATEGORY_COLORS[icon];
  const days = subscription.days.map((d) => t(`weekday.${d as 1 | 2 | 3 | 4 | 5 | 6 | 7}`)).join(' & ');

  async function visitCall(visit: SubscriptionVisit, action: 'skip' | 'unskip' | 'move/withdraw') {
    const result = await visitAction.run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/visits/${visit.id}/${action}`));
    if (result) onChanged(result.subscription);
  }

  return (
    <div className="body">
      <div className="card plan-card">
        <div className="row">
          <span className="ci" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
            <Icon name={icon} />
          </span>
          <div className="grow">
            <h2 className="b">{subscription.planName}</h2>
            <p className="small muted">
              {t(`admin.plans.frequency.${subscription.frequency}`)} · {days} · {t(`subscribe.windowShort.${subscription.timeWindow}`)}
            </p>
          </div>
          <p className="right">
            <span className="b block">{euro(subscription.priceCents)}</span>
            <span className="tiny muted">{t('admin.plans.perMonthSuffix')}</span>
          </p>
        </div>
        {subscription.withAddon && subscription.addonName && <p className="small">{t('subscription.withExtra', { extra: subscription.addonName })}</p>}
        {subscription.currentPeriodEnd && !ending && (
          <p className="small muted row gap4">
            <Icon name="card" />{' '}
            {subscription.billingPaused
              ? t('subscription.seasonPaused')
              : subscription.paymentMethod
                ? t('subscription.nextChargeCard', { date: dayName(subscription.currentPeriodEnd, timezone), card: cardText(t, subscription.paymentMethod) })
                : t('subscription.nextCharge', { date: dayName(subscription.currentPeriodEnd, timezone) })}
          </p>
        )}
        <ul className="small muted stack tight" aria-label={t('subscription.rules')}>
          <li>{rules.term}</li>
          <li>{rules.pause}</li>
        </ul>
      </div>

      {ending && <EndingNote subscription={subscription} onChanged={onChanged} />}

      {subscription.status === 'awaiting_payment' && <FinishPayment subscription={subscription} onConfirmed={reload} />}
      {subscription.status === 'past_due' && (
        <p className="info amber" role="alert">
          {t('subscription.pastDue')}
        </p>
      )}

      <PlanPause subscription={subscription} onChanged={onChanged} />

      {subscription.status !== 'awaiting_payment' && subscription.status !== 'cancelled' && (
        <section aria-labelledby="visits-heading" className="stack">
          <div className="row between">
            <h2 id="visits-heading" className="h-sm">
              {t('subscription.upcoming')}
            </h2>
            <p className="small muted">
              {t('subscription.skipsLeft')} <b className="ink">{subscription.skipsLeftThisMonth ?? SKIPS_PER_MONTH}</b>
            </p>
          </div>
          {upcoming.length === 0 ? (
            <p className="card small muted">{subscription.billingPaused ? t('subscription.noVisitsWinter') : t('subscription.noVisits')}</p>
          ) : (
            <ul className="stack">
              {upcoming.map((v) => (
                <VisitRow
                  key={v.id}
                  subscription={subscription}
                  visit={v}
                  running={running}
                  busy={visitAction.busy}
                  now={now}
                  onSkip={() => void visitCall(v, 'skip')}
                  onUndo={() => void visitCall(v, 'unskip')}
                  onMove={() => setMoving(v)}
                  onWithdraw={() => void visitCall(v, 'move/withdraw')}
                />
              ))}
            </ul>
          )}
          <p className="tiny muted">{t('subscription.skipNote', { count: subscription.skipsPerMonth ?? SKIPS_PER_MONTH })}</p>
          <ErrorText error={visitAction.error} />
        </section>
      )}

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

      {running && !ending && <CancelPlan subscription={subscription} onChanged={onChanged} />}
    </div>
  );
}

/** My plan (D77, D78, D90): the plan, billing, holiday pause, the next 4 weeks of visits and cancelling. */
export function MyPlanPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ subscription: Subscription }>(`/subscriptions/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  // Picks up the first payment going through.
  usePolling(reload, 8_000, state.status === 'ready' && state.data.subscription.status === 'awaiting_payment');
  const status = state.status === 'ready' ? planStatus(state.data.subscription) : null;
  return (
    <>
      <AppHeader
        title={t('subscription.title')}
        back="/plans"
        right={status && <span className={`badge ${status.tone}`}>{t(`subscription.status.${status.label}`)}</span>}
      />
      <ResourceState state={state} reload={reload}>
        {({ subscription }) => (
          <PlanView
            subscription={subscription}
            reload={reload}
            // Actions answer without the card, which only the single-plan read asks the payment provider for.
            onChanged={(next) => update((current) => ({ subscription: { ...next, paymentMethod: next.paymentMethod ?? current.subscription.paymentMethod } }))}
          />
        )}
      </ResourceState>
    </>
  );
}
