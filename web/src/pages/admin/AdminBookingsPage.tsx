import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { AdminBookingListItem, BookingStatus } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro } from '../../lib/format';

const STATUSES: BookingStatus[] = ['unassigned', 'searching', 'awaiting_payment', 'accepted', 'on_the_way', 'working', 'completed', 'cancelled'];

export function AdminBookingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const load = useCallback(() => {
    const search = new URLSearchParams();
    if (status) search.set('status', status);
    if (submitted) search.set('q', submitted);
    return api.get<{ bookings: AdminBookingListItem[] }>(`/admin/bookings?${search.toString()}`);
  }, [api, status, submitted]);
  const { state, reload } = useResource(load);

  return (
    <>
      <h1>{t('admin.bookings.title')}</h1>
      <form
        className="row gap8 wrap filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <div className="af">
          <label htmlFor="status-filter">{t('admin.bookings.status')}</label>
          <select id="status-filter" value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
            <option value="">{t('admin.bookings.all')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="af grow">
          <label htmlFor="search">{t('admin.bookings.search')}</label>
          <input id="search" type="search" maxLength={60} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="submit" className="abtn ghost">
          {t('admin.bookings.find')}
        </button>
      </form>
      <ResourceState state={state} reload={reload}>
        {({ bookings }) =>
          bookings.length === 0 ? (
            <p className="panel muted">{t('admin.bookings.none')}</p>
          ) : (
            <div className="panel scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.bookings.when')}</th>
                    <th scope="col">{t('admin.bookings.service')}</th>
                    <th scope="col">{t('admin.bookings.customer')}</th>
                    <th scope="col">{t('admin.bookings.pro')}</th>
                    <th scope="col">{t('admin.bookings.status')}</th>
                    <th scope="col">{t('admin.bookings.value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr key={b.id} className={b.status === 'unassigned' ? 'hl' : ''}>
                      <td>{dateTime(b.startsAt, timezone)}</td>
                      <td>
                        <Link to={`/admin/bookings/${b.id}`} className="b">
                          {b.serviceName}
                        </Link>
                      </td>
                      <td>
                        {b.customerName} · {b.postcode}
                      </td>
                      <td>{b.proName ?? '–'}</td>
                      <td>
                        <StatusBadge status={b.status} />
                      </td>
                      <td>{euro(b.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceState>
    </>
  );
}
