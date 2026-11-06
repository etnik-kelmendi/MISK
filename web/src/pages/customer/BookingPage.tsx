import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingStatus, CustomerBooking, Extra, PaymentStep } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { FileButton, IMAGE_TYPES, PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { Stars, StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { CardPayment, confirmSavedCard } from '../../payments/CardPayment';
import { AppHeader } from '../../shells/Shells';

const TIMELINE = ['searching', 'accepted', 'on_the_way', 'working', 'completed'] as const;
const LIVE = new Set<BookingStatus>(['awaiting_payment', 'searching', 'accepted', 'on_the_way', 'working']);
export const RATING_TAGS = ['on_time', 'tidy', 'friendly', 'great_value', 'extra_mile'] as const;

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
        const now = index === currentIndex;
        return (
          <li key={status} className={`tl-item ${done || booking.status === 'completed' ? 'done' : ''} ${now ? 'now' : ''}`}>
            <span className="tdot" aria-hidden="true" />
            <span className="tt">{t(`timeline.${status}`)}</span>
            <span className="small muted">{at ? time(at, timezone) : t(`timeline.${status}Hint`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ExtraCard({ booking, extra, onChanged }: { booking: CustomerBooking; extra: Extra; onChanged: (b: CustomerBooking) => void }) {
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
        <p className="b">{extra.description}</p>
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
          <p className="tiny muted">{t('extra.nothingUnlessApproved')}</p>
        </>
      ) : (
        <span className={`badge ${extra.status === 'approved' ? 'g' : 'grey'}`}>{t(`extra.status.${extra.status}`)}</span>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function RatingForm({ booking, onRated }: { booking: CustomerBooking; onRated: (b: CustomerBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const { run, busy, error } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/rating`, { stars, tags }));
    if (result) {
      onRated(result.booking);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2 className="b">{t('rating.title', { name: booking.pro?.firstName ?? '' })}</h2>
      <fieldset>
        <legend className="visually-hidden">{t('rating.stars')}</legend>
        <div className="bigstars">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className={stars >= n ? 'on' : ''}>
              <input type="radio" name="stars" className="visually-hidden" checked={stars === n} onChange={() => setStars(n)} />
              <Icon name="star" label={t('rating.starLabel', { count: n })} />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="h-sm">{t('rating.wentWell')}</legend>
        <div className="chips">
          {RATING_TAGS.map((tag) => (
            <label key={tag} className={`chip ${tags.includes(tag) ? 'on' : ''}`}>
              <input
                type="checkbox"
                className="visually-hidden"
                checked={tags.includes(tag)}
                onChange={() => setTags((current) => (current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]))}
              />
              {t(`rating.tags.${tag}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorText error={error} />
      <button className="cta" type="submit" disabled={busy || stars === 0}>
        {t('rating.send')}
      </button>
    </form>
  );
}

/** Within 24 hours of the job, the customer can stop the charge by telling MISK what went wrong. */
function ProblemForm({ booking, onReported }: { booking: CustomerBooking; onReported: (b: CustomerBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const { run, busy, error } = useAction();
  const tooShort = note.trim().length < 3;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/problem`, { note: note.trim() }));
    if (result) {
      onReported(result.booking);
    }
  }

  if (!open) {
    return (
      <section className="card stack">
        <p className="small">{booking.chargeAt && t('problem.chargeAt', { date: dateTime(booking.chargeAt, timezone) })}</p>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          {t('problem.open')}
        </button>
      </section>
    );
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h2 className="b">{t('problem.title')}</h2>
      <div className="field">
        <label htmlFor="problem-note">{t('problem.note')}</label>
        <textarea id="problem-note" rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <p className="tiny muted">{t('problem.hint')}</p>
      <ErrorText error={error} />
      <div className="row gap8">
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button className="cta" type="submit" disabled={busy || tooShort}>
          {t('problem.send')}
        </button>
      </div>
    </form>
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

function BookingView({ booking, onChanged, reload }: { booking: CustomerBooking; onChanged: (b: CustomerBooking) => void; reload: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const cancel = useAction();
  const addPhoto = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const customerPhotos = booking.photos.filter((p) => p.kind === 'customer').map((p) => p.id);
  const proPhotos = booking.photos.filter((p) => p.kind === 'completion').map((p) => p.id);
  const open = booking.status !== 'completed' && booking.status !== 'cancelled';

  return (
    <div className="body">
      <div className="card">
        <div className="row between">
          <h2 className="b">{booking.serviceName}</h2>
          <StatusBadge status={booking.status} />
        </div>
        <p className="row small">
          <Icon name="calendar" /> {dateTime(booking.startsAt, timezone)}
        </p>
        <p className="row small">
          <Icon name="pin" /> {booking.address}, {booking.postcode}
        </p>
      </div>

      {booking.status === 'awaiting_payment' && <PaymentSection booking={booking} onConfirmed={reload} />}
      {booking.status === 'unassigned' && (
        <p className="info amber" role="status">
          {t('booking.unassigned')}
        </p>
      )}

      {booking.status !== 'cancelled' && booking.status !== 'awaiting_payment' && (
        <section className="card" aria-label={t('booking.yourPro')}>
          {booking.pro ? (
            <div className="row">
              <span className="av">{(booking.pro.firstName ?? '?').slice(0, 1)}</span>
              <div className="grow">
                <p className="b">
                  {booking.pro.firstName}{' '}
                  <span className="verified">
                    <Icon name="shield" /> {t('booking.verified')}
                  </span>
                </p>
                <Stars average={booking.pro.ratingAverage} count={booking.pro.ratingCount} />
              </div>
            </div>
          ) : (
            <p className="muted">{t('booking.finding')}</p>
          )}
          <Timeline booking={booking} />
        </section>
      )}

      {booking.extras.map((extra) => (
        <ExtraCard key={extra.id} booking={booking} extra={extra} onChanged={onChanged} />
      ))}

      <PhotoGrid ids={proPhotos} label={t('booking.proPhotos')} />

      {booking.canRate && <RatingForm booking={booking} onRated={onChanged} />}
      {booking.canReportProblem && <ProblemForm booking={booking} onReported={onChanged} />}
      {booking.problemReportedAt && (
        <p className="card" role="status">
          {booking.problemResolvedAt ? t('problem.resolved') : t('problem.received')}
        </p>
      )}
      {booking.rating && (
        <p className="card">
          {t('booking.youRated', { stars: booking.rating.stars })}
        </p>
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
                if (result) {
                  onChanged(result.booking);
                }
              }}
            />
          )}
          <ErrorText error={addPhoto.error} />
        </section>
      )}

      {booking.canCancel && (
        <section className="stack">
          {confirmCancel ? (
            <div className="card" role="alertdialog" aria-labelledby="cancel-question">
              <p id="cancel-question">{t('booking.cancelQuestion')}</p>
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
                      .run(() => api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/cancel`))
                      .then((result) => result && onChanged(result.booking))
                  }
                >
                  {t('booking.cancelConfirm')}
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
      <AppHeader title={t('booking.title')} back="/bookings" />
      <ResourceState state={state} reload={reload}>
        {({ booking }) => <BookingView booking={booking} reload={reload} onChanged={(next) => update(() => ({ booking: next }))} />}
      </ResourceState>
    </>
  );
}
