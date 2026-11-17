import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingListItem, PlanVisitItem } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, dayParts, euro, time } from '../../lib/format';
import { RECENT_BOOKINGS } from '../../lib/recent';
import { AppHeader } from '../../shells/Shells';
import { ReceiptSheet, ReportSheet } from './BookingSheets';
import { CATEGORY_COLORS } from './categoryColors';

type Tab = 'upcoming' | 'past';
const DONE = new Set(['completed', 'cancelled']);

/** The year of a date in the market's time zone, for "This year". */
function yearOf(iso: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric' }).format(new Date(iso)));
}

function BookingRow({
  booking,
  onReceipt,
  onReport,
}: {
  booking: BookingListItem;
  onReceipt: () => void;
  onReport: () => void;
}) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const color = CATEGORY_COLORS[booking.categoryIcon ?? 'leaf'];
  const upcoming = !DONE.has(booking.status);
  const unread = booking.unreadMessages ?? 0;
  return (
    <li className="card booking-row">
      <div className="row">
        <span className="cat-icon" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
          <Icon name={booking.categoryIcon ?? 'leaf'} />
        </span>
        <div className="grow min0">
          <Link to={`/bookings/${booking.id}`} className="b small ellipsis block link-plain">
            {booking.serviceName}
          </Link>
          <span className="tiny muted block">
            {dateTime(booking.startsAt, timezone)}
            {booking.proName && ` · ${booking.proName}`}
          </span>
        </div>
        <span className="right">
          <span className="b small block">{euro(booking.totalCents)}</span>
          {booking.problemOpen ? <span className="badge r">{t('bookings.onHold')}</span> : <StatusBadge status={booking.status} />}
        </span>
      </div>
      <div className="row gap6 booking-actions">
        {upcoming ? (
          <>
            <Link to={`/bookings/${booking.id}`} className="mini-btn green">
              {t('bookings.track')}
            </Link>
            {booking.proName && (
              <Link to={`/bookings/${booking.id}/chat`} className="mini-btn">
                <Icon name="chat" /> {t('bookings.chat')}
                {unread > 0 && <span className="count-badge">{t('bookings.unread', { count: unread })}</span>}
              </Link>
            )}
          </>
        ) : (
          <>
            {booking.hasReceipt && (
              <button type="button" className="mini-btn green" onClick={onReceipt}>
                <Icon name="file" /> {t('bookings.receipt')}
              </button>
            )}
            {booking.canRate && (
              <Link to={`/bookings/${booking.id}/rate`} className="mini-btn">
                {t('bookings.rateNow')}
              </Link>
            )}
            {booking.categorySlug && booking.categoryActive !== false && (
              <Link to={`/category/${booking.categorySlug}`} className="mini-btn">
                {t('bookings.bookAgain')}
              </Link>
            )}
            {booking.canReportProblem && (
              <button type="button" className="mini-btn danger push-right" onClick={onReport}>
                {t('bookings.report')}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function PlanVisitRow({ visit }: { visit: PlanVisitItem }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const day = dayParts(visit.startsAt, timezone);
  return (
    <li>
      <Link to={`/my-plans/${visit.subscriptionId}`} className="visit link-plain">
        <span className="vd">
          <span className="tiny muted block">{day.weekday}</span>
          <span className="b block">{day.day}</span>
          <span className="tiny muted block">{day.month}</span>
        </span>
        <span className="grow">
          <span className="b small block">{visit.planName}</span>
          <span className="tiny muted block">
            {time(visit.startsAt, timezone)} – {time(visit.endsAt, timezone)}
            {visit.proName && ` · ${visit.proName}`}
          </span>
        </span>
        <span className="badge g">{t('bookings.planVisit')}</span>
      </Link>
    </li>
  );
}

/** Bookings (D67): upcoming jobs and plan visits, and past bookings with their receipts. */
export function BookingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'past' ? 'past' : 'upcoming';
  const load = useCallback(() => api.get<{ bookings: BookingListItem[]; planVisits?: PlanVisitItem[] }>('/bookings'), [api]);
  const { state, reload } = useResource(load);
  const [showAll, setShowAll] = useState(false);
  const [sheet, setSheet] = useState<{ kind: 'receipt' | 'report'; booking: BookingListItem } | null>(null);
  const year = yearOf(new Date().toISOString(), timezone);

  function choose(next: Tab) {
    setShowAll(false);
    setParams(next === 'past' ? { tab: 'past' } : {}, { replace: true });
  }

  return (
    <>
      <AppHeader title={t('bookings.title')} />
      <div className="body">
        <div className="seg seg-full" role="group" aria-label={t('bookings.tabs')}>
          {(['upcoming', 'past'] as const).map((value) => (
            <button key={value} type="button" className={tab === value ? 'on' : ''} aria-pressed={tab === value} onClick={() => choose(value)}>
              {t(`bookings.tab.${value}`)}
            </button>
          ))}
        </div>
        <ResourceState state={state} reload={reload}>
          {({ bookings, planVisits = [] }) => {
            const upcoming = bookings.filter((b) => !DONE.has(b.status));
            // Open bookings come first from the API, then the newest, so the past list is newest first.
            const past = bookings.filter((b) => DONE.has(b.status));
            const row = (booking: BookingListItem) => (
              <BookingRow
                key={booking.id}
                booking={booking}
                onReceipt={() => setSheet({ kind: 'receipt', booking })}
                onReport={() => setSheet({ kind: 'report', booking })}
              />
            );
            if (tab === 'upcoming') {
              return upcoming.length === 0 && planVisits.length === 0 ? (
                <div className="card center stack">
                  <p className="muted">{bookings.length === 0 ? t('bookings.empty') : t('bookings.noUpcoming')}</p>
                  <Link to="/" className="btn btn-primary">
                    {t('bookings.bookFirst')}
                  </Link>
                </div>
              ) : (
                <>
                  {upcoming.length > 0 && (
                    <ul className="stack" aria-label={t('bookings.tab.upcoming')}>
                      {upcoming.map(row)}
                    </ul>
                  )}
                  {planVisits.length > 0 && (
                    <section aria-labelledby="plan-visits">
                      <h2 id="plan-visits" className="h-sm">
                        {t('bookings.planVisits')}
                      </h2>
                      <ul className="stack">
                        {planVisits.map((visit) => (
                          <PlanVisitRow key={visit.id} visit={visit} />
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              );
            }
            const thisYear = past.filter((b) => yearOf(b.completedAt ?? b.startsAt, timezone) === year);
            const receipts = thisYear.filter((b) => b.hasReceipt).length;
            return past.length === 0 ? (
              <div className="card center">
                <p className="muted">{t('bookings.noPast')}</p>
              </div>
            ) : (
              <>
                <h2 className="h-sm">{t('bookings.thisYear', { count: thisYear.length })}</h2>
                <ul className="stack" aria-label={t('bookings.tab.past')}>
                  {(showAll ? past : past.slice(0, RECENT_BOOKINGS)).map(row)}
                </ul>
                {past.length > RECENT_BOOKINGS && (
                  <button type="button" className="btn btn-ghost" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                    {showAll ? t('bookings.showRecent', { count: RECENT_BOOKINGS }) : t('bookings.viewAll', { count: past.length })}
                  </button>
                )}
                {receipts > 0 && (
                  <a className="cta ghost" href={`${api.baseUrl}/bookings/receipts.pdf?year=${year}`} download>
                    <Icon name="upload" /> {t('bookings.downloadAll', { year })}
                  </a>
                )}
              </>
            );
          }}
        </ResourceState>
      </div>
      {sheet?.kind === 'receipt' && <ReceiptSheet bookingId={sheet.booking.id} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'report' && (
        <ReportSheet
          booking={sheet.booking}
          onClose={() => setSheet(null)}
          onReported={() => {
            setSheet(null);
            reload();
          }}
        />
      )}
    </>
  );
}
