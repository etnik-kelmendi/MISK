import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingListItem } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro } from '../../lib/format';
import { RECENT_BOOKINGS } from '../../lib/recent';
import { AppHeader } from '../../shells/Shells';

export function BookingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ bookings: BookingListItem[] }>('/bookings'), [api]);
  const { state, reload } = useResource(load);
  const [showAll, setShowAll] = useState(false);

  return (
    <>
      <AppHeader title={t('bookings.title')} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ bookings }) =>
            bookings.length === 0 ? (
              <div className="card center">
                <p>{t('bookings.empty')}</p>
                <Link to="/" className="btn btn-primary">
                  {t('bookings.bookFirst')}
                </Link>
              </div>
            ) : (
              <>
                <ul className="stack">
                  {/* Open bookings come first, then the newest, so the first ten are the most recent. */}
                  {(showAll ? bookings : bookings.slice(0, RECENT_BOOKINGS)).map((booking) => (
                    <li key={booking.id}>
                      <Link to={`/bookings/${booking.id}`} className="card row link-card">
                        <span className="grow">
                          <span className="b block">{booking.serviceName}</span>
                          <span className="small muted block">{dateTime(booking.startsAt, timezone)}</span>
                          {booking.proName && <span className="small muted">{t('bookings.with', { name: booking.proName })}</span>}
                        </span>
                        <span className="right">
                          <StatusBadge status={booking.status} />
                          <span className="b small block">{euro(booking.totalCents)}</span>
                          {booking.canRate && <span className="badge a">{t('bookings.rateNow')}</span>}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {bookings.length > RECENT_BOOKINGS && (
                  <button type="button" className="btn btn-ghost" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                    {showAll ? t('bookings.showRecent', { count: RECENT_BOOKINGS }) : t('bookings.viewAll', { count: bookings.length })}
                  </button>
                )}
              </>
            )
          }
        </ResourceState>
      </div>
    </>
  );
}
