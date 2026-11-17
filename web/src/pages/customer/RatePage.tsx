import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { CustomerBooking } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro, proShare } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { AppHeader } from '../../shells/Shells';
import { ReceiptSheet, ReportSheet } from './BookingSheets';
import { proName, ReportCard, ReportedBanner, TipForm } from './BookingPage';

export const RATING_TAGS = ['on_time', 'tidy', 'friendly', 'great_value', 'extra_mile'] as const;
/** The tips offered next to the review, in cents; 0 is "No tip". */
const TIP_OPTIONS = [0, 200, 500, 1000] as const;
const REVIEW_MAX = 1000;

function ReviewForm({
  booking,
  onDone,
  beforeSend,
}: {
  booking: CustomerBooking;
  onDone: (b: CustomerBooking, tipError: unknown) => void;
  /** Shown just above the send button, e.g. the report card. */
  beforeSend?: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone, proSharePct } = useMarket();
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [review, setReview] = useState('');
  const [tip, setTip] = useState<number>(0);
  const { run, busy, error } = useAction();
  const name = proName(booking, t('problem.yourPro'));
  const form = useValidation({ stars: stars === 0 && t('validation.starsMissing') }, { stars: 'rating-star-1' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const body = { stars, tags, ...(review.trim() ? { review: review.trim() } : {}) };
    const rated = await run(() => api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/rating`, body));
    if (!rated) return;
    if (tip > 0 && booking.canTip) {
      // The rating is in; a tip that fails can be tried again on the next screen.
      try {
        const tipped = await api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/tip`, { amountCents: tip });
        onDone(tipped.booking, null);
      } catch (caught) {
        onDone(rated.booking, caught);
      }
      return;
    }
    onDone(rated.booking, null);
  }

  return (
    <form id="review-form" className="stack" onSubmit={submit} noValidate>
      <div className="center">
        <span className="av av-lg" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <h2 className="b rate-title">{t('rating.title', { name })}</h2>
        <p className="small muted">
          {booking.serviceName} · {dateTime(booking.startsAt, timezone)}
        </p>
      </div>
      <fieldset {...form.describe('stars')}>
        <legend className="visually-hidden">{t('rating.stars')}</legend>
        <div className="bigstars">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className={stars >= n ? 'on' : ''}>
              <input
                id={`rating-star-${n}`}
                type="radio"
                name="stars"
                className="visually-hidden"
                checked={stars === n}
                onChange={() => setStars(n)}
              />
              <Icon name="star" label={t('rating.starLabel', { count: n })} />
            </label>
          ))}
        </div>
        <FieldError id="rating-star-1" message={form.message('stars')} />
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
      <div className="field">
        <label htmlFor="rating-review" className="h-sm">
          {t('rating.review')} <span className="h-note">{t('rating.optional')}</span>
        </label>
        <textarea
          id="rating-review"
          rows={2}
          maxLength={REVIEW_MAX}
          placeholder={t('rating.reviewPlaceholder', { name })}
          value={review}
          onChange={(e) => setReview(e.target.value)}
        />
      </div>
      {booking.canTip && (
        <fieldset>
          <legend className="h-sm">
            {t('rating.tip')} <span className="h-note">{t('rating.tipShare', { pct: proSharePct, name })}</span>
          </legend>
          <div className="seg seg-full">
            {TIP_OPTIONS.map((amount) => (
              <label key={amount} className={tip === amount ? 'on' : ''}>
                <input type="radio" name="tip" className="visually-hidden" checked={tip === amount} onChange={() => setTip(amount)} />
                {amount === 0 ? t('rating.noTip') : euro(amount)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {tip > 0 && <p className="small brand-text">{t('tip.split', { pro: euro(proShare(tip, proSharePct)), name })}</p>}
      {beforeSend}
      <ErrorText error={error} />
      <div className="cta-bar flush">
        <button className="cta" type="submit" disabled={busy}>
          {t('rating.send')}
        </button>
      </div>
    </form>
  );
}

function ReviewSent({
  booking,
  tipError,
  onChanged,
  onReceipt,
  onReport,
}: {
  booking: CustomerBooking;
  tipError: unknown;
  onChanged: (b: CustomerBooking) => void;
  onReceipt: () => void;
  onReport: () => void;
}) {
  const { t } = useTranslation();
  const name = proName(booking, t('problem.yourPro'));
  const tipped = booking.tip?.status === 'captured' ? booking.tip : null;
  const total = booking.totalCents + (tipped?.amountCents ?? 0);
  const money = booking.problemReportedAt && !booking.problemResolvedAt ? 'onHold' : booking.paymentStatus === 'captured' ? 'paid' : 'charging';
  return (
    <>
      <div className="card center stack review-sent">
        <span className="done-icon" aria-hidden="true">
          <Icon name="check" />
        </span>
        <h2 className="b">{t('rating.sent')}</h2>
        <p className="small muted">
          {tipped
            ? t('rating.sentWithTip', { name, tip: euro(tipped.proCents), stars: booking.rating?.stars ?? 0 })
            : t('rating.sentStars', { name, stars: booking.rating?.stars ?? 0 })}
        </p>
        <p className="small">
          {t('book.total')} <b>{euro(total)}</b> · {t(`rating.money.${money}`)}
        </p>
        <div className="row gap8 wrap center-row">
          {(booking.status === 'completed' || booking.lateCancel) && (
            <button type="button" className="mini-btn green" onClick={onReceipt}>
              <Icon name="file" /> {t('bookings.receipt')}
            </button>
          )}
          {booking.canReportProblem && (
            <button type="button" className="mini-btn danger" onClick={onReport}>
              {t('problem.open')}
            </button>
          )}
        </div>
      </div>
      {tipError !== null && <ErrorText error={tipError} />}
      {booking.canTip && <TipForm booking={booking} onTipped={onChanged} />}
      <h2 className="h-sm">{t('rating.regularTitle')}</h2>
      <Link to="/plans" className="promo">
        <span className="t">{t('rating.regular', { name })}</span>
        <span className="s">{t('rating.regularText')}</span>
        <span className="go">
          {t('rating.seePlans')} <Icon name="arrowR" />
        </span>
      </Link>
    </>
  );
}

/** Rate your pro (D67): stars, tags, a written review and a tip, then the receipt and "make it regular". */
export function RatePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ booking: CustomerBooking }>(`/bookings/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  const [tipError, setTipError] = useState<unknown>(null);
  const [sheet, setSheet] = useState<'receipt' | 'report' | null>(null);
  const change = (next: CustomerBooking) => update(() => ({ booking: next }));
  const rated = state.status === 'ready' && state.data.booking.rating !== null;

  return (
    <>
      <AppHeader title={rated ? t('rating.thanksTitle') : t('rating.pageTitle')} back={`/bookings/${encodeURIComponent(id)}`} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ booking }) => (
            <>
              <ReportedBanner booking={booking} />
              {booking.rating ? (
                <ReviewSent
                  booking={booking}
                  tipError={tipError}
                  onChanged={(next) => {
                    setTipError(null);
                    change(next);
                  }}
                  onReceipt={() => setSheet('receipt')}
                  onReport={() => setSheet('report')}
                />
              ) : booking.canRate ? (
                <>
                  <ReviewForm
                    booking={booking}
                    beforeSend={booking.canReportProblem && <ReportCard onReport={() => setSheet('report')} />}
                    onDone={(next, error) => {
                      setTipError(error);
                      change(next);
                    }}
                  />
                </>
              ) : (
                <div className="card center stack">
                  <p className="muted">{t('rating.notYet')}</p>
                  <Link to={`/bookings/${booking.id}`} className="btn btn-ghost">
                    {t('rating.backToBooking')}
                  </Link>
                </div>
              )}
              {sheet === 'receipt' && <ReceiptSheet bookingId={booking.id} onClose={() => setSheet(null)} />}
              {sheet === 'report' && (
                <ReportSheet
                  booking={{ id: booking.id, serviceName: booking.serviceName, startsAt: booking.startsAt, proName: booking.pro?.firstName ?? null }}
                  onClose={() => setSheet(null)}
                  onReported={(next) => {
                    setSheet(null);
                    change(next);
                  }}
                />
              )}
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
