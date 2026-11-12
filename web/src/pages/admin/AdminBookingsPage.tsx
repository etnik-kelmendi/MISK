import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import {
  ADMIN_TABS,
  type AdminBookingList,
  type AdminBookingListItem,
  type AdminCategory,
  type AdminTab,
  type BookingStatus,
  type PaymentStatus,
  type VisitStatus,
} from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { downloadFile, toCsv } from '../../lib/csv';
import { dateTime, euro, zonedParts } from '../../lib/format';
import { usePolling } from '../../lib/usePolling';
import { RECENT_BOOKINGS } from '../../lib/recent';
import { AdminBookingDrawer, REFRESH_MS, type OpenItem } from './AdminBookingDrawer';

const SEARCH_DELAY_MS = 250;

const VISIT_TONE: Record<VisitStatus, string> = { planned: 'b', skipped: 'grey', completed: 'g', cancelled: 'grey' };
type SubscriptionStatus = 'awaiting_payment' | 'active' | 'past_due' | 'cancelled';

function isTab(value: string | null): value is AdminTab {
  return ADMIN_TABS.some((tab) => tab === value);
}

/** "b:<id>" or "v:<id>" in the address bar keeps the open booking across reloads and shared links. */
export function parseOpen(value: string | null): OpenItem | null {
  const match = value ? /^([bv]):([0-9a-f-]{36})$/i.exec(value) : null;
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { kind: match[1] === 'b' ? 'booking' : 'visit', id: match[2] };
}

export function ItemStatus({ item }: { item: Pick<AdminBookingListItem, 'kind' | 'status'> }) {
  const { t } = useTranslation();
  if (item.kind === 'visit') {
    const status = item.status as VisitStatus;
    return <span className={`badge ${VISIT_TONE[status]}`}>{t(`admin.bookings.visitStatus.${status}`)}</span>;
  }
  return <StatusBadge status={item.status as BookingStatus} />;
}

export function AdminBookingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: AdminTab = isTab(tabParam) ? tabParam : 'all';
  const q = params.get('q') ?? '';
  const trade = params.get('trade') ?? '';
  const typeParam = params.get('type');
  const type = typeParam === 'booking' || typeParam === 'visit' ? typeParam : '';
  const open = parseOpen(params.get('open'));
  // "View all" is kept in the address, so it survives the automatic refresh and a reload.
  const showAll = params.get('view') === 'all';
  const [typed, setTyped] = useState(q);
  const returnFocus = useRef<HTMLElement | null>(null);

  const change = useCallback(
    (next: Record<string, string>) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          for (const [key, value] of Object.entries(next)) {
            if (value) updated.set(key, value);
            else updated.delete(key);
          }
          // Another tab, search or filter starts again with the most recent ten.
          if (['tab', 'q', 'trade', 'type'].some((key) => key in next)) {
            updated.delete('view');
          }
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Search as the admin types, without a request per key press.
  useEffect(() => {
    const trimmed = typed.trim();
    if (trimmed === q) {
      return;
    }
    const timer = setTimeout(() => change({ q: trimmed }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, q, change]);

  const load = useCallback(() => {
    const search = new URLSearchParams({ tab });
    if (q) search.set('q', q);
    if (trade) search.set('trade', trade);
    if (type) search.set('type', type);
    return api.get<AdminBookingList>(`/admin/bookings?${search.toString()}`);
  }, [api, tab, q, trade, type]);
  const { state, reload } = useResource(load);
  usePolling(reload, REFRESH_MS);

  const loadTrades = useCallback(() => api.get<{ categories: AdminCategory[] }>('/admin/catalogue'), [api]);
  const trades = useResource(loadTrades);

  function openItem(item: AdminBookingListItem, from: HTMLElement) {
    returnFocus.current = from;
    change({ open: `${item.kind === 'booking' ? 'b' : 'v'}:${item.id}` });
  }

  const closeItem = useCallback(() => {
    change({ open: '' });
    returnFocus.current?.focus();
  }, [change]);

  function typeLabel(item: AdminBookingListItem) {
    return item.kind === 'booking' ? t('admin.bookings.typeBooking') : t('admin.bookings.typeVisit');
  }

  function statusLabel(item: AdminBookingListItem) {
    return item.kind === 'booking'
      ? t(`status.${item.status as BookingStatus}`)
      : t(`admin.bookings.visitStatus.${item.status as VisitStatus}`);
  }

  function paymentLabel(item: AdminBookingListItem) {
    return item.kind === 'booking'
      ? t(`payment.${item.paymentStatus as PaymentStatus}`)
      : t(`admin.bookings.subscription.${item.paymentStatus as SubscriptionStatus}`);
  }

  /** Every row of the current tab, search and filters, including those beyond the ten shown first. */
  function exportShown(items: AdminBookingListItem[]) {
    const columns = ['number', 'date', 'time', 'service', 'trade', 'type', 'customer', 'address', 'pro', 'status', 'value', 'payment'] as const;
    const rows = items.map((item) => {
      const when = zonedParts(item.startsAt, timezone);
      return [
        item.number,
        when.date,
        when.time,
        item.service,
        item.trade,
        typeLabel(item),
        item.customer,
        `${item.address}, ${item.postcode}`,
        item.pro ?? t('admin.bookings.unassigned'),
        statusLabel(item),
        (item.valueCents / 100).toFixed(2),
        paymentLabel(item),
      ];
    });
    const now = zonedParts(new Date().toISOString(), timezone);
    const tradeName =
      trade && trades.state.status === 'ready' ? (trades.state.data.categories.find((c) => c.id === trade)?.name ?? trade) : '';
    // What was exported: the tab, search and filters on screen, so the file explains itself later.
    const applied: [string, string][] = [
      [t('admin.bookings.csv.tab'), t(`admin.bookings.tab.${tab}`)],
      [t('admin.bookings.csv.search'), q || t('admin.bookings.csv.none')],
      [t('admin.bookings.csv.tradeFilter'), tradeName || t('admin.bookings.allTrades')],
      [t('admin.bookings.csv.typeFilter'), type ? t(type === 'booking' ? 'admin.bookings.typeBooking' : 'admin.bookings.typeVisit') : t('admin.bookings.allTypes')],
      [t('admin.bookings.csv.exported'), `${now.date} ${now.time}`],
      [t('admin.bookings.csv.count'), String(items.length)],
    ];
    // The file name says it too, e.g. misk-bookings-needs-action-gardening-2026-11-11.csv.
    const slug = (text: string) =>
      text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
    const parts = [tab === 'all' ? '' : tab.replace('_', '-'), slug(tradeName), type, q ? `search-${slug(q)}` : ''].filter(Boolean);
    downloadFile(
      t('admin.bookings.exportFile', { filters: parts.length ? `-${parts.join('-')}` : '', date: now.date }),
      toCsv([...applied, [], columns.map((key) => t(`admin.bookings.csv.${key}`)), ...rows]),
    );
  }

  const ready = state.status === 'ready' ? state.data : null;

  return (
    <>
      <div className="row between wrap gap8">
        <h1>{t('admin.bookings.title')}</h1>
        <button
          type="button"
          className="abtn ghost"
          disabled={!ready || ready.bookings.length === 0}
          onClick={() => {
            if (ready) exportShown(ready.bookings);
          }}
        >
          <Icon name="file" /> {t('admin.bookings.export')}
        </button>
      </div>

      <div className="seg wrap" role="group" aria-label={t('admin.bookings.tabsLabel')}>
        {ADMIN_TABS.map((key) => (
          <button
            key={key}
            type="button"
            className={key === tab ? 'on' : ''}
            aria-pressed={key === tab}
            onClick={() => change({ tab: key === 'all' ? '' : key })}
          >
            {t('admin.bookings.tabCount', { label: t(`admin.bookings.tab.${key}`), count: ready?.counts[key] ?? 0 })}
          </button>
        ))}
      </div>

      <div className="row gap8 wrap filters">
        <div className="af grow">
          <label htmlFor="booking-search">{t('admin.bookings.search')}</label>
          <input
            id="booking-search"
            type="search"
            maxLength={60}
            placeholder={t('admin.bookings.searchHint')}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className="af">
          <label htmlFor="trade-filter">{t('admin.bookings.trade')}</label>
          <select id="trade-filter" value={trade} onChange={(event) => change({ trade: event.target.value })}>
            <option value="">{t('admin.bookings.allTrades')}</option>
            {trades.state.status === 'ready' &&
              trades.state.data.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
          </select>
        </div>
        <div className="af">
          <label htmlFor="type-filter">{t('admin.bookings.type')}</label>
          <select id="type-filter" value={type} onChange={(event) => change({ type: event.target.value })}>
            <option value="">{t('admin.bookings.allTypes')}</option>
            <option value="booking">{t('admin.bookings.typeBooking')}</option>
            <option value="visit">{t('admin.bookings.typeVisit')}</option>
          </select>
        </div>
      </div>

      <ResourceState state={state} reload={reload}>
        {({ bookings, truncated }) =>
          bookings.length === 0 ? (
            <p className="panel muted">{t('admin.bookings.none')}</p>
          ) : (
            <div className="panel scroll-x">
              <table className="t clickable">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.bookings.number')}</th>
                    <th scope="col">{t('admin.bookings.date')}</th>
                    <th scope="col">{t('admin.bookings.service')}</th>
                    <th scope="col">{t('admin.bookings.customer')}</th>
                    <th scope="col">{t('admin.bookings.pro')}</th>
                    <th scope="col">{t('admin.bookings.status')}</th>
                    <th scope="col">{t('admin.bookings.price')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? bookings : bookings.slice(0, RECENT_BOOKINGS)).map((item) => (
                    <tr
                      key={`${item.kind}-${item.id}`}
                      className={item.tab === 'needs_action' ? 'hl' : ''}
                      onClick={(event) => openItem(item, event.currentTarget.querySelector('button') ?? event.currentTarget)}
                    >
                      <td>
                        <button
                          type="button"
                          className="link b"
                          aria-label={t('admin.bookings.open', { number: item.number })}
                          onClick={(event) => {
                            event.stopPropagation();
                            openItem(item, event.currentTarget);
                          }}
                        >
                          {item.number}
                        </button>
                      </td>
                      <td>{dateTime(item.startsAt, timezone)}</td>
                      <td>
                        {item.service}
                        <div className="small muted">
                          {item.trade} · {typeLabel(item)}
                        </div>
                      </td>
                      <td>
                        {item.customer}
                        <div className="small muted">{item.address}</div>
                      </td>
                      <td>{item.pro ?? <span className="unassigned">{t('admin.bookings.unassigned')}</span>}</td>
                      <td>
                        <ItemStatus item={item} />
                        {item.problem && <div className="small unassigned">{t('admin.bookings.problem')}</div>}
                      </td>
                      <td>{euro(item.valueCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bookings.length > RECENT_BOOKINGS && (
                <div className="row between wrap gap8 view-all">
                  <p className="small muted">
                    {showAll
                      ? t('admin.bookings.showingAll', { count: bookings.length })
                      : t('admin.bookings.showingRecent', { shown: RECENT_BOOKINGS, count: bookings.length })}
                  </p>
                  {showAll ? (
                    <button type="button" className="abtn ghost" onClick={() => change({ view: '' })}>
                      {t('admin.bookings.showRecent', { count: RECENT_BOOKINGS })}
                    </button>
                  ) : (
                    <button type="button" className="abtn" onClick={() => change({ view: 'all' })}>
                      {t('admin.bookings.viewAll', { count: bookings.length })}
                    </button>
                  )}
                </div>
              )}
              {showAll && truncated && <p className="small muted">{t('admin.bookings.truncated', { count: bookings.length })}</p>}
            </div>
          )
        }
      </ResourceState>
      <p className="small muted">{t('admin.bookings.updated')}</p>

      {open && <AdminBookingDrawer item={open} onClose={closeItem} onChanged={reload} />}
    </>
  );
}
