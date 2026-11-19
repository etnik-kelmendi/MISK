import type { TFunction } from 'i18next';
import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingStatus, CustomerBooking, Extra, PaymentStep } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { LiveMap } from '../../components/LiveMap';
import { Avatar, FileButton, IMAGE_TYPES, PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { Stars, StatusBadge } from '../../components/StatusBadge';
import { dateTime, dayName, euro, parseEuroToCents, proShare, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useNow } from '../../lib/useNow';
import { usePolling } from '../../lib/usePolling';
import { useValidation } from '../../lib/useValidation';
import { CardPayment, confirmSavedCard } from '../../payments/CardPayment';
import { AppHeader } from '../../shells/Shells';
import { MAX_PROBLEM_PHOTOS, ReceiptSheet, ReportSheet } from './BookingSheets';

const TIMELINE = ['searching', 'accepted', 'on_the_way', 'working', 'completed'] as const;
export const LIVE = new Set<BookingStatus>(['awaiting_payment', 'searching', 'accepted', 'on_the_way', 'working']);
/** A pro who has not set off this long after the start time counts as running late. */
const LATE_AFTER_MS = 10 * 60_000;
/** A pro on the way this many minutes behind the start gets a red "running late" note (D83). */
export const LATE_NOTICE_MINUTES = 10;
/** A pro this many minutes late or more lets the customer cancel for free; the server decides (D83). */
export const FREE_CANCEL_LATE_MINUTES = 30;

/** "30 min", "1 h", "1 h 30 min" (D83). */
export function formatDuration(minutes: number, t: TFunction): string {
  if (minutes < 60) return t('duration.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? t('duration.hoursMinutes', { hours, minutes: rest }) : t('duration.hours', { hours });
}

/** The heart that saves the pro as a favourite (D83); only offered once the pro has done a job. */
export function FavouriteButton({ booking, compact = false }: { booking: CustomerBooking; compact?: boolean }) {
  const { t } = useTranslation();
  const api = useApi();
  const [saved, setSaved] = useState(booking.pro?.isFavourite ?? false);
  const { run, busy, error } = useAction();
  const pro = booking.pro;
  if (!pro) return null;
  const name = pro.firstName ?? t('problem.yourPro');

  async function toggle() {
    if (!pro) return;
    const path = `/favourites/pros/${encodeURIComponent(pro.id)}`;
    const result = await run(() => (saved ? api.delete<{ favourite: boolean }>(path) : api.put<{ favourite: boolean }>(path, {})));
    if (result) setSaved(result.favourite);
  }

  return (
    <span className="fav-wrap">
      <button
        type="button"
        className={compact ? `iconbtn soft fav ${saved ? 'on' : ''}` : `mini-btn fav ${saved ? 'on' : ''}`}
        aria-pressed={saved}
        aria-label={compact ? (saved ? t('favourite.saved') : t('favourite.save', { name })) : undefined}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <Icon name="heart" />
        {!compact && <span>{saved ? t('favourite.saved') : t('favourite.save', { name })}</span>}
      </button>
      <ErrorText error={error} />
    </span>
  );
}

/** The pro's photo (or initial), name, Verified, stars and number of jobs (D83). */
function ProCard({ booking, unread }: { booking: CustomerBooking; unread: number }) {
  const { t } = useTranslation();
  const pro = booking.pro;
  if (!pro) return null;
  const name = pro.firstName ?? t('problem.yourPro');
  return (
    <div className="row">
      <Avatar name={name} photoId={pro.photoId} />
      <div className="grow">
        <p className="b">
          {pro.firstName}{' '}
          <span className="verified">
            <Icon name="shield" /> {t('booking.verified')}
          </span>
        </p>
        <p className="row gap6 pro-meta">
          <Stars average={pro.ratingAverage} count={pro.ratingCount} />
          {pro.jobsDone !== undefined && <span className="small muted">· {t('booking.jobsDone', { count: pro.jobsDone })}</span>}
        </p>
      </div>
      {booking.status === 'completed' && <FavouriteButton booking={booking} compact />}
      <Link to={`/bookings/${booking.id}/chat`} className="iconbtn soft chat-btn" aria-label={t('booking.chatWith', { name })}>
        <Icon name="chat" />
        {unread > 0 && <span className="dot-badge" aria-hidden="true" />}
      </Link>
    </div>
  );
}

/** Minutes since an instant, for "updated 1 min ago". */
function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/**
 * While the pro is on the way (D83): a real map with the pro and the home, the expected arrival and how fresh
 * the position is. Without a recent position the map shows the home and the booked time.
 */
function LiveArrival({ booking }: { booking: CustomerBooking }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const now = useNow(15_000);
  const arrival = booking.arrival;
  const name = proName(booking, t('problem.yourPro'));
  if (!arrival) return null;
  const position = arrival.proPosition ?? null;
  const address = `${booking.address}, ${booking.postcode}`;
  const distance = position && arrival.destination ? distanceKm(position, arrival.destination) : null;
  const ago = position ? minutesSince(position.at, now) : null;
  return (
    <section className="stack live-arrival" aria-label={t('booking.yourPro')}>
      {arrival.destination ? (
        <LiveMap
          pro={position}
          home={arrival.destination}
          label={
            distance !== null
              ? t('booking.mapLabel', { name, distance: distance.toFixed(1), address })
              : t('booking.mapWaiting', { name, address })
          }
          proLabel={name}
          homeLabel={t('booking.mapHome')}
          proInitial={name.slice(0, 1).toUpperCase()}
          attribution={t('booking.mapAttribution')}
        />
      ) : (
        <RouteMap booking={booking} />
      )}
      <p className="card row between arrival-line" role="status">
        <span className="b">
          <Icon name="clock" /> {t('booking.expectedAround', { time: time(arrival.expectedAt, timezone) })}
        </span>
        <span className="small muted">
          {ago === null ? t('booking.waitingForLocation', { name }) : ago === 0 ? t('booking.updatedNow') : t('booking.updatedAgo', { count: ago })}
        </span>
      </p>
    </section>
  );
}

/** Straight-line distance in kilometres, for describing the map. */
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A flexible booking whose pro has not picked the time yet (D70). */
export function waitingForTime(booking: Pick<CustomerBooking, 'flexibleWindow' | 'timeConfirmed'>): boolean {
  return Boolean(booking.flexibleWindow) && booking.timeConfirmed === false;
}

/** The pro's first name, or "your pro" before one is assigned. */
export function proName(booking: CustomerBooking, fallback: string): string {
  return booking.pro?.firstName ?? fallback;
}

function Timeline({ booking }: { booking: CustomerBooking }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const reached = new Map(booking.events.map((e) => [e.status, e.at]));
  const currentIndex = (TIMELINE as readonly BookingStatus[]).indexOf(booking.status);
  return (
    <ol className="tl" aria-label={t('booking.timeline')}>
      {TIMELINE.map((status, index) => {
        const at = reached.get(status);
        const done = at !== undefined && index < currentIndex;
        const now = index === currentIndex && booking.status !== 'completed';
        // Until the pro sets off, the arrival time is the booked start; a flexible job has only its window yet.
        const hint =
          status === 'on_the_way' && !at
            ? waitingForTime(booking)
              ? t(`time.window.${booking.flexibleWindow ?? 'any'}`)
              : t('timeline.arrivingAround', { time: time(booking.startsAt, timezone) })
            : t(`timeline.${status}Hint`);
        return (
          <li key={status} className={`tl-item ${done || booking.status === 'completed' ? 'done' : ''} ${now ? 'now' : ''}`}>
            <span className="tdot" aria-hidden="true" />
            <span className="tt">{t(`timeline.${status}`)}</span>
            <span className="small muted">{at ? time(at, timezone) : hint}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Where the job is along the way from the pro to the customer: a drawing, not a live location. */
const MARKER: Record<string, [number, number] | null> = {
  accepted: [40, 150],
  on_the_way: [150, 95],
  working: [250, 70],
  completed: [250, 70],
};

function RouteMap({ booking }: { booking: CustomerBooking }) {
  const { t } = useTranslation();
  const marker = booking.pro ? MARKER[booking.status] ?? null : null;
  const moving = booking.status === 'on_the_way' || booking.status === 'working' || booking.status === 'completed';
  return (
    <figure className="map route-map">
      <svg viewBox="0 0 340 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect width="340" height="200" fill="#E3ECE6" />
        <path d="M0 120 H340 M0 40 H340 M90 0 V200 M200 0 V200 M290 0 V200" stroke="#fff" strokeWidth="14" />
        <path d="M0 120 H340 M90 0 V200 M200 0 V200" stroke="#F5F8F6" strokeWidth="2" strokeDasharray="6 6" />
        <rect x="105" y="52" width="80" height="55" rx="6" fill="#CFE3D6" />
        <rect x="215" y="135" width="62" height="50" rx="6" fill="#CFE3D6" />
        <rect x="10" y="135" width="66" height="50" rx="6" fill="#D8E6DC" />
        <circle cx="150" cy="80" r="16" fill="#BADBC6" />
        <path
          d="M40 150 L90 150 L90 120 L200 120 L200 70 L250 70"
          fill="none"
          stroke="var(--brand)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={moving ? '0' : '2 8'}
          opacity={booking.pro ? 1 : 0.35}
        />
        <g transform="translate(250 70)">
          <circle r="18" fill="rgba(11,122,85,.15)" />
          <circle r="9" fill="var(--brand)" stroke="#fff" strokeWidth="3" />
        </g>
        {marker && booking.pro && (
          <g className="route-marker" transform={`translate(${marker[0]} ${marker[1]})`}>
            <circle r="14" fill="#fff" stroke="var(--pro)" strokeWidth="2" />
            <text y="4" textAnchor="middle" fontSize="11" fontWeight="800" fill="var(--pro)" fontFamily="sans-serif">
              {(booking.pro.firstName ?? '?').slice(0, 1).toUpperCase()}
            </text>
          </g>
        )}
      </svg>
      <figcaption className="route-caption">
        <Icon name="pin" /> {booking.address}, {booking.postcode}
        <span className="visually-hidden">. {t(`timeline.${booking.status === 'unassigned' ? 'searching' : booking.status}`, { defaultValue: '' })}</span>
      </figcaption>
    </figure>
  );
}

export function ExtraCard({ booking, extra, onChanged }: { booking: CustomerBooking; extra: Extra; onChanged: (b: CustomerBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();

  async function decide(decision: 'approve' | 'decline') {
    await run(async () => {
      const result = await api.post<{ booking: CustomerBooking; payment?: PaymentStep | null }>(
        `/bookings/${booking.id}/extras/${extra.id}/${decision}`,
      );
      if (result.payment) {
        // The bank wants the customer to confirm this charge; the webhook then marks it approved.
        await confirmSavedCard(result.payment);
      }
      onChanged(result.booking);
    });
  }

  return (
    <div className="xcard">
      <span className="badge">
        <Icon name="plus" /> {t('extra.request')}
      </span>
      <div className="row between">
        <div>
          <p className="b">{extra.description}</p>
          {extra.durationMinutes ? <p className="small muted">{t('extra.about', { duration: formatDuration(extra.durationMinutes, t) })}</p> : null}
        </div>
        <p className="price">+{euro(extra.priceCents)}</p>
      </div>
      {extra.status === 'pending' ? (
        <>
          <div className="row gap8">
            <button type="button" className="btn2 no" disabled={busy} onClick={() => void decide('decline')}>
              {t('extra.decline')}
            </button>
            <button type="button" className="btn2 yes" disabled={busy} onClick={() => void decide('approve')}>
              {t('extra.approve', { price: euro(extra.priceCents) })}
            </button>
          </div>
          <p className="tiny muted row gap6">
            <Icon name="shield" /> {t('extra.nothingUnlessApproved')}
          </p>
        </>
      ) : (
        <span className={`badge ${extra.status === 'approved' ? 'g' : 'grey'}`}>
          {/* The customer's own answer, in their words (D83). */}
          {extra.status === 'approved' || extra.status === 'declined' ? t(`extra.answered.${extra.status}`) : t(`extra.status.${extra.status}`)}
        </span>
      )}
      <ErrorText error={error} />
    </div>
  );
}

const TIP_CHOICES = [200, 500, 1000];
export const MIN_TIP_CENTS = 100;
export const MAX_TIP_CENTS = 20_000;

/** A tip for the pro after the job, with how much of it reaches them at today's commission. */
export function TipForm({ booking, onTipped }: { booking: CustomerBooking; onTipped: (b: CustomerBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { proSharePct } = useMarket();
  const [choice, setChoice] = useState<number | 'other'>(500);
  const [other, setOther] = useState('');
  const { run, busy, error } = useAction();
  const cents = choice === 'other' ? parseEuroToCents(other) : choice;
  const valid = cents !== null && cents >= MIN_TIP_CENTS && cents <= MAX_TIP_CENTS;
  const name = booking.pro?.firstName ?? '';
  const form = useValidation(
    { amount: !valid && (other.trim() === '' ? t('validation.tipMissing') : t('tip.invalid')) },
    { amount: 'tip-other' },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check() || cents === null) return;
    const result = await run(() => api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/tip`, { amountCents: cents }));
    if (result) onTipped(result.booking);
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <fieldset>
        <legend className="b">{t('tip.title', { name })}</legend>
        <div className="tip-chips">
          {TIP_CHOICES.map((amount) => (
            <label key={amount} className={`chip ${choice === amount ? 'on' : ''}`}>
              <input type="radio" name="tip" className="visually-hidden" checked={choice === amount} onChange={() => setChoice(amount)} />
              {euro(amount)}
            </label>
          ))}
          <label className={`chip ${choice === 'other' ? 'on' : ''}`}>
            <input type="radio" name="tip" className="visually-hidden" checked={choice === 'other'} onChange={() => setChoice('other')} />
            {t('tip.other')}
          </label>
        </div>
      </fieldset>
      {choice === 'other' && (
        <div className="field">
          <label htmlFor="tip-other">{t('tip.other')}</label>
          <input id="tip-other" inputMode="decimal" value={other} {...form.describe('amount')} onChange={(e) => setOther(e.target.value)} />
          {form.message('amount') ? (
            <FieldError id="tip-other" message={form.message('amount')} />
          ) : (
            other.trim() !== '' && !valid && <span className="error-text small">{t('tip.invalid')}</span>
          )}
        </div>
      )}
      {valid && cents !== null && <p className="small brand-text">{t('tip.split', { pro: euro(proShare(cents, proSharePct)), name })}</p>}
      <ErrorText error={error} />
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {t('tip.send', { amount: valid && cents !== null ? euro(cents) : '' })}
      </button>
    </form>
  );
}

/** "Problem reported": the payment is on hold until MISK support has looked at it. */
export function ReportedBanner({ booking }: { booking: CustomerBooking }) {
  const { t } = useTranslation();
  if (!booking.problemReportedAt) return null;
  return booking.problemResolvedAt ? (
    <p className="info" role="status">
      <Icon name="check" />
      <span>{t('problem.resolved')}</span>
    </p>
  ) : (
    <p className="info red" role="status">
      <Icon name="bell" />
      <span>
        <b>{t('problem.reportedTitle')}</b> {t('problem.received')}
      </span>
    </p>
  );
}

/** "Something not right?": the way into the report pop-up while the payment can still be stopped. */
export function ReportCard({ onReport }: { onReport: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="card row report-card">
      <span className="danger-text" aria-hidden="true">
        <Icon name="alert" />
      </span>
      <div className="grow">
        <p className="b small">{t('problem.notRight')}</p>
        <p className="tiny muted">{t('problem.within24h')}</p>
      </div>
      <button type="button" className="mini-btn danger" onClick={onReport}>
        {t('problem.report')}
      </button>
    </div>
  );
}

function PaymentSection({ booking, onConfirmed }: { booking: CustomerBooking; onConfirmed: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ payment: PaymentStep | null }>(`/bookings/${booking.id}/payment`), [api, booking.id]);
  const { state, reload } = useResource(load);
  return (
    <section aria-label={t('pay.title')}>
      <h2 className="h-sm">{t('pay.finish')}</h2>
      <ResourceState state={state} reload={reload}>
        {({ payment }) =>
          payment ? (
            <CardPayment payment={payment} amountLabel={euro(booking.totalCents)} onConfirmed={onConfirmed} />
          ) : (
            <p className="muted" role="status">
              {t('pay.checking')}
            </p>
          )
        }
      </ResourceState>
    </section>
  );
}

function BookingView({
  booking,
  onChanged,
  reload,
}: {
  booking: CustomerBooking;
  onChanged: (b: CustomerBooking) => void;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const cancel = useAction();
  const addPhoto = useAction();
  const addProblemPhoto = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [sheet, setSheet] = useState<'receipt' | 'report' | null>(null);
  const customerPhotos = booking.photos.filter((p) => p.kind === 'customer').map((p) => p.id);
  const proPhotos = booking.photos.filter((p) => p.kind === 'completion').map((p) => p.id);
  const problemPhotos = booking.photos.filter((p) => p.kind === 'problem').map((p) => p.id);
  const open = booking.status !== 'completed' && booking.status !== 'cancelled';
  const name = proName(booking, t('problem.yourPro'));
  const unread = booking.unreadMessages ?? 0;
  const hasReceipt = booking.status === 'completed' || booking.lateCancel;
  const now = useNow();
  const late = booking.status === 'accepted' && now > new Date(booking.startsAt).getTime() + LATE_AFTER_MS;
  const tracking = booking.status !== 'cancelled' && booking.status !== 'awaiting_payment';
  const onTheWay = booking.status === 'on_the_way';
  const lateMinutes = booking.arrival?.lateMinutes ?? 0;
  // The server decides whether cancelling is free because the pro is very late (D83).
  const freeCancel = booking.canCancel && (booking.freeCancelProLate ?? lateMinutes > FREE_CANCEL_LATE_MINUTES);
  const [confirmFree, setConfirmFree] = useState(false);

  return (
    <>
      <div className="body">
        {tracking && (onTheWay && booking.arrival ? <LiveArrival booking={booking} /> : <RouteMap booking={booking} />)}
        <div className="card">
          <div className="row between">
            <h2 className="b">{booking.serviceName}</h2>
            <StatusBadge status={booking.status} />
          </div>
          <p className="row small">
            <Icon name="calendar" />{' '}
            {waitingForTime(booking)
              ? t('time.flexibleBooked', {
                  day: dayName(booking.startsAt, timezone),
                  window: t(`time.window.${booking.flexibleWindow ?? 'any'}`).toLowerCase(),
                  by: booking.confirmBy ? dateTime(booking.confirmBy, timezone) : '',
                })
              : dateTime(booking.startsAt, timezone)}
          </p>
          {!tracking && (
            <p className="row small">
              <Icon name="pin" /> {booking.address}, {booking.postcode}
            </p>
          )}
        </div>

        {late && (
          <p className="info red" role="status">
            <Icon name="clock" />
            <span>{t('booking.late', { name, time: time(booking.startsAt, timezone) })}</span>
          </p>
        )}
        {onTheWay && booking.arrival && lateMinutes > LATE_NOTICE_MINUTES && (
          <p className="info red" role="alert">
            <Icon name="clock" />
            <span>{t('booking.runningLate', { minutes: lateMinutes, time: time(booking.arrival.expectedAt, timezone) })}</span>
          </p>
        )}
        {freeCancel && (
          <section className="stack">
            {confirmFree ? (
              <div className="card" role="alertdialog" aria-labelledby="free-cancel-question">
                <p id="free-cancel-question">{t('booking.freeCancelQuestion', { name })}</p>
                <div className="row gap8">
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmFree(false)}>
                    {t('booking.keep')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={cancel.busy}
                    onClick={() =>
                      void cancel
                        .run(() => api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/cancel`))
                        .then((result) => result && onChanged(result.booking))
                    }
                  >
                    {t('booking.freeCancelConfirm')}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setConfirmFree(true)}>
                {t('booking.freeCancel')}
              </button>
            )}
            <ErrorText error={cancel.error} />
          </section>
        )}
        <ReportedBanner booking={booking} />

        {booking.status === 'awaiting_payment' && <PaymentSection booking={booking} onConfirmed={reload} />}
        {booking.status === 'unassigned' && (
          <p className="info amber" role="status">
            {t('booking.unassigned')}
          </p>
        )}

        {tracking && (
          <section className="card" aria-label={t('booking.yourPro')}>
            {booking.pro ? (
              <ProCard booking={booking} unread={unread} />
            ) : (
              <div className="row">
                <span className="av grey" aria-hidden="true">
                  <Icon name="clock" />
                </span>
                <p className="muted grow">{t('booking.finding')}</p>
              </div>
            )}
          </section>
        )}
        {tracking && (
          <section className="card" aria-label={t('booking.timeline')}>
            <Timeline booking={booking} />
          </section>
        )}

        {booking.extras.map((extra) => (
          <ExtraCard key={extra.id} booking={booking} extra={extra} onChanged={onChanged} />
        ))}

        <PhotoGrid ids={proPhotos} label={t('booking.proPhotos')} />

        {booking.rating && <p className="card">{t('booking.youRated', { stars: booking.rating.stars })}</p>}
        {booking.tip?.status === 'captured' && (
          <p className="card" role="status">
            {t('tip.thanks', { amount: euro(booking.tip.amountCents), pro: euro(booking.tip.proCents), name: booking.pro?.firstName ?? '' })}
          </p>
        )}
        {booking.lateCancel && <p className="card">{t('booking.lateCancelled', { price: euro(booking.totalCents) })}</p>}
        {booking.canReportProblem && (
          <>
            {booking.chargeAt && <p className="small muted">{t('problem.chargeAt', { date: dateTime(booking.chargeAt, timezone) })}</p>}
            <ReportCard onReport={() => setSheet('report')} />
          </>
        )}
        {booking.problemReportedAt && !booking.problemResolvedAt && (
          <section className="card stack" aria-label={t('problem.yourReport')}>
            {booking.problemNote && <p className="small">{booking.problemNote}</p>}
            <PhotoGrid ids={problemPhotos} label={t('problem.yourPhotos')} />
            {problemPhotos.length < MAX_PROBLEM_PHOTOS && (
              <FileButton
                label={t('problem.addPhoto')}
                accept={IMAGE_TYPES}
                icon="camera"
                onFile={async (file) => {
                  const result = await addProblemPhoto.run(() =>
                    api.upload<{ booking: CustomerBooking }>(`/bookings/${booking.id}/problem/photos`, file),
                  );
                  if (result) onChanged(result.booking);
                }}
              />
            )}
            <ErrorText error={addProblemPhoto.error} />
          </section>
        )}

        <section className="card" aria-label={t('book.price')}>
          <p className="line">
            <span>{booking.serviceName}</span>
            <span>{euro(booking.priceCents)}</span>
          </p>
          <p className="line">
            <span className="muted">{t('book.fee')}</span>
            <span>{euro(booking.feeCents)}</span>
          </p>
          {booking.extrasCents > 0 && (
            <p className="line">
              <span className="muted">{t('booking.extras')}</span>
              <span>{euro(booking.extrasCents)}</span>
            </p>
          )}
          <p className="line total">
            <span>{t('book.total')}</span>
            <span>{euro(booking.totalCents)}</span>
          </p>
          <p className="tiny muted">{t(`payment.${booking.paymentStatus}`)}</p>
          {hasReceipt && (
            <button type="button" className="mini-btn green receipt-btn" onClick={() => setSheet('receipt')}>
              <Icon name="file" /> {t('bookings.receipt')}
            </button>
          )}
        </section>

        {open && (
          <section aria-label={t('booking.yourPhotos')}>
            <h2 className="h-sm">{t('booking.yourPhotos')}</h2>
            <PhotoGrid ids={customerPhotos} label={t('booking.yourPhotos')} />
            {customerPhotos.length < 3 && (
              <FileButton
                label={t('booking.addPhoto')}
                accept={IMAGE_TYPES}
                icon="camera"
                onFile={async (file) => {
                  const result = await addPhoto.run(() => api.upload<{ booking: CustomerBooking }>(`/bookings/${booking.id}/photos`, file));
                  if (result) onChanged(result.booking);
                }}
              />
            )}
            <ErrorText error={addPhoto.error} />
          </section>
        )}

        {booking.canCancel && !freeCancel && (
          <section className="stack">
            {confirmCancel ? (
              <div className="card" role="alertdialog" aria-labelledby="cancel-question">
                <p id="cancel-question">
                  {booking.lateCancelCents === null
                    ? t('booking.cancelQuestion')
                    : t('booking.lateCancelQuestion', { price: euro(booking.lateCancelCents) })}
                </p>
                <div className="row gap8">
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>
                    {t('booking.keep')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={cancel.busy}
                    onClick={() =>
                      void cancel
                        .run(() =>
                          api.post<{ booking: CustomerBooking }>(
                            `/bookings/${booking.id}/cancel`,
                            booking.lateCancelCents === null ? undefined : { acceptLateCharge: true },
                          ),
                        )
                        .then((result) => result && onChanged(result.booking))
                    }
                  >
                    {booking.lateCancelCents === null
                      ? t('booking.cancelConfirm')
                      : t('booking.lateCancelConfirm', { price: euro(booking.lateCancelCents) })}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="link danger" onClick={() => setConfirmCancel(true)}>
                {t('booking.cancel')}
              </button>
            )}
            <ErrorText error={cancel.error} />
          </section>
        )}
      </div>

      {booking.canRate || booking.canTip ? (
        <div className="cta-bar">
          <Link to={`/bookings/${booking.id}/rate`} className="cta">
            <Icon name="star" /> {booking.canRate ? t('booking.rate', { name }) : t('booking.addTip', { name })}
          </Link>
        </div>
      ) : (
        unread > 0 && (
          <div className="cta-bar">
            <Link to={`/bookings/${booking.id}/chat`} className="cta">
              <Icon name="chat" /> {t('booking.newMessage', { name, count: unread })}
            </Link>
          </div>
        )
      )}

      {sheet === 'receipt' && <ReceiptSheet bookingId={booking.id} onClose={() => setSheet(null)} />}
      {sheet === 'report' && (
        <ReportSheet
          booking={{ id: booking.id, serviceName: booking.serviceName, startsAt: booking.startsAt, proName: booking.pro?.firstName ?? null }}
          onClose={() => setSheet(null)}
          onReported={(next) => {
            setSheet(null);
            onChanged(next);
          }}
        />
      )}
    </>
  );
}

export function BookingPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ booking: CustomerBooking }>(`/bookings/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  const live = state.status === 'ready' && LIVE.has(state.data.booking.status);
  usePolling(reload, 8_000, live);

  return (
    <>
      <AppHeader
        title={state.status === 'ready' && state.data.booking.status === 'completed' ? t('booking.doneTitle') : t('booking.title')}
        back="/bookings"
      />
      <ResourceState state={state} reload={reload}>
        {({ booking }) => <BookingView booking={booking} reload={reload} onChanged={(next) => update(() => ({ booking: next }))} />}
      </ResourceState>
    </>
  );
}
