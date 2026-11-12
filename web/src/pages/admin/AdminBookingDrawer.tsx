import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { AdminAction, AdminBooking, AdminVisit, BookingStatus } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Drawer } from '../../components/Drawer';
import { ErrorText } from '../../components/ErrorText';
import { PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro, zonedParts, zonedToIso } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { CustomerProfileCard } from './CustomerProfileCard';

/** Open bookings and the list refresh themselves this often, so statuses change on screen as pros work. */
export const REFRESH_MS = 15_000;

export interface OpenItem {
  kind: 'booking' | 'visit';
  id: string;
}

interface Candidate {
  id: string;
  firstName: string | null;
  distanceKm: number;
  ratingAverage: number | null;
}

const STEPS = ['booked', 'confirmed', 'on_the_way', 'working', 'done'] as const;
const STEP_OF: Record<BookingStatus, number> = {
  awaiting_payment: 0,
  searching: 0,
  unassigned: 0,
  accepted: 1,
  on_the_way: 2,
  working: 3,
  completed: 4,
  cancelled: -1,
};
const REASSIGNABLE = new Set<BookingStatus>(['searching', 'unassigned', 'accepted', 'on_the_way']);
const RESCHEDULABLE = new Set<BookingStatus>(['searching', 'unassigned', 'accepted']);

/** Booked → Pro confirmed → On the way → Working → Done. */
function Progress({ step }: { step: number }) {
  const { t } = useTranslation();
  return (
    <ol className="steps" aria-label={t('admin.booking.progress')}>
      {STEPS.map((key, index) => {
        const state = index < step || step === STEPS.length - 1 ? 'done' : index === step ? 'current' : 'todo';
        return (
          <li key={key} className={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="dot" aria-hidden="true" />
            {t(`admin.booking.steps.${key}`)}
            <span className="visually-hidden"> ({t(`admin.booking.stepState.${state}`)})</span>
          </li>
        );
      })}
    </ol>
  );
}

function MoneyRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className={strong ? 'b' : undefined}>{label}</dt>
      <dd className={strong ? 'b' : undefined}>{value}</dd>
    </>
  );
}

function ChargeNote({ booking }: { booking: AdminBooking }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const problemPhotos = booking.photos.filter((p) => p.kind === 'problem').map((p) => p.id);
  if (booking.problemReportedAt && !booking.problemResolvedAt) {
    return (
      <div className="note warn-note stack" role="status">
        <p>{t('admin.booking.problemOpen', { date: dateTime(booking.problemReportedAt, timezone) })}</p>
        <blockquote>{booking.problemNote}</blockquote>
        {problemPhotos.length > 0 ? (
          <PhotoGrid ids={problemPhotos} label={t('admin.booking.problemPhotos')} />
        ) : (
          <p className="small">{t('admin.booking.noProblemPhotos')}</p>
        )}
      </div>
    );
  }
  return (
    <>
      {booking.problemResolvedAt && (
        <div className="stack">
          <p className="small muted">{t('admin.booking.problemResolved', { date: dateTime(booking.problemResolvedAt, timezone) })}</p>
          {booking.problemNote && <blockquote className="small">{booking.problemNote}</blockquote>}
          <PhotoGrid ids={problemPhotos} label={t('admin.booking.problemPhotos')} />
        </div>
      )}
      {booking.paymentStatus === 'held' && booking.status === 'completed' && booking.chargeAt && (
        <p className="small">{t('admin.booking.chargeAt', { date: dateTime(booking.chargeAt, timezone) })}</p>
      )}
      {booking.paymentStatus === 'held' && booking.status !== 'completed' && booking.status !== 'cancelled' && (
        <p className="small muted">{t('admin.booking.chargeWhenDone')}</p>
      )}
    </>
  );
}

function LogLine({ entry }: { entry: AdminAction }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const amount = euro(entry.details.amountCents ?? 0);
  const text = (() => {
    switch (entry.action) {
      case 'assigned':
        return t('admin.booking.logAction.assigned', { name: entry.details.proName ?? '' });
      case 'rescheduled':
        return t('admin.booking.logAction.rescheduled', {
          from: entry.details.from ? dateTime(entry.details.from, timezone) : '',
          to: entry.details.to ? dateTime(entry.details.to, timezone) : '',
        });
      case 'refunded':
        return entry.details.wasCharged
          ? t('admin.booking.logAction.refunded', { amount })
          : t('admin.booking.logAction.refundedHold', { amount });
      default:
        return t(`admin.booking.logAction.${entry.action}`);
    }
  })();
  return (
    <li>
      {text}
      <div className="small muted">
        {t('admin.booking.logBy', { name: entry.adminName ?? '–', date: dateTime(entry.createdAt, timezone) })}
      </div>
    </li>
  );
}

/** Pros free at the booking's time, nearest first, each with an Assign button. */
function AssignPro({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ candidates: Candidate[] }>(`/admin/bookings/${booking.id}/candidates`), [api, booking.id]);
  const candidates = useResource(load);
  const headingId = useId();

  async function assign(proId: string, name: string) {
    const result = await action.run(() => api.post<{ booking: AdminBooking }>(`/admin/bookings/${booking.id}/reassign`, { proId }));
    if (result) {
      setDone(t('admin.booking.assign.done', { name }));
      onChanged(result.booking);
      candidates.reload();
    }
  }

  return (
    <section className="stack" aria-labelledby={headingId}>
      <h3 id={headingId} className={booking.pro ? undefined : 'unassigned'}>
        {booking.pro ? t('admin.booking.assign.titleChange') : t('admin.booking.assign.titleNoPro')}
      </h3>
      {candidates.state.status === 'loading' && <p className="small muted">{t('admin.booking.assign.loading')}</p>}
      {candidates.state.status === 'ready' &&
        (candidates.state.data.candidates.length === 0 ? (
          <p className="small muted">{t('admin.booking.assign.none')}</p>
        ) : (
          <ul className="pick-list">
            {candidates.state.data.candidates.map((c) => (
              <li key={c.id} className="row between gap8">
                <div>
                  <div className="b">{c.firstName}</div>
                  <div className="small muted">
                    {t('admin.booking.assign.line', {
                      km: c.distanceKm,
                      rating: c.ratingAverage === null ? '–' : c.ratingAverage.toFixed(1),
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  className="abtn"
                  disabled={action.busy}
                  aria-label={t('admin.booking.assign.buttonLabel', { name: c.firstName ?? '' })}
                  onClick={() => void assign(c.id, c.firstName ?? '')}
                >
                  {t('admin.booking.assign.button')}
                </button>
              </li>
            ))}
          </ul>
        ))}
      {done && (
        <p className="small ok" role="status">
          {done}
        </p>
      )}
      <ErrorText error={action.error} />
    </section>
  );
}

function MoveBooking({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const action = useAction();
  const current = zonedParts(booking.startsAt, timezone);
  const [date, setDate] = useState(current.date);
  const [time, setTime] = useState(current.time);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const headingId = useId();

  async function move() {
    setDone(false);
    const startsAt = zonedToIso(date, time, timezone);
    setInvalid(startsAt === null);
    if (!startsAt) {
      return;
    }
    const result = await action.run(() => api.post<{ booking: AdminBooking }>(`/admin/bookings/${booking.id}/reschedule`, { startsAt }));
    if (result) {
      setDone(true);
      onChanged(result.booking);
    }
  }

  return (
    <section className="stack" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('admin.booking.move.title')}</h3>
      <div className="row gap8 wrap filters">
        <div className="af">
          <label htmlFor="move-date">{t('admin.booking.move.date')}</label>
          <input id="move-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="move-time">{t('admin.booking.move.time')}</label>
          <input id="move-time" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <button type="button" className="abtn" disabled={action.busy} onClick={() => void move()}>
          {t('admin.booking.move.button')}
        </button>
      </div>
      {invalid && (
        <p className="error-text" role="alert">
          {t('admin.booking.move.invalid')}
        </p>
      )}
      {done && (
        <p className="small ok" role="status">
          {t('admin.booking.move.done')}
        </p>
      )}
      <ErrorText error={action.error} />
    </section>
  );
}

type Confirmable = 'cancel' | 'refund' | 'charge';

function MoneyActions({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [confirm, setConfirm] = useState<Confirmable | null>(null);
  const available: Confirmable[] = [];
  if (booking.status !== 'completed' && booking.status !== 'cancelled') available.push('cancel');
  if (booking.status === 'completed' && (booking.paymentStatus === 'held' || booking.paymentStatus === 'captured'))
    available.push('refund');
  if (booking.status === 'completed' && booking.paymentStatus === 'held' && booking.problemReportedAt && !booking.problemResolvedAt) {
    available.push('charge');
  }
  if (available.length === 0) {
    return null;
  }

  async function act(kind: Confirmable) {
    const result = await action.run(() => api.post<{ booking: AdminBooking }>(`/admin/bookings/${booking.id}/${kind}`));
    if (result) {
      setConfirm(null);
      onChanged(result.booking);
    }
  }

  return (
    <section className="stack">
      {confirm ? (
        <div role="alertdialog" aria-labelledby="confirm-text" className="stack confirm">
          <p id="confirm-text">{t(`admin.booking.confirm.${confirm}`)}</p>
          <div className="row gap8">
            <button type="button" className="abtn ghost" onClick={() => setConfirm(null)}>
              {t('admin.booking.keep')}
            </button>
            <button
              type="button"
              className={confirm === 'charge' ? 'abtn' : 'abtn danger'}
              disabled={action.busy}
              onClick={() => void act(confirm)}
            >
              {t(`admin.booking.do.${confirm}`)}
            </button>
          </div>
        </div>
      ) : (
        <div className="row gap8 wrap">
          {available.map((kind) => (
            <button key={kind} type="button" className="abtn ghost" onClick={() => setConfirm(kind)}>
              {t(`admin.booking.do.${kind}`)}
            </button>
          ))}
        </div>
      )}
      <ErrorText error={action.error} />
    </section>
  );
}

function BookingDetails({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const step = STEP_OF[booking.status];

  return (
    <>
      <div className="row between gap8">
        <div>
          <div className="b">{booking.serviceName}</div>
          <div className="small muted">{booking.categoryName}</div>
        </div>
        <StatusBadge status={booking.status} />
      </div>
      {step >= 0 ? (
        <Progress step={step} />
      ) : (
        <p className="note">
          {t('admin.booking.cancelledNote', {
            by: t(`admin.booking.cancelledBy.${(booking.cancelledBy ?? 'unknown') as 'customer' | 'admin' | 'system' | 'unknown'}`),
          })}
        </p>
      )}

      <dl className="kv">
        <dt>{t('admin.booking.when')}</dt>
        <dd>{dateTime(booking.startsAt, timezone)}</dd>
        <dt>{t('admin.booking.where')}</dt>
        <dd>
          {booking.address}, {booking.postcode}
        </dd>
        <dt>{t('admin.booking.customer')}</dt>
        <dd>
          {booking.customer.firstName}
          {/* Phone, email and history are in the customer profile below; without one, the phone is shown here. */}
          {!booking.customerProfile && booking.customer.phone && (
            <>
              {' · '}
              <a href={`tel:${booking.customer.phone}`}>{booking.customer.phone}</a>
            </>
          )}
        </dd>
        <dt>{t('admin.booking.pro')}</dt>
        <dd>
          {booking.pro ? (
            <>
              <Link to={`/admin/providers/${booking.pro.id}`}>{booking.pro.firstName}</Link>
              {booking.pro.phone && (
                <>
                  {' · '}
                  <a href={`tel:${booking.pro.phone}`}>{booking.pro.phone}</a>
                </>
              )}
            </>
          ) : (
            <span className="unassigned">{t('admin.booking.noPro')}</span>
          )}
        </dd>
        <dt>{t('admin.booking.notes')}</dt>
        <dd>{booking.notes || '–'}</dd>
      </dl>
      {booking.customerProfile && <CustomerProfileCard profile={booking.customerProfile} />}

      <section className="stack" aria-label={t('admin.booking.money')}>
        <h3>{t('admin.booking.money')}</h3>
        <dl className="kv money">
          <MoneyRow label={t('admin.booking.price')} value={euro(booking.priceCents)} />
          <MoneyRow label={t('admin.booking.fee')} value={euro(booking.feeCents)} />
          {booking.extrasCents > 0 && <MoneyRow label={t('admin.booking.extras')} value={euro(booking.extrasCents)} />}
          <MoneyRow label={t('admin.booking.total')} value={euro(booking.totalCents)} strong />
          <MoneyRow label={t('admin.booking.splitPro', { pct: booking.proSharePct })} value={euro(booking.split.proCents)} />
          <MoneyRow label={t('admin.booking.splitMisk')} value={euro(booking.split.miskCents)} />
          <MoneyRow label={t('admin.booking.payment')} value={t(`payment.${booking.paymentStatus}`)} />
        </dl>
        <ChargeNote booking={booking} />
      </section>

      {REASSIGNABLE.has(booking.status) && (
        <AssignPro key={`${booking.status}-${booking.pro?.id ?? ''}`} booking={booking} onChanged={onChanged} />
      )}
      {RESCHEDULABLE.has(booking.status) && <MoveBooking key={booking.id} booking={booking} onChanged={onChanged} />}
      <MoneyActions booking={booking} onChanged={onChanged} />

      <PhotoGrid ids={booking.photos.filter((p) => p.kind !== 'problem').map((p) => p.id)} label={t('admin.booking.photos')} />

      <section className="stack">
        <h3>{t('admin.booking.log')}</h3>
        {booking.actions.length === 0 ? (
          <p className="small muted">{t('admin.booking.noLog')}</p>
        ) : (
          <ul className="history">
            {booking.actions.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <section className="stack">
        <h3>{t('admin.booking.history')}</h3>
        <ol className="history">
          {booking.events.map((e, i) => (
            <li key={`${e.status}-${i}`}>
              <StatusBadge status={e.status} /> <span className="small muted">{dateTime(e.at, timezone)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="stack">
        <h3>{t('admin.booking.offers')}</h3>
        {booking.offers.length === 0 ? (
          <p className="muted small">{t('admin.booking.noOffers')}</p>
        ) : (
          <ul className="history">
            {booking.offers.map((o) => (
              <li key={o.id}>
                {o.proName} · {t(`offerStatus.${o.status}`, { defaultValue: o.status })} ·{' '}
                <span className="small muted">{dateTime(o.offeredAt, timezone)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {booking.payouts.length > 0 && (
        <section className="stack">
          <h3>{t('admin.booking.payouts')}</h3>
          <ul className="history">
            {booking.payouts.map((p, i) => (
              <li key={i}>
                {euro(p.amountCents)} · {t(`payoutStatus.${p.status}`, { defaultValue: p.status })}
                {p.error && <span className="error-text small"> {p.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function VisitDetails({ visit }: { visit: AdminVisit }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const live = visit.status === 'planned' && new Date(visit.startsAt) <= new Date();
  const step = visit.status === 'completed' ? 4 : live ? 3 : 1;

  return (
    <>
      <div className="row between gap8">
        <div>
          <div className="b">{visit.planName}</div>
          <div className="small muted">
            {visit.categoryName} · {t('admin.bookings.typeVisit')}
          </div>
        </div>
        <span className="badge b">{t(`admin.bookings.visitStatus.${visit.status}`)}</span>
      </div>
      {visit.status === 'skipped' || visit.status === 'cancelled' ? null : <Progress step={step} />}
      <dl className="kv">
        <dt>{t('admin.booking.when')}</dt>
        <dd>{dateTime(visit.startsAt, timezone)}</dd>
        <dt>{t('admin.booking.where')}</dt>
        <dd>
          {visit.address}, {visit.postcode}
        </dd>
        <dt>{t('admin.booking.customer')}</dt>
        <dd>
          {[visit.customer.firstName, visit.customer.lastName].filter(Boolean).join(' ')}
          {!visit.customerProfile && visit.customer.phone && (
            <>
              {' · '}
              <a href={`tel:${visit.customer.phone}`}>{visit.customer.phone}</a>
            </>
          )}
          {!visit.customerProfile && visit.customer.email && (
            <>
              {' · '}
              <a href={`mailto:${visit.customer.email}`}>{visit.customer.email}</a>
            </>
          )}
        </dd>
        <dt>{t('admin.booking.pro')}</dt>
        <dd>
          <Link to={`/admin/providers/${visit.pro.id}`}>{visit.pro.firstName}</Link>
          {visit.pro.phone && (
            <>
              {' · '}
              <a href={`tel:${visit.pro.phone}`}>{visit.pro.phone}</a>
            </>
          )}
        </dd>
        <dt>{t('admin.booking.visit.tasks')}</dt>
        <dd>
          {visit.tasks.join(', ')}
          {visit.status === 'completed' && (
            <div className="small muted">
              {t('admin.booking.visit.tasksDone', { done: visit.tasksDone.length, total: visit.tasks.length })}
            </div>
          )}
        </dd>
        <dt>{t('admin.booking.notes')}</dt>
        <dd>{visit.notes || '–'}</dd>
      </dl>
      {visit.customerProfile && <CustomerProfileCard profile={visit.customerProfile} />}
      <section className="stack" aria-label={t('admin.booking.money')}>
        <h3>{t('admin.booking.money')}</h3>
        <dl className="kv money">
          <MoneyRow label={t('admin.booking.visit.perVisit')} value={euro(visit.perVisitCents)} strong />
          <MoneyRow label={t('admin.booking.visit.monthly')} value={euro(visit.priceCents)} />
          <MoneyRow label={t('admin.booking.visit.proMonthly', { pct: visit.proSharePct })} value={euro(visit.proMonthlyCents)} />
          <MoneyRow label={t('admin.booking.visit.miskMonthly')} value={euro(visit.miskMonthlyCents)} />
          <MoneyRow
            label={t('admin.booking.visit.billing')}
            value={t(`admin.bookings.subscription.${visit.subscriptionStatus as 'active'}`)}
          />
        </dl>
        <p className="small muted">{t('admin.booking.visit.billingNote')}</p>
      </section>
    </>
  );
}

type Loaded = { booking: AdminBooking; visit: null } | { booking: null; visit: AdminVisit };

export function AdminBookingDrawer({ item, onClose, onChanged }: { item: OpenItem; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(
    (): Promise<Loaded> =>
      item.kind === 'booking'
        ? api.get<{ booking: AdminBooking }>(`/admin/bookings/${item.id}`).then((r) => ({ booking: r.booking, visit: null }))
        : api.get<{ visit: AdminVisit }>(`/admin/visits/${item.id}`).then((r) => ({ booking: null, visit: r.visit })),
    [api, item.kind, item.id],
  );
  const { state, reload, update } = useResource(load);
  usePolling(reload, REFRESH_MS);
  const title = state.status === 'ready' ? (state.data.booking?.number ?? state.data.visit?.number ?? '') : t('admin.booking.loading');

  const changed = useCallback(
    (booking: AdminBooking) => {
      update(() => ({ booking, visit: null }));
      onChanged();
    },
    [update, onChanged],
  );

  return (
    <Drawer title={title} closeLabel={t('admin.booking.close')} onClose={onClose}>
      <ResourceState state={state} reload={reload}>
        {({ booking, visit }) =>
          booking ? <BookingDetails booking={booking} onChanged={changed} /> : visit ? <VisitDetails visit={visit} /> : null
        }
      </ResourceState>
    </Drawer>
  );
}
