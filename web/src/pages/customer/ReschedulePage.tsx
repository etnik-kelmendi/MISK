import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { CustomerBooking, Slot } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, dayKey, dayName, dayParts, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { AppHeader } from '../../shells/Shells';

/** The picker: the bookable days and free times for this booking's services, without the waiting list or flexible times. */
function TimePicker({ booking }: { booking: CustomerBooking }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone } = useMarket();
  const ids = booking.services.map((service) => service.id).join(',');
  const load = useCallback(
    // The booking being moved does not count against its new time (D75).
    () =>
      api.get<{ slots: Slot[] }>(
        `/availability?serviceIds=${encodeURIComponent(ids)}&postcode=${encodeURIComponent(booking.postcode)}&bookingId=${encodeURIComponent(booking.id)}`,
      ),
    [api, ids, booking.postcode, booking.id],
  );
  const { state, reload } = useResource(load);
  const [day, setDay] = useState<string | null>(null);
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
      {({ slots }) => {
        const days = [...new Set(slots.map((s) => dayKey(s.startsAt, timezone)))];
        if (days.length === 0) return <p className="card">{t('book.noSlots')}</p>;
        const isCurrent = (s: Slot) => new Date(s.startsAt).getTime() === new Date(booking.startsAt).getTime();
        const choosable = (s: Slot) => s.available && !isCurrent(s);
        const shownDay =
          day && days.includes(day)
            ? day
            : (days.find((d) => slots.some((s) => choosable(s) && dayKey(s.startsAt, timezone) === d)) ?? days[0] ?? '');
        const daySlots = slots.filter((s) => dayKey(s.startsAt, timezone) === shownDay);
        const firstOfDay = daySlots[0]?.startsAt ?? new Date().toISOString();
        const month = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, month: 'long', year: 'numeric' }).format(new Date(firstOfDay));
        const chosen = slot && dayKey(slot.startsAt, timezone) === shownDay ? slot : null;
        return (
          <>
            <h2 className="h-sm">{month}</h2>
            <div className="days days-fit" role="group" aria-label={t('book.day')}>
              {days.map((d) => {
                const first = slots.find((s) => dayKey(s.startsAt, timezone) === d);
                const parts = first ? dayParts(first.startsAt, timezone) : null;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`day ${d === shownDay ? 'on' : ''}`}
                    aria-pressed={d === shownDay}
                    onClick={() => {
                      setDay(d);
                      setSlot(null);
                    }}
                  >
                    <span className="dn">{parts?.weekday}</span>
                    <span className="dd">{parts?.day}</span>
                  </button>
                );
              })}
            </div>
            <h2 className="h-sm">{t('book.times')}</h2>
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
