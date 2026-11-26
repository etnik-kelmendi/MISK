import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { AvailabilityWindow, BookingRange, HomePro, Service, ServiceDay, Slot } from '../../api/types';
import { useResource } from '../../api/useResource';
import { DateBar, type DayRange } from '../../components/DatePicker';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { addDays, daysBetween, formatDay, weekStart } from '../../lib/calendar';
import { dayKey, dayParts, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';

export type FlexibleWindow = 'morning' | 'afternoon' | 'any';
export const FLEXIBLE_WINDOWS: FlexibleWindow[] = ['morning', 'afternoon', 'any'];
/** The hours each window covers, as the API has them: the whole visit fits inside (D74). */
export const WINDOWS: Record<FlexibleWindow, { from: number; to: number }> = {
  morning: { from: 8, to: 12 },
  afternoon: { from: 12, to: 18 },
  any: { from: 8, to: 20 },
};

/** The minutes since midnight of a moment in the market's time zone. */
function localMinutes(iso: string, timeZone: string): number {
  const [hours = '0', minutes = '0'] = time(iso, timeZone).split(':');
  return Number(hours) * 60 + Number(minutes);
}
/** A pro picks the time of a flexible job by this local hour the evening before. */
export const FLEXIBLE_CONFIRM_HOUR = 18;

/** When the job happens: a time from the list, or a window on a day for a flexible booking. */
export type When = { kind: 'slot'; slot: Slot } | { kind: 'flexible'; day: string; window: FlexibleWindow; anyIso: string };

interface HeldTime {
  startsAt: string;
  expiresAt: string;
}

interface WaitEntry {
  id: string;
  day: string;
  startsAt: string | null;
  notifiedAt: string | null;
}

/** One week of times, as GET /availability answers (D101). */
export interface Availability {
  slots: Slot[];
  waitlist?: WaitEntry[];
  held?: HeldTime[];
  range?: BookingRange;
  window?: AvailabilityWindow;
}

/** Days in a week of day buttons (D74). */
export const WEEK_DAYS = 7;
/** The booking horizon the API starts with, until its answer says otherwise (D101). */
const DEFAULT_HORIZON_DAYS = 60;

/** The days customers can book, from the API's answer or, before it, from today. */
export function rangeOf(range: BookingRange | undefined, today: string): DayRange {
  return range ?? { today, lastDay: addDays(today, DEFAULT_HORIZON_DAYS - 1) };
}

/** The week (its Monday) with a day in it: weeks run Monday to Sunday, the same as the calendar. */
export function weekFor(day: string): string {
  return weekStart(day);
}

/**
 * "&from=...&days=..." for the bookable part of the week starting on Monday `week`, so only that week is
 * computed (D101): from today in the current week, as the API refuses days before today.
 */
export function weekQuery(week: string, today: string): string {
  const from = week < today ? today : week;
  const days = daysBetween(from, addDays(week, WEEK_DAYS - 1)) + 1;
  return `&from=${encodeURIComponent(from)}&days=${days}`;
}

/** Grey boxes shown while a week loads when the week before had fewer times. */
const DEFAULT_PLACEHOLDERS = 3;

/** The most times on one day of a week: as many grey boxes stand in for the times while a new week loads. */
export function placeholderCount(slots: Slot[], timeZone: string): number {
  const perDay = new Map<string, number>();
  for (const s of slots) {
    const key = dayKey(s.startsAt, timeZone);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  return Math.max(DEFAULT_PLACEHOLDERS, ...perDay.values());
}

/** The grey boxes that keep the place of the times while a new week loads, with a status for screen readers. */
export function SlotPlaceholders({ count, label }: { count: number; label: string }) {
  return (
    <div className="slots" aria-busy="true">
      <span className="visually-hidden" role="status">
        {label}
      </span>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="slot skel" aria-hidden="true">
          00:00
          <small>&nbsp;</small>
        </span>
      ))}
    </div>
  );
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
 * Choose time (D70, D101): a week of days with a date picker for any day up to the booking horizon, then a free
 * time, the waiting list for a full time or a whole day (with all the customer's entries listed), or "I'm
 * flexible" with a window on the day.
 */
export function ChooseTimeStep({
  services,
  postcode,
  picked = null,
  initial,
  onDone,
}: {
  services: Service[];
  postcode: string;
  /** The pro picked on Home (D89): only their free times are offered while they have any. */
  picked?: HomePro | null;
  /** What was chosen before, when the customer comes back to this step. */
  initial: When | null;
  onDone: (when: When) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const ids = services.map((service) => service.id).join(',');
  const proId = picked?.id ?? null;
  const [today] = useState(() => dayKey(new Date().toISOString(), timezone));
  const initialDay = initial?.kind === 'flexible' ? initial.day : initial ? dayKey(initial.slot.startsAt, timezone) : null;
  const [day, setDay] = useState<string | null>(initialDay);
  // The Monday of the week shown.
  const [week, setWeek] = useState<string>(() => weekFor(initialDay ?? today));
  const base = `serviceIds=${encodeURIComponent(ids)}&postcode=${encodeURIComponent(postcode)}`;
  const load = useCallback(
    () =>
      api
        .get<Availability>(`/availability?${base}${proId ? `&proId=${encodeURIComponent(proId)}` : ''}${weekQuery(week, today)}`)
        .then((data) => ({ ...data, requested: week })),
    [api, base, proId, week, today],
  );
  const loadMonth = useCallback(
    (month: string) =>
      api.get<{ days: ServiceDay[] }>(`/availability/calendar?${base}&month=${encodeURIComponent(month)}`).then((data) => data.days),
    [api, base],
  );
  const proName = picked?.firstName ?? t('home.yourPro');
  const { state, reload, update } = useResource(load);
  const [slot, setSlot] = useState<Slot | null>(initial?.kind === 'slot' ? initial.slot : null);
  const [flexible, setFlexible] = useState(initial?.kind === 'flexible');
  const [window, setWindow] = useState<FlexibleWindow>(initial?.kind === 'flexible' ? initial.window : 'morning');
  const wait = useAction();
  const summaryId = useId();

  async function leave(entry: WaitEntry) {
    const done = await wait.run(() => api.delete(`/time-waitlist/${encodeURIComponent(entry.id)}`).then(() => true));
    if (done) update((current) => ({ ...current, waitlist: (current.waitlist ?? []).filter((e) => e.id !== entry.id) }));
  }

  async function toggleWait(entries: WaitEntry[], shownDay: string, startsAt: string | null) {
    const existing = entries.find((e) => e.day === shownDay && e.startsAt === startsAt);
    if (existing) {
      await leave(existing);
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

  /** "Wed 14 Jan, 08:00", or "Wed 14 Jan, whole day" for a day's waiting list entry. */
  const entryLabel = (entry: WaitEntry) =>
    `${formatDay(entry.day, { weekday: 'short', day: 'numeric', month: 'short' })}, ${entry.startsAt ? time(entry.startsAt, timezone) : t('time.wholeDay')}`;

  const label = (w: When) =>
    w.kind === 'slot'
      ? `${dayParts(w.slot.startsAt, timezone).weekday} ${dayParts(w.slot.startsAt, timezone).day} ${dayParts(w.slot.startsAt, timezone).month}, ${time(w.slot.startsAt, timezone)}`
      : `${dayParts(w.anyIso, timezone).weekday} ${dayParts(w.anyIso, timezone).day} ${dayParts(w.anyIso, timezone).month}, ${t(`time.window.${w.window}`).toLowerCase()}`;

  return (
    <>
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ slots: allSlots, waitlist = [], held = [], range: loadedRange, requested }) => {
            const range = rangeOf(loadedRange, today);
            // A new week is on its way: the page keeps its shape, with grey boxes where its times will be.
            const pending = requested !== week;
            // With a picked pro, only the times they are free, as long as they have any (D89).
            const proSlots = picked ? allSlots.filter((s) => s.preferredFree) : [];
            const proOnly = proSlots.length > 0;
            const loaded = proOnly ? proSlots : allSlots;
            const slots = pending ? [] : loaded;
            const days = [...new Set(slots.map((s) => dayKey(s.startsAt, timezone)))];
            const firstBookable = week < range.today ? range.today : week;
            const shownDay =
              day && weekFor(day) === week
                ? day
                : pending
                  ? firstBookable
                  : (days.find((d) => slots.some((s) => s.available && dayKey(s.startsAt, timezone) === d)) ?? days[0] ?? firstBookable);

            function chooseDay(next: string) {
              setDay(next);
              setSlot(null);
              setWeek(weekFor(next));
            }
            const dateBar = (
              <DateBar
                selected={shownDay}
                range={range}
                week={week}
                loadMonth={loadMonth}
                onSelect={chooseDay}
                onWeek={(monday) => {
                  setDay(null);
                  setSlot(null);
                  setWeek(monday);
                }}
              />
            );
            const pickedNote = picked && (
              <p className={`info ${proOnly ? '' : 'amber'}`} role="status">
                <Icon name="heart" />
                <span>{proOnly ? t('picked.onlyFree', { name: proName }) : t('picked.noTimes', { name: proName })}</span>
              </p>
            );
            // Every day and time the customer waits for, wherever it is, each removable (D101).
            const heldElsewhere = held.filter(
              (h) => new Date(h.expiresAt).getTime() > Date.now() && dayKey(h.startsAt, timezone) !== shownDay,
            );
            const summary = (waitlist.length > 0 || heldElsewhere.length > 0) && (
              <section className="card wl-summary" aria-labelledby={summaryId}>
                <h3 id={summaryId} className="b small">
                  {t('time.myWaitlist')}
                </h3>
                {heldElsewhere.map((h) => {
                  const when = `${formatDay(dayKey(h.startsAt, timezone), { weekday: 'short', day: 'numeric', month: 'short' })}, ${time(h.startsAt, timezone)}`;
                  return (
                    <p key={h.startsAt} className="info wl-held" role="status">
                      <Icon name="clock" />
                      <span className="grow">{t('time.heldElsewhere', { when, time: time(h.expiresAt, timezone) })}</span>
                      <button
                        type="button"
                        className="mini-btn green"
                        aria-label={t('time.showDay', { when })}
                        onClick={() => chooseDay(dayKey(h.startsAt, timezone))}
                      >
                        {t('time.show')}
                      </button>
                    </p>
                  );
                })}
                {waitlist.length > 0 && (
                  <>
                    <p className="tiny muted">{t('time.myWaitlistText')}</p>
                    <ul className="wl-chips">
                      {[...waitlist]
                        .sort((a, b) => a.day.localeCompare(b.day) || (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))
                        .map((entry) => {
                          const when = entryLabel(entry);
                          return (
                            <li key={entry.id} className={`wl-chip ${entry.day === shownDay ? 'on' : ''}`}>
                              <button
                                type="button"
                                className="wl-chip-go"
                                aria-label={t('time.showDay', { when })}
                                onClick={() => chooseDay(entry.day)}
                              >
                                {when}
                              </button>
                              <button
                                type="button"
                                className="wl-chip-x"
                                aria-label={t('time.leaveWaitlist', { when })}
                                disabled={wait.busy}
                                onClick={() => void leave(entry)}
                              >
                                <Icon name="x" />
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </>
                )}
              </section>
            );
            const daySlots = slots.filter((s) => dayKey(s.startsAt, timezone) === shownDay);
            const firstOfDay = daySlots[0]?.startsAt ?? slots[0]?.startsAt ?? new Date().toISOString();
            const onWait = (startsAt: string | null) => waitlist.some((e) => e.day === shownDay && e.startsAt === startsAt);
            const dayWaiting = onWait(null);
            const dayName = formatDay(shownDay, { weekday: 'short', day: 'numeric', month: 'short' });
            const canFlex = flexibleOpen(shownDay, timezone);
            const hours = WINDOWS[window];
            const windowFree = daySlots.some(
              (s) =>
                s.available &&
                localHour(s.startsAt, timezone) >= hours.from &&
                dayKey(s.endsAt, timezone) === shownDay &&
                localMinutes(s.endsAt, timezone) <= hours.to * 60,
            );
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
                {pickedNote}
                {dateBar}

                <div className="seg seg-full" role="group" aria-label={t('time.kind')}>
                  <button type="button" className={flexible ? '' : 'on'} aria-pressed={!flexible} onClick={() => setFlexible(false)}>
                    {t('time.pick')}
                  </button>
                  <button type="button" className={flexible ? 'on' : ''} aria-pressed={flexible} onClick={() => setFlexible(true)}>
                    {t('time.flexible')}
                  </button>
                </div>

                {flexible ? (
                  <>
                    <h2 className="h-sm">{t('time.whenSuits', { day: dayName })}</h2>
                    <div className="seg seg-full" role="group" aria-label={t('time.windowLabel')}>
                      {FLEXIBLE_WINDOWS.map((w) => (
                        <button
                          key={w}
                          type="button"
                          className={`window-btn ${window === w ? 'on' : ''}`}
                          aria-pressed={window === w}
                          onClick={() => setWindow(w)}
                        >
                          <span className="block">{t(`time.window.${w}`)}</span>
                          {w !== 'any' && (
                            <span className="tiny block window-range">
                              {t('time.range', { from: `${String(WINDOWS[w].from).padStart(2, '0')}:00`, to: `${WINDOWS[w].to}:00` })}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    {pending ? (
                      <p className="info">
                        <Icon name="clock" />
                        <span>
                          <b>{t('time.flexibleTitle')}</b> {t('time.flexibleText')}
                        </span>
                      </p>
                    ) : !canFlex ? (
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
                    {pending ? (
                      <SlotPlaceholders count={placeholderCount(loaded, timezone)} label={t('common.loading')} />
                    ) : daySlots.length === 0 ? (
                      <p className="card">{t('book.noSlots')}</p>
                    ) : (
                      <div className="slots">
                        {daySlots.map((s) => {
                          const chosen = slot?.startsAt === s.startsAt;
                          // A time that freed up and is held for this customer for 15 minutes (D74).
                          const heldUntil = held.find(
                            (h) => h.startsAt === s.startsAt && new Date(h.expiresAt).getTime() > Date.now(),
                          )?.expiresAt;
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
                              className={`slot ${chosen ? 'on' : ''} ${heldUntil ? 'held' : ''}`}
                              aria-pressed={chosen}
                              onClick={() => setSlot(s)}
                            >
                              {time(s.startsAt, timezone)}
                              <small>
                                {heldUntil
                                  ? t('time.heldUntil', { time: time(heldUntil, timezone) })
                                  : t('time.prosFree', { count: s.freePros })}
                              </small>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <button
                      type="button"
                      className="card row wait-day"
                      aria-pressed={dayWaiting}
                      disabled={wait.busy || pending}
                      onClick={() => void toggleWait(waitlist, shownDay, null)}
                    >
                      <span className="wait-icon" aria-hidden="true">
                        <Icon name="bell" />
                      </span>
                      <span className="grow">
                        <span className="b small block">{dayWaiting ? t('time.dayWaiting') : t('time.joinDay')}</span>
                        <span className="tiny muted">
                          {dayWaiting ? t('time.dayWaitingText', { day: dayName }) : t('time.joinDayText')}
                        </span>
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
                  </>
                )}
                {summary}
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
