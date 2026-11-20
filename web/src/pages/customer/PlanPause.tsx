import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { PauseOptions, Subscription, SubscriptionPause } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Sheet } from '../../components/Sheet';
import { dayName, euro, zonedToIso } from '../../lib/format';
import { addDays, daysBetween, isCalendarDay } from '../../lib/plans';
import { useAction } from '../../lib/useAction';

/** "Mon 7 Dec" for a calendar day 'YYYY-MM-DD'. */
const calendarDay = (day: string) => dayName(`${day}T12:00:00Z`, 'UTC');

/** The pause that has not finished yet: upcoming or running (D78). */
export function openPause(subscription: Subscription): SubscriptionPause | null {
  return subscription.pauses.find((pause) => pause.status === 'upcoming' || pause.status === 'running') ?? null;
}

/**
 * Pause the plan (D78): the first day (from the earliest the notice allows), how many weeks, and a live
 * summary of the visits called off and the credit on the next bill.
 */
function PauseSheet({
  subscription,
  options,
  onClose,
  onPaused,
}: {
  subscription: Subscription;
  options: PauseOptions & { earliestStartOn: string; latestStartOn: string };
  onClose: () => void;
  onPaused: (next: Subscription) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const dateId = useId();
  const weeksId = useId();
  const dateHelpId = useId();
  const [startsOn, setStartsOn] = useState(options.earliestStartOn);
  const [weeks, setWeeks] = useState(1);
  const { run, busy, error } = useAction();

  const validDay = isCalendarDay(startsOn) && startsOn >= options.earliestStartOn && startsOn <= options.latestStartOn;
  const yearLeft = validDay ? (options.weeksLeft[startsOn.slice(0, 4)] ?? 0) : 0;
  const byEnd = validDay && options.latestEndOn ? Math.floor(daysBetween(startsOn, options.latestEndOn) / 7) : options.maxPauseWeeks;
  const maxWeeks = Math.max(0, Math.min(yearLeft, byEnd, options.maxPauseWeeks));
  const chosenWeeks = Math.min(Math.max(weeks, 1), Math.max(maxWeeks, 1));
  const endsOn = validDay ? addDays(startsOn, chosenWeeks * 7) : null;

  // The visits starting from local midnight of the first day up to local midnight of the day after the pause.
  const from = validDay ? zonedToIso(startsOn, '00:00', timezone) : null;
  const to = endsOn ? zonedToIso(endsOn, '00:00', timezone) : null;
  const calledOff =
    from && to ? options.visitStarts.filter((start) => new Date(start) >= new Date(from) && new Date(start) < new Date(to)).length : 0;
  const creditCents = calledOff * options.visitCreditCents;
  const canPause = validDay && maxWeeks > 0 && endsOn !== null;

  async function confirm() {
    if (!canPause) return;
    const result = await run(() =>
      api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/pause`, { startsOn, weeks: chosenWeeks }),
    );
    if (result) onPaused(result.subscription);
  }

  return (
    <Sheet
      title={t('subscription.pause.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <button type="button" className="cta" disabled={busy || !canPause} onClick={() => void confirm()}>
          {t('subscription.pause.confirm')}
        </button>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor={dateId}>{t('subscription.pause.start')}</label>
          <input
            id={dateId}
            type="date"
            value={startsOn}
            min={options.earliestStartOn}
            max={options.latestStartOn}
            aria-invalid={!validDay}
            aria-describedby={dateHelpId}
            onChange={(event) => setStartsOn(event.target.value)}
          />
          <p id={dateHelpId} className={`small ${validDay ? 'muted' : 'error-text'}`}>
            {t('subscription.pause.dateRange', { from: calendarDay(options.earliestStartOn), to: calendarDay(options.latestStartOn) })}
          </p>
        </div>
        {validDay && maxWeeks === 0 ? (
          <p className="info amber" role="status">
            {t('subscription.pause.noWeeksInYear', { year: startsOn.slice(0, 4) })}
          </p>
        ) : (
          <div className="field">
            <label htmlFor={weeksId}>{t('subscription.pause.weeks')}</label>
            <select id={weeksId} value={chosenWeeks} onChange={(event) => setWeeks(Number(event.target.value))}>
              {Array.from({ length: Math.max(maxWeeks, 1) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {t('subscription.pause.weeksCount', { count: n })}
                </option>
              ))}
            </select>
          </div>
        )}
        {canPause && endsOn && (
          <p className="info pause-summary" role="status" aria-live="polite">
            {calledOff > 0
              ? t('subscription.pause.summary', {
                  count: calledOff,
                  from: calendarDay(startsOn),
                  to: calendarDay(endsOn),
                  credit: euro(creditCents),
                })
              : t('subscription.pause.summaryNone', { from: calendarDay(startsOn), to: calendarDay(endsOn) })}
          </p>
        )}
        <p className="small muted">
          {t('subscription.pause.rule', {
            weeks: t('subscription.pause.weeksCount', { count: options.maxPauseWeeks }),
            notice: t('planRules.notice', { count: options.noticeDays }),
            left: t('subscription.pause.weeksCount', { count: options.weeksLeftThisYear }),
          })}
        </p>
        <ErrorText error={error} />
      </div>
    </Sheet>
  );
}

/** The plan's pause that has not finished: its days and credit, and Call off pause until it starts (D78). */
function PauseCard({ subscription, pause, onChanged }: { subscription: Subscription; pause: SubscriptionPause; onChanged: (s: Subscription) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const { run, busy, error } = useAction();
  const pro = subscription.proName ?? t('subscription.yourPro');

  async function callOff() {
    const result = await run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/pause/${pause.id}/cancel`));
    if (result) {
      setConfirming(false);
      onChanged(result.subscription);
    }
  }

  return (
    <section className="card stack pause-card" aria-label={t('subscription.pause.cardLabel')}>
      <p className="b">
        {pause.status === 'running'
          ? t('subscription.pause.runningUntil', { date: calendarDay(pause.endsOn) })
          : t('subscription.pause.card', { from: calendarDay(pause.startsOn), to: calendarDay(pause.endsOn) })}
      </p>
      {pause.creditCents > 0 && <p className="small">{t('subscription.pause.credited', { amount: euro(pause.creditCents) })}</p>}
      {pause.status === 'upcoming' &&
        (confirming ? (
          <div role="alertdialog" aria-labelledby="call-off-pause" className="stack">
            <p id="call-off-pause">{t('subscription.pause.callOffQuestion', { pro })}</p>
            <div className="row gap8">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                {t('subscription.pause.keep')}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void callOff()}>
                {t('subscription.pause.callOffConfirm')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)}>
            {t('subscription.pause.callOff')}
          </button>
        ))}
      <ErrorText error={error} />
    </section>
  );
}

/** What happened when the customer called a pause off: how many visits came back. */
function CalledOffNote({ pause, pro }: { pause: SubscriptionPause; pro: string }) {
  const { t } = useTranslation();
  return (
    <p className="info" role="status">
      {t('subscription.pause.calledOff', { back: pause.visitsRestored, count: pause.visitsCalledOff })}
      {pause.visitsRestored < pause.visitsCalledOff && ` ${t('subscription.pause.calledOffSome', { pro })}`}
    </p>
  );
}

/** "Pause plan" for an active plan, with the reason when it cannot be paused now (D78). */
function PauseStarter({ subscription, onChanged }: { subscription: Subscription; onChanged: (s: Subscription) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const reasonId = useId();
  const load = useCallback(() => api.get<PauseOptions>(`/subscriptions/${subscription.id}/pause-options`), [api, subscription.id]);
  const { state, reload } = useResource(load);
  const [open, setOpen] = useState(false);

  if (state.status === 'error') {
    return (
      <p className="small muted">
        {t('subscription.pause.loadFailed')}{' '}
        <button type="button" className="link" onClick={reload}>
          {t('common.retry')}
        </button>
      </p>
    );
  }
  const options = state.status === 'ready' ? state.data : null;
  const ready =
    options && !options.reason && options.earliestStartOn && options.latestStartOn
      ? { ...options, earliestStartOn: options.earliestStartOn, latestStartOn: options.latestStartOn }
      : null;
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        aria-haspopup="dialog"
        disabled={!ready}
        aria-describedby={options?.reason ? reasonId : undefined}
        onClick={() => setOpen(true)}
      >
        {t('subscription.pause.button')}
      </button>
      {options?.reason && (
        <p id={reasonId} className="small muted">
          {t(`subscription.pause.reasons.${options.reason}`, { count: options.maxPauseWeeks })}
        </p>
      )}
      {open && ready && (
        <PauseSheet
          subscription={subscription}
          options={ready}
          onClose={() => setOpen(false)}
          onPaused={(next) => {
            setOpen(false);
            onChanged(next);
          }}
        />
      )}
    </>
  );
}

/** The pause part of My plan: the open pause, or the Pause plan button for an active plan (D78). */
export function PlanPause({ subscription, onChanged }: { subscription: Subscription; onChanged: (s: Subscription) => void }) {
  const { t } = useTranslation();
  const current = openPause(subscription);
  const [calledOff, setCalledOff] = useState<string | null>(null);
  const withdrawn = calledOff ? subscription.pauses.find((pause) => pause.id === calledOff && pause.status === 'withdrawn') : undefined;
  if (current) {
    return (
      <PauseCard
        subscription={subscription}
        pause={current}
        onChanged={(next) => {
          setCalledOff(current.id);
          onChanged(next);
        }}
      />
    );
  }
  if (subscription.status !== 'active') {
    return null;
  }
  // The plan's own terms allow no pauses (D85): no Pause action, only the reason.
  if (subscription.maxPauseWeeks === 0) {
    return (
      <section className="stack" aria-label={t('subscription.pause.sectionLabel')}>
        <p className="small muted">{t('subscription.pause.reasons.pauses_not_allowed')}</p>
      </section>
    );
  }
  return (
    <section className="stack" aria-label={t('subscription.pause.sectionLabel')}>
      {withdrawn && <CalledOffNote pause={withdrawn} pro={subscription.proName ?? t('subscription.yourPro')} />}
      <PauseStarter subscription={subscription} onChanged={onChanged} />
    </section>
  );
}
