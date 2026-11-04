import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingListItem } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useUser } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime } from '../../lib/format';
import { CATEGORY_COLORS } from './categoryColors';

const ACTIVE = new Set(['awaiting_payment', 'searching', 'unassigned', 'accepted', 'on_the_way', 'working']);

export function HomePage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const market = useMarket();
  const load = useCallback(() => api.get<{ bookings: BookingListItem[] }>('/bookings'), [api]);
  const { state } = useResource(load);
  const active = state.status === 'ready' ? state.data.bookings.filter((b) => ACTIVE.has(b.status)).slice(0, 3) : [];

  return (
    <div className="body">
      <div className="greeting">
        <p className="muted small">{t('home.hello')}</p>
        <h1>{t('home.name', { name: user.firstName ?? '' })}</h1>
      </div>

      {active.length > 0 && (
        <section aria-labelledby="active-heading">
          <h2 id="active-heading" className="h-sm">
            {t('home.upcoming')}
          </h2>
          {active.map((booking) => (
            <Link key={booking.id} to={`/bookings/${booking.id}`} className="card row link-card">
              <span className="grow">
                <span className="b block">{booking.serviceName}</span>
                <span className="small muted">{dateTime(booking.startsAt, market.timezone)}</span>
              </span>
              <StatusBadge status={booking.status} />
            </Link>
          ))}
        </section>
      )}

      <section aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="h-sm">
          {t('home.categories')}
        </h2>
        {market.categories.length === 0 ? (
          <p className="card muted">{t('home.noCategories')}</p>
        ) : (
          <ul className="cats">
            {market.categories.map((category) => {
              const color = CATEGORY_COLORS[category.icon];
              return (
                <li key={category.id}>
                  <Link to={`/category/${category.slug}`} className="cat">
                    <span className="ci" style={{ background: color.bg, color: color.fg }}>
                      <Icon name={category.icon} />
                    </span>
                    {category.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="info">
        <Icon name="shield" />
        <p>{t('home.trust')}</p>
      </div>
    </div>
  );
}
