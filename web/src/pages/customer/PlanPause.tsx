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

/**
 * The Holiday pause card of My plan (D78, D90): a switch that is on while a pause is planned or running. Turning it
 * on opens the pause sheet within the plan's own rules; turning it off calls an upcoming pause off after asking. A
 * running pause cannot be called off, and a plan whose rules allow no pauses has no switch.
 */
export function PlanPause({ subscription, onChanged }: { subscription: Subscription; onChanged: (s: Subscription) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const titleId = useId();
  const textId = useId();
  const current = openPause(subscription);
  const [calledOff, setCalledOff] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const callOff = useAction();
  const pro = subscription.proName ?? t('subscription.yourPro');
  const active = subscription.status === 'active';
  // The plan's own terms allow no pauses (D85): no switch, only the reason.
  const allowed = subscription.maxPauseWeeks > 0;
  const load = useCallback(() => api.get<PauseOptions>(`/subscriptions/${subscription.id}/pause-options`), [api, subscription.id]);
  const needsOptions = active && allowed && !current;
  const withdrawn = calledOff ? subscription.pauses.find((pause) => pause.id === calledOff && pause.status === 'withdrawn') : undefined;

  if (!current && !active) return null;

  const description = current
    ? current.status === 'running'
      ? t('subscription.holiday.running', { date: calendarDay(current.endsOn) })
      : t('subscription.holiday.upcoming', { from: calendarDay(current.startsOn), to: calendarDay(current.endsOn) })
    : allowed
      ? t('subscription.holiday.off', {
          count: subscription.maxPauseWeeks,
          notice: subscription.pauseNoticeDays === 0 ? t('planRules.noticeNone') : t('planRules.notice', { count: subscription.pauseNoticeDays }),
        })
      : t('subscription.pause.reasons.pauses_not_allowed');

  async function confirmCallOff() {
    if (!current) return;
    const result = await callOff.run(() => api.post<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/pause/${current.id}/cancel`));
    if (result) {
      setConfirming(false);
      setCalledOff(current.id);
      onChanged(result.subscription);
    }
  }

  return (
    <section className="stack" aria-labelledby={titleId}>
      <div className="card row between holiday-card">
        <div className="grow">
          <h2 id={titleId} className="b">
            {t('subscription.holiday.title')}
          </h2>
          <p id={textId} className="small muted">
            {description}
          </p>
          {current && current.creditCents > 0 && (
            <p className="small">{t('subscription.pause.credited', { amount: euro(current.creditCents - current.reversedCents) })}</p>
          )}
        </div>
        {allowed &&
          (current ? (
            <button
              type="button"
              role="switch"
              aria-checked="true"
              aria-labelledby={titleId}
              aria-describedby={textId}
              className="toggle on"
              // A running pause cannot be called off (D78).
              disabled={current.status !== 'upcoming' || callOff.busy}
              onClick={() => setConfirming(true)}
            />
          ) : (
            <PauseSwitch subscription={subscription} load={load} enabled={needsOptions} titleId={titleId} open={sheet} setOpen={setSheet} onPaused={onChanged} />
          ))}
      </div>
      {confirming && current && (
        <div role="alertdialog" aria-labelledby="call-off-pause" className="card stack">
          <p id="call-off-pause">{t('subscription.pause.callOffQuestion', { pro })}</p>
          <div className="row gap8">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              {t('subscription.pause.keep')}
            </button>
            <button type="button" className="btn btn-danger" disabled={callOff.busy} onClick={() => void confirmCallOff()}>
              {t('subscription.pause.callOffConfirm')}
            </button>
          </div>
        </div>
      )}
      <ErrorText error={callOff.error} />
      {withdrawn && <CalledOffNote pause={withdrawn} pro={pro} />}
    </section>
  );
}

/** The switch while no pause is planned: it opens the pause sheet, or says why the plan cannot be paused now. */
function PauseSwitch({
  subscription,
  load,
  enabled,
  titleId,
  open,
  setOpen,
  onPaused,
}: {
  subscription: Subscription;
  load: () => Promise<PauseOptions>;
  enabled: boolean;
  titleId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  onPaused: (next: Subscription) => void;
}) {
  const { t } = useTranslation();
  const reasonId = useId();
  const { state, reload } = useResource(load);
  const options = state.status === 'ready' ? state.data : null;
  const ready =
    enabled && options && !options.reason && options.earliestStartOn && options.latestStartOn
      ? { ...options, earliestStartOn: options.earliestStartOn, latestStartOn: options.latestStartOn }
      : null;
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked="false"
        aria-labelledby={titleId}
        aria-describedby={options?.reason ? reasonId : undefined}
        className="toggle"
        disabled={!ready}
        onClick={() => setOpen(true)}
      />
      {options?.reason && (
        <p id={reasonId} className="small muted holiday-reason">
          {t(`subscription.pause.reasons.${options.reason}`, { count: options.maxPauseWeeks })}
        </p>
      )}
      {state.status === 'error' && (
        <p className="small muted holiday-reason">
          {t('subscription.pause.loadFailed')}{' '}
          <button type="button" className="link" onClick={reload}>
            {t('common.retry')}
          </button>
        </p>
      )}
      {open && ready && (
        <PauseSheet
          subscription={subscription}
          options={ready}
          onClose={() => setOpen(false)}
          onPaused={(next) => {
            setOpen(false);
            onPaused(next);
          }}
        />
      )}
    </>
  );
}
