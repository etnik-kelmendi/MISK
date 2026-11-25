import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import { useMarket } from '../../../api/MarketContext';
import { useResource } from '../../../api/useResource';
import { ErrorText } from '../../../components/ErrorText';
import { FieldError } from '../../../components/FieldError';
import { ResourceState } from '../../../components/ResourceState';
import { longDate } from '../../../lib/format';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';
import { PRO_PROFILE_PATHS, type Review, type ReviewsPage, type ReviewSummary } from './types';

/** Five stars, the first `stars` filled, read out as "4 stars". */
function StarRow({ stars }: { stars: number }) {
  const { t } = useTranslation();
  return (
    <span className="stars star-row" role="img" aria-label={t('rating.starLabel', { count: stars })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} aria-hidden="true" className={n <= stars ? '' : 'star-off'}>
          ★
        </span>
      ))}
    </span>
  );
}

/** The average in large text with the number of ratings, and a bar per star level with its share. */
function Summary({ summary }: { summary: ReviewSummary }) {
  const { t } = useTranslation();
  return (
    <section className="card row rating-summary" aria-label={t('reviews.summaryLabel')}>
      <div className="center rating-big">
        <div className="rating-number">{summary.average !== null ? summary.average.toFixed(1) : '–'}</div>
        <StarRow stars={Math.round(summary.average ?? 0)} />
        <div className="tiny muted">{t('reviews.count', { count: summary.count })}</div>
      </div>
      <ul className="grow star-bars" aria-label={t('reviews.barsLabel')}>
        {summary.stars.map((level) => (
          <li key={level.stars} className="row tiny star-bar">
            <span className="star-bar-n" aria-hidden="true">
              {level.stars}
            </span>
            <span
              className="meter"
              role="meter"
              aria-label={t('reviews.barLabel', { count: level.stars })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={level.pct}
              aria-valuetext={t('reviews.barValue', { pct: level.pct, count: level.count })}
            >
              <span className="meter-fill accent" style={{ width: `${level.pct}%` }} />
            </span>
            <span className="muted star-bar-pct" aria-hidden="true">
              {level.pct}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The pro's one reply: a short form until it is sent, then the reply as the customer sees it. No edits. */
function ReplyBox({ review, maxLength, onReplied }: { review: Review; maxLength: number; onReplied: (r: Review) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const send = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const id = `reply-${review.bookingId}`;
  const problem = tried && !text.trim() ? t('reviews.replyMissing') : null;

  if (review.reply) {
    return (
      <div className="review-reply">
        <p className="tiny b">{t('reviews.yourReply', { date: review.repliedAt ? longDate(review.repliedAt, timezone) : '' })}</p>
        <p className="small pre-line">{review.reply}</p>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className="linkbtn tiny reply-btn" aria-expanded={false} onClick={() => setOpen(true)}>
        {t('reviews.reply')}
        <span className="visually-hidden"> {t('reviews.replyTo', { name: review.customerName ?? t('reviews.aCustomer') })}</span>
      </button>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!text.trim()) {
      document.getElementById(id)?.focus();
      return;
    }
    const result = await send.run(() => api.post<{ review: Review }>(`/pro/reviews/${review.bookingId}/reply`, { text: text.trim() }));
    if (result) onReplied(result.review);
  }

  return (
    <form className="stack tight review-reply-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={id}>{t('reviews.replyLabel', { name: review.customerName ?? t('reviews.aCustomer') })}</label>
        <textarea
          id={id}
          rows={2}
          maxLength={maxLength}
          value={text}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-hint${problem ? ` ${id}-error` : ''}`}
          onChange={(event) => setText(event.target.value)}
        />
        <span id={`${id}-hint`} className="hint">
          {t('reviews.replyHint')}
        </span>
        <FieldError id={id} message={problem} />
      </div>
      <ErrorText error={send.error} />
      <div className="row gap8">
        <button type="submit" className="mini-btn pro-btn" disabled={send.busy}>
          {t('reviews.send')}
        </button>
        <button type="button" className="mini-btn" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

/** Pages of reviews added with "Show more", newest first. */
function ReviewList({ first, maxLength }: { first: ReviewsPage; maxLength: number }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const more = useAction();
  const [reviews, setReviews] = useState(first.reviews);
  const [hasMore, setHasMore] = useState(first.hasMore);

  if (reviews.length === 0) {
    return <p className="card small muted">{t('reviews.none')}</p>;
  }
  const replaced = (next: Review) => setReviews((list) => list.map((r) => (r.bookingId === next.bookingId ? next : r)));
  return (
    <>
      <ul className="lgroup review-list" aria-label={t('reviews.latest')}>
        {reviews.map((review) => (
          <li key={review.bookingId} className="rev">
            <div className="row between wrap gap4">
              <StarRow stars={review.stars} />
              <span className="tiny muted">
                {review.customerName ?? t('reviews.aCustomer')} · {longDate(review.createdAt, timezone)}
              </span>
            </div>
            {review.review && <p className="small pre-line">{review.review}</p>}
            {review.tags.length > 0 && <p className="tiny muted">{review.tags.map((tag) => t(`rating.tags.${tag as 'on_time'}`, { defaultValue: tag })).join(' · ')}</p>}
            <ReplyBox review={review} maxLength={maxLength} onReplied={replaced} />
          </li>
        ))}
      </ul>
      <ErrorText error={more.error} />
      {hasMore && (
        <button
          type="button"
          className="cta ghost"
          disabled={more.busy}
          onClick={() =>
            void more.run(() => api.get<ReviewsPage>(`/pro/reviews?offset=${reviews.length}`)).then((page) => {
              if (!page) return;
              setReviews((list) => [...list, ...page.reviews.filter((r) => !list.some((x) => x.bookingId === r.bookingId))]);
              setHasMore(page.hasMore);
            })
          }
        >
          {t('reviews.more')}
        </button>
      )}
    </>
  );
}

/**
 * Ratings & reviews (D100): the average in large text and the number of ratings, a bar per star level with its
 * share, the tags customers chose most with how often, and the latest reviews, each with one reply.
 */
export function RatingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<ReviewsPage>('/pro/reviews'), [api]);
  const { state, reload } = useResource(load);
  return (
    <>
      <AppHeader title={t('proProfile.ratings')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {(page) => (
            <>
              <Summary summary={page.summary} />
              {page.summary.tags.length > 0 && (
                <>
                  <h2 className="h-sm">{t('reviews.mention')}</h2>
                  <ul className="chips plain-list" aria-label={t('reviews.mention')}>
                    {page.summary.tags.map((tag) => (
                      <li key={tag.tag} className="chip static-chip">
                        {t('reviews.tagCount', { tag: t(`rating.tags.${tag.tag as 'on_time'}`, { defaultValue: tag.tag }), count: tag.count })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h2 className="h-sm">{t('reviews.latest')}</h2>
              <ReviewList first={page} maxLength={page.replyMaxLength} />
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
