import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { Service, Slot } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dayKey, dayParts, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';

export type FlexibleWindow = 'morning' | 'afternoon' | 'any';
export const FLEXIBLE_WINDOWS: FlexibleWindow[] = ['morning', 'afternoon', 'any'];
/** Local start hours each window allows, as the API has them (D70). */
export const WINDOW_HOURS: Record<FlexibleWindow, number[]> = {
  morning: [8, 10],
  afternoon: [12, 14, 16],
  any: [8, 10, 12, 14, 16, 18],
};
/** A pro picks the time of a flexible job by this local hour the evening before. */
export const FLEXIBLE_CONFIRM_HOUR = 18;

/** When the job happens: a time from the list, or a window on a day for a flexible booking. */
export type When = { kind: 'slot'; slot: Slot } | { kind: 'flexible'; day: string; window: FlexibleWindow; anyIso: string };

interface WaitEntry {
  id: string;
  day: string;
  startsAt: string | null;
  notifiedAt: string | null;
}

/** The hour of a moment in the market's time zone. */
function localHour(iso: string, timeZone: string): number {
  return Number(time(iso, timeZone).slice(0, 2));
}

/** The day after a YYYY-MM-DD day. */
function nextDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Flexible jobs need a pro to pick the time by 18:00 the evening before, so today never works (D70). */
export function flexibleOpen(day: string, timeZone: string, now = new Date()): boolean {
  const today = dayKey(now.toISOString(), timeZone);
  if (day <= today) return false;
  return day !== nextDay(today) || localHour(now.toISOString(), timeZone) < FLEXIBLE_CONFIRM_HOUR;
}

/**
 * Choose time (D70): the bookable days, then a free time, the waiting list for a full time or a whole
 * day, or "I'm flexible" with a window on the day.
 */
export function ChooseTimeStep({
  services,
  postcode,
  address,
  initial,
  onDone,
}: {
  services: Service[];
  postcode: string;
  address: string;
  /** What was chosen before, when the customer comes back to this step. */
  initial: When | null;
  onDone: (when: When) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const ids = services.map((service) => service.id).join(',');
  const load = useCallback(
    () =>
      api.get<{ slots: Slot[]; waitlist?: WaitEntry[] }>(
        `/availability?serviceIds=${encodeURIComponent(ids)}&postcode=${encodeURIComponent(postcode)}`,
      ),
    [api, ids, postcode],
  );
  const { state, reload, update } = useResource(load);
  const [day, setDay] = useState<string | null>(
    initial?.kind === 'flexible' ? initial.day : initial ? dayKey(initial.slot.startsAt, timezone) : null,
  );
  const [slot, setSlot] = useState<Slot | null>(initial?.kind === 'slot' ? initial.slot : null);
  const [flexible, setFlexible] = useState(initial?.kind === 'flexible');
  const [window, setWindow] = useState<FlexibleWindow>(initial?.kind === 'flexible' ? initial.window : 'morning');
  const wait = useAction();

  async function toggleWait(entries: WaitEntry[], shownDay: string, startsAt: string | null) {
    const existing = entries.find((e) => e.day === shownDay && e.startsAt === startsAt);
    if (existing) {
      const done = await wait.run(() => api.delete(`/time-waitlist/${existing.id}`).then(() => true));
      if (done) update((current) => ({ ...current, waitlist: (current.waitlist ?? []).filter((e) => e.id !== existing.id) }));
      return;
    }
    const result = await wait.run(() =>
      api.post<{ entry: WaitEntry }>('/time-waitlist', {
        serviceIds: services.map((service) => service.id),
        postcode,
        day: shownDay,
        ...(startsAt ? { startsAt } : {}),
      }),
    );
    if (result) update((current) => ({ ...current, waitlist: [...(current.waitlist ?? []), result.entry] }));
  }

  const label = (w: When) =>
    w.kind === 'slot'
      ? `${dayParts(w.slot.startsAt, timezone).weekday} ${dayParts(w.slot.startsAt, timezone).day} ${dayParts(w.slot.startsAt, timezone).month}, ${time(w.slot.startsAt, timezone)}`
      : `${dayParts(w.anyIso, timezone).weekday} ${dayParts(w.anyIso, timezone).day} ${dayParts(w.anyIso, timezone).month}, ${t(`time.window.${w.window}`).toLowerCase()}`;

  return (
    <>
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ slots, waitlist = [] }) => {
            const days = [...new Set(slots.map((s) => dayKey(s.startsAt, timezone)))];
            if (days.length === 0) return <p className="card">{t('book.noSlots')}</p>;
            const shownDay = day && days.includes(day) ? day : (days.find((d) => slots.some((s) => s.available && dayKey(s.startsAt, timezone) === d)) ?? days[0] ?? '');
            const daySlots = slots.filter((s) => dayKey(s.startsAt, timezone) === shownDay);
            const firstOfDay = daySlots[0]?.startsAt ?? slots[0]?.startsAt ?? new Date().toISOString();
            const freeCount = daySlots.filter((s) => s.available).length;
            const onWait = (startsAt: string | null) => waitlist.some((e) => e.day === shownDay && e.startsAt === startsAt);
            const dayWaiting = onWait(null);
            const dayName = `${dayParts(firstOfDay, timezone).weekday} ${dayParts(firstOfDay, timezone).day} ${dayParts(firstOfDay, timezone).month}`;
            const canFlex = flexibleOpen(shownDay, timezone);
            const windowFree = daySlots.some((s) => s.available && WINDOW_HOURS[window].includes(localHour(s.startsAt, timezone)));
            const month = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, month: 'long', year: 'numeric' }).format(new Date(firstOfDay));

            function chooseDay(next: string) {
              setDay(next);
              setSlot(null);
            }
            // A flexible choice is complete once the window has a free pro and the deadline is still ahead.
            const current: When | null = flexible
              ? canFlex && windowFree
                ? { kind: 'flexible', day: shownDay, window, anyIso: firstOfDay }
                : null
              : slot && dayKey(slot.startsAt, timezone) === shownDay
                ? { kind: 'slot', slot }
                : null;

            return (
              <>
                <h2 className="h-sm">{month}</h2>
                <div className="days" role="group" aria-label={t('book.day')}>
                  {days.map((d) => {
                    const first = slots.find((s) => dayKey(s.startsAt, timezone) === d);
                    const parts = first ? dayParts(first.startsAt, timezone) : null;
                    return (
                      <button key={d} type="button" className={`day ${d === shownDay ? 'on' : ''}`} aria-pressed={d === shownDay} onClick={() => chooseDay(d)}>
                        <span className="dn">{parts?.weekday}</span>
                        <span className="dd">{parts?.day}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="seg seg-full" role="group" aria-label={t('time.kind')}>
                  <button
                    type="button"
                    className={flexible ? '' : 'on'}
                    aria-pressed={!flexible}
                    onClick={() => setFlexible(false)}
                  >
                    {t('time.pick')}
                  </button>
                  <button
                    type="button"
                    className={flexible ? 'on' : ''}
                    aria-pressed={flexible}
                    onClick={() => setFlexible(true)}
                  >
                    {t('time.flexible')}
                  </button>
                </div>

                {flexible ? (
                  <>
                    <h2 className="h-sm">{t('time.whenSuits', { day: dayName })}</h2>
                    <div className="seg seg-full" role="group" aria-label={t('time.windowLabel')}>
                      {FLEXIBLE_WINDOWS.map((w) => (
                        <button key={w} type="button" className={window === w ? 'on' : ''} aria-pressed={window === w} onClick={() => setWindow(w)}>
                          {t(`time.window.${w}`)}
                        </button>
                      ))}
                    </div>
                    {!canFlex ? (
                      <p className="info amber" role="status">
                        <Icon name="clock" />
                        <span>{t('time.flexibleTooLate')}</span>
                      </p>
                    ) : !windowFree ? (
                      <p className="info amber" role="status">
                        <Icon name="clock" />
                        <span>{t('time.windowFull')}</span>
                      </p>
                    ) : (
                      <p className="info">
                        <Icon name="clock" />
                        <span>
                          <b>{t('time.flexibleTitle')}</b> {t('time.flexibleText')}
                        </span>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <h2 className="h-sm">{t('book.times')}</h2>
                    <div className="slots">
                      {daySlots.map((s) => {
                        const chosen = slot?.startsAt === s.startsAt;
                        if (!s.available) {
                          const waiting = onWait(s.startsAt);
                          return (
                            <button
                              key={s.startsAt}
                              type="button"
                              className={`slot off ${waiting ? 'wl' : ''}`}
                              aria-pressed={waiting}
                              disabled={wait.busy}
                              onClick={() => void toggleWait(waitlist, shownDay, s.startsAt)}
                            >
                              <span className="tm">{time(s.startsAt, timezone)}</span>
                              <small>{waiting ? t('time.onWaitlist') : t('time.fullWaitlist')}</small>
                            </button>
                          );
                        }
                        return (
                          <button
                            key={s.startsAt}
                            type="button"
                            className={`slot ${chosen ? 'on' : ''}`}
                            aria-pressed={chosen}
                            onClick={() => setSlot(s)}
                          >
                            {time(s.startsAt, timezone)}
                            <small>{t('time.prosFree', { count: s.freePros })}</small>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="card row wait-day"
                      aria-pressed={dayWaiting}
                      disabled={wait.busy}
                      onClick={() => void toggleWait(waitlist, shownDay, null)}
                    >
                      <span className="wait-icon" aria-hidden="true">
                        <Icon name="bell" />
                      </span>
                      <span className="grow">
                        <span className="b small block">{dayWaiting ? t('time.dayWaiting') : t('time.noTimeSuits')}</span>
                        <span className="tiny muted">{dayWaiting ? t('time.dayWaitingText', { day: dayName }) : t('time.joinDay')}</span>
                      </span>
                      {dayWaiting ? (
                        <span className="badge g">
                          <Icon name="check" /> {t('time.joined')}
                        </span>
                      ) : (
                        <Icon name="chevR" />
                      )}
                    </button>
                    <ErrorText error={wait.error} />
                    <p className="info">
                      <Icon name="users" />
                      <span>
                        <b>{t('time.slotsFree', { free: freeCount, total: daySlots.length })}</b>{' '}
                        {t('time.slotsFreeText', { place: address.split(',')[0] || postcode })}
                      </span>
                    </p>
                  </>
                )}
                <p className="info amber">
                  <Icon name="bell" />
                  <span>{t('time.reminder')}</span>
                </p>
                <div className="cta-bar">
                  <button className="cta" type="button" disabled={!current} onClick={() => current && onDone(current)}>
                    {current ? t('book.continueAt', { when: label(current) }) : t('time.select')}
                  </button>
                </div>
              </>
            );
          }}
        </ResourceState>
      </div>
    </>
  );
}
