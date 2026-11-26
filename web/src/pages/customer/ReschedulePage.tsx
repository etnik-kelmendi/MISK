import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { CustomerBooking, ServiceDay, Slot } from '../../api/types';
import { useResource } from '../../api/useResource';
import { DateBar } from '../../components/DatePicker';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, dayKey, dayName, dayParts, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { AppHeader } from '../../shells/Shells';
import { placeholderCount, rangeOf, SlotPlaceholders, weekFor, weekQuery, type Availability } from './ChooseTimeStep';

/**
 * The picker: a week of days with the date picker for any day up to the booking horizon (D101), and the free
 * times for this booking's services, without the waiting list or flexible times.
 */
function TimePicker({ booking }: { booking: CustomerBooking }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone } = useMarket();
  const ids = booking.services.map((service) => service.id).join(',');
  const [today] = useState(() => dayKey(new Date().toISOString(), timezone));
  const [day, setDay] = useState<string | null>(null);
  // The Monday of the week shown.
  const [week, setWeek] = useState<string>(() => weekFor(today));
  const base = `serviceIds=${encodeURIComponent(ids)}&postcode=${encodeURIComponent(booking.postcode)}`;
  const load = useCallback(
    // The booking being moved does not count against its new time (D75).
    () =>
      api
        .get<Availability>(`/availability?${base}&bookingId=${encodeURIComponent(booking.id)}${weekQuery(week, today)}`)
        .then((data) => ({ ...data, requested: week })),
    [api, base, booking.id, week, today],
  );
  const loadMonth = useCallback(
    (month: string) =>
      api.get<{ days: ServiceDay[] }>(`/availability/calendar?${base}&month=${encodeURIComponent(month)}`).then((data) => data.days),
    [api, base],
  );
  const { state, reload } = useResource(load);
  const [slot, setSlot] = useState<Slot | null>(null);
  const move = useAction();
  const whenLabel = (iso: string) => {
    const parts = dayParts(iso, timezone);
    return `${parts.weekday} ${parts.day} ${parts.month}, ${time(iso, timezone)}`;
  };

  async function submit() {
    if (!slot) return;
    const moved = await move.run(() =>
      api.post<{ booking: CustomerBooking }>(`/bookings/${encodeURIComponent(booking.id)}/reschedule`, { startsAt: slot.startsAt }),
    );
    if (moved) navigate(`/bookings/${encodeURIComponent(booking.id)}`, { replace: true });
  }

  return (
    <ResourceState state={state} reload={reload}>
      {({ slots: loaded, range: loadedRange, requested }) => {
        const range = rangeOf(loadedRange, today);
        // A new week is on its way: the page keeps its shape, with grey boxes where its times will be.
        const pending = requested !== week;
        const slots = pending ? [] : loaded;
        const days = [...new Set(slots.map((s) => dayKey(s.startsAt, timezone)))];
        const isCurrent = (s: Slot) => new Date(s.startsAt).getTime() === new Date(booking.startsAt).getTime();
        const choosable = (s: Slot) => s.available && !isCurrent(s);
        const firstBookable = week < range.today ? range.today : week;
        const shownDay =
          day && weekFor(day) === week
            ? day
            : pending
              ? firstBookable
              : (days.find((d) => slots.some((s) => choosable(s) && dayKey(s.startsAt, timezone) === d)) ?? days[0] ?? firstBookable);
        const daySlots = slots.filter((s) => dayKey(s.startsAt, timezone) === shownDay);
        const chosen = slot && dayKey(slot.startsAt, timezone) === shownDay ? slot : null;
        const dateBar = (
          <DateBar
            selected={shownDay}
            range={range}
            week={week}
            loadMonth={loadMonth}
            onSelect={(next) => {
              setDay(next);
              setSlot(null);
              setWeek(weekFor(next));
            }}
            onWeek={(monday) => {
              setDay(null);
              setSlot(null);
              setWeek(monday);
            }}
          />
        );
        return (
          <>
            {dateBar}
            <h2 className="h-sm">{t('book.times')}</h2>
            {pending ? (
              <SlotPlaceholders count={placeholderCount(loaded, timezone)} label={t('common.loading')} />
            ) : daySlots.length === 0 ? (
              <p className="card">{t('book.noSlots')}</p>
            ) : (
              <div className="slots">
                {daySlots.map((s) =>
                  choosable(s) ? (
                    <button
                      key={s.startsAt}
                      type="button"
                      className={`slot ${chosen?.startsAt === s.startsAt ? 'on' : ''}`}
                      aria-pressed={chosen?.startsAt === s.startsAt}
                      onClick={() => setSlot(s)}
                    >
                      {time(s.startsAt, timezone)}
                      <small>{t('time.prosFree', { count: s.freePros })}</small>
                    </button>
                  ) : (
                    <button key={s.startsAt} type="button" className="slot off" disabled>
                      <span className="tm">{time(s.startsAt, timezone)}</span>
                      <small>{isCurrent(s) ? t('reschedule.current') : t('reschedule.full')}</small>
                    </button>
                  ),
                )}
              </div>
            )}
            <p className="info">
              <Icon name="clock" />
              <span>{t('reschedule.rules')}</span>
            </p>
            <ErrorText error={move.error} />
            <div className="cta-bar">
              <button className="cta" type="button" disabled={!chosen || move.busy} onClick={() => void submit()}>
                {chosen ? t('reschedule.moveTo', { when: whenLabel(chosen.startsAt) }) : t('reschedule.choose')}
              </button>
            </div>
          </>
        );
      }}
    </ResourceState>
  );
}

/** Reschedule (D75): move a booking to another free time, free until 24 hours before it starts. */
export function ReschedulePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ booking: CustomerBooking }>(`/bookings/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload } = useResource(load);
  return (
    <>
      <AppHeader title={t('reschedule.title')} back={`/bookings/${encodeURIComponent(id)}`} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ booking }) => (
            <>
              <div className="card">
                <span className="b small block">{booking.serviceName}</span>
                <span className="tiny muted block">
                  {booking.flexibleWindow && !booking.timeConfirmed
                    ? t('reschedule.currentWindow', {
                        day: dayName(booking.startsAt, timezone),
                        window: t(`time.window.${booking.flexibleWindow}`).toLowerCase(),
                      })
                    : t('reschedule.currentTime', { when: dateTime(booking.startsAt, timezone) })}
                </span>
              </div>
              {booking.canReschedule ? (
                <TimePicker booking={booking} />
              ) : (
                <div className="card center stack">
                  <p className="muted">{t('reschedule.notPossible')}</p>
                  <Link to={`/bookings/${booking.id}`} className="btn btn-ghost">
                    {t('reschedule.backToBooking')}
                  </Link>
                </div>
              )}
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
