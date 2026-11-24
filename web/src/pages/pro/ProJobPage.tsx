import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import { CUSTOMER_RATING_TAGS, type BookingStatus, type CustomerRatingTag, type ProCancelReason, type ProJob } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon, type IconKey } from '../../components/Icon';
import { Avatar, IMAGE_TYPES, MAX_FILE_BYTES, PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro, longDate, time } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { useValidation } from '../../lib/useValidation';
import { AppHeader } from '../../shells/Shells';
import { CancelJobSheet, ChatSheet, CUSTOMER_COMMENT_MAX, customerName, ExtraWorkSheet, IssueSheet, JOB_SHEETS, type JobSheet } from './JobSheets';

const STEPS: BookingStatus[] = ['accepted', 'on_the_way', 'working', 'completed'];
/** The phone's position is sent at most this often while the pro is on the way (D83). */
export const LOCATION_EVERY_MS = 20_000;
/** Photos of the finished work the API takes per job. */
export const MAX_COMPLETION_PHOTOS = 6;
const ACTIVE: BookingStatus[] = ['accepted', 'on_the_way', 'working'];

type LocationState = 'asking' | 'sharing' | 'denied' | 'unsupported' | 'unavailable';

/**
 * While the pro is on the way (D83), shares their phone's position with the customer, at most every 20 seconds,
 * and says so on the page. Stops when the job moves on or the page closes; a refused permission only
 * shows an explanation.
 */
function LocationShare({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [state, setState] = useState<LocationState>(() =>
    typeof navigator !== 'undefined' && navigator.geolocation ? 'asking' : 'unsupported',
  );
  const [sentAt, setSentAt] = useState<string | null>(null);
  const lastSent = useRef(0);
  const sending = useRef(false);
  const name = customerName(job, t);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return;
    }
    let stopped = false;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        if (stopped) return;
        setState('sharing');
        const now = Date.now();
        if (sending.current || now - lastSent.current < LOCATION_EVERY_MS) return;
        sending.current = true;
        lastSent.current = now;
        const { latitude, longitude, accuracy } = position.coords;
        api
          .post(`/pro/jobs/${encodeURIComponent(job.id)}/location`, {
            lat: latitude,
            lng: longitude,
            ...(Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100_000 ? { accuracy } : {}),
          })
          .then(() => {
            if (!stopped) setSentAt(new Date().toISOString());
          })
          .catch((error: unknown) => {
            // The next position tries again; the job page shows when the job has moved on.
            console.warn('Could not share the location', error);
            lastSent.current = 0;
          })
          .finally(() => {
            sending.current = false;
          });
      },
      (error) => {
        if (stopped) return;
        setState(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => {
      stopped = true;
      navigator.geolocation.clearWatch(watch);
    };
  }, [api, job.id]);

  return (
    <section className={`info ${state === 'denied' || state === 'unsupported' ? 'amber' : ''} stack-tight`} aria-labelledby="location-heading" role="status">
      <Icon name="pin" />
      <span>
        <b id="location-heading" className="block">
          {t('job.location.title')}
        </b>
        {t(`job.location.${state}`, { name })}
        {sentAt && <span className="block tiny muted">{t('job.location.sent', { time: time(sentAt, timezone) })}</span>}
      </span>
    </section>
  );
}

const NEXT: Partial<Record<BookingStatus, { status: 'on_the_way' | 'working'; icon: IconKey }>> = {
  accepted: { status: 'on_the_way', icon: 'truck' },
  on_the_way: { status: 'working', icon: 'play' },
};

/** The checklist (D86): ticked off while working, read-only before and after. */
function Checklist({ job, onChanged }: { job: ProJob; onChanged: (job: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const tasks = job.tasks ?? [];
  if (tasks.length === 0) return null;
  const working = job.status === 'working';
  const done = tasks.filter((task) => task.done).length;

  async function toggle(key: string, value: boolean) {
    const result = await run(() => api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/tasks`, { key, done: value }));
    if (result) onChanged(result.job);
  }

  return (
    <section className="card" aria-labelledby="checklist-heading">
      <div className="row between">
        <h2 id="checklist-heading" className="b small">
          {t('job.checklist')}
        </h2>
        <span className="tiny muted">{t('job.tasksDone', { done, total: tasks.length })}</span>
      </div>
      <ul>
        {tasks.map((task) => (
          <li key={task.key}>
            <label className={`task-row ${task.done ? 'done' : ''}`}>
              <input
                type="checkbox"
                className="cbox"
                checked={task.done}
                disabled={!working || busy}
                onChange={(event) => void toggle(task.key, event.target.checked)}
              />
              <span>{task.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {(job.status === 'accepted' || job.status === 'on_the_way') && <p className="tiny muted">{t('job.checklistLater')}</p>}
      <ErrorText error={error} />
    </section>
  );
}

/** The latest extra work request, as the design shows it: waiting, approved or declined. */
function ExtraState({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const name = customerName(job, t);
  const latest = job.extras.filter((extra) => extra.kind !== 'waiting').at(-1);
  if (!latest) return null;
  const values = { name, item: latest.description, price: euro(latest.priceCents) };
  if (latest.status === 'pending' || latest.status === 'awaiting_payment') {
    return (
      <p className="info amber" role="status">
        <Icon name="clock" /> <span>{t('job.extraWaiting', values)}</span>
      </p>
    );
  }
  if (latest.status === 'approved') {
    return (
      <p className="info" role="status">
        <Icon name="check" /> <span>{t('job.extraApproved', values)}</span>
      </p>
    );
  }
  if (latest.status === 'declined') {
    return (
      <p className="info amber" role="status">
        <Icon name="x" /> <span>{t('job.extraDeclined', values)}</span>
      </p>
    );
  }
  return null;
}

/** Paid waiting at a locked door (D94): added to the pro's earnings, whoever pays it. */
function WaitingPaid({ job }: { job: ProJob }) {
  const { t } = useTranslation();
  const waiting = job.extras.filter((extra) => extra.kind === 'waiting' && extra.status === 'approved');
  if (waiting.length === 0) return null;
  const cents = waiting.reduce((sum, extra) => sum + extra.priceCents, 0);
  const share = job.proSharePct ?? 100;
  return (
    <p className="info" role="status">
      <Icon name="clock" /> <span>{t('job.waitingPaid', { price: euro(Math.floor((cents * share) / 100)) })}</span>
    </p>
  );
}

/** Re-renders every second, for a moment that is coming up. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * "Issue reported. MISK support is on it" (D94). After a "not home" or "can't get in" report the pro can leave
 * with the call-out fee once 15 minutes have passed.
 */
function IssueState({ job, onChanged }: { job: ProJob; onChanged: (job: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const leave = useAction();
  const leaveAt = job.leaveAt ? new Date(job.leaveAt).getTime() : null;
  const now = useNow(leaveAt !== null);
  if (!job.openIssue) return null;
  const fee = euro(job.callOutFeeCents ?? 0);
  return (
    <section className="info amber stack-tight" role="status" aria-labelledby="issue-heading">
      <Icon name="bell" />
      <span className="stack-tight">
        <b id="issue-heading" className="block">
          {t('job.issueReported')}
        </b>
        <span className="block small">{t('job.issueReason', { reason: t(`issue.reasons.${job.openIssue.reason}`) })}</span>
        {job.stopped && <span className="block small">{t('job.stopped')}</span>}
        {leaveAt !== null && job.leaveAt && now < leaveAt && (
          <span className="block small">{t('job.leaveWait', { fee, time: time(job.leaveAt, timezone) })}</span>
        )}
        {leaveAt !== null && now >= leaveAt && (
          <span>
            <button
              type="button"
              className="mini-btn"
              disabled={leave.busy}
              onClick={() =>
                void leave
                  .run(() => api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/no-show`))
                  .then((result) => result && onChanged(result.job))
              }
            >
              <Icon name="logout" /> {t('job.leave', { fee })}
            </button>
          </span>
        )}
        <ErrorText error={leave.error} />
      </span>
    </section>
  );
}

/** "How was Sara as a customer?" (D86): stars, tags and an optional comment (D94), which only MISK sees. */
function RateCustomer({ job, onChanged }: { job: ProJob; onChanged: (job: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const name = customerName(job, t);
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<CustomerRatingTag[]>([]);
  const [comment, setComment] = useState('');
  const [commenting, setCommenting] = useState(false);
  const { run, busy, error } = useAction();
  const form = useValidation({ stars: stars === 0 && t('validation.starsMissing') }, { stars: 'customer-star-1' });

  if (job.customerRating) {
    return (
      <p className="card row" role="status">
        <Icon name="check" className="brand-text" />
        <span className="small">{t('customerRating.thanks', { name, count: job.customerRating.stars })}</span>
      </p>
    );
  }
  if (!job.canRateCustomer) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const result = await run(() =>
      api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/customer-rating`, {
        stars,
        tags,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    );
    if (result) onChanged(result.job);
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="rate-customer-heading">
      <div>
        <h2 id="rate-customer-heading" className="b small">
          {t('customerRating.title', { name })}
        </h2>
        <p className="tiny muted">{t('customerRating.hint')}</p>
      </div>
      <fieldset {...form.describe('stars')}>
        <legend className="visually-hidden">{t('customerRating.stars')}</legend>
        <div className="bigstars left">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className={stars >= n ? 'on' : ''}>
              <input
                id={`customer-star-${n}`}
                type="radio"
                name="customer-stars"
                className="visually-hidden"
                checked={stars === n}
                onChange={() => setStars(n)}
              />
              <Icon name="star" label={t('customerRating.star', { count: n })} />
            </label>
          ))}
        </div>
        <FieldError id="customer-star-1" message={form.message('stars')} />
      </fieldset>
      <fieldset>
        <legend className="visually-hidden">{t('customerRating.tagsLabel')}</legend>
        <div className="chips">
          {CUSTOMER_RATING_TAGS.map((tag) => (
            <label key={tag} className={`chip dark ${tags.includes(tag) ? 'on' : ''}`}>
              <input
                type="checkbox"
                className="visually-hidden"
                checked={tags.includes(tag)}
                onChange={() => setTags((current) => (current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]))}
              />
              {t(`customerRating.tags.${tag}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {commenting ? (
        <div className="field">
          <label htmlFor="customer-comment">{t('customerRating.comment')}</label>
          <textarea
            id="customer-comment"
            rows={2}
            maxLength={CUSTOMER_COMMENT_MAX}
            placeholder={t('customerRating.commentPlaceholder')}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </div>
      ) : (
        <div>
          <button type="button" className="mini-btn" aria-expanded={false} onClick={() => setCommenting(true)}>
            <Icon name="plus" /> {t('customerRating.addComment')}
          </button>
        </div>
      )}
      <ErrorText error={error} />
      {stars === 0 && <p className="tiny muted">{t('customerRating.pickStars')}</p>}
      <div>
        <button type="submit" className="mini-btn pro-btn" disabled={busy || stars === 0}>
          {t('customerRating.send')}
        </button>
      </div>
    </form>
  );
}

/**
 * The bottom button always shows the next step (D86): Start driving → I've arrived, start job → Add
 * photos & complete → See my week. While working without photos it opens the camera or gallery first.
 */
function MainButton({ job, onChanged }: { job: ProJob; onChanged: (job: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const step = useAction();
  const photoInput = useRef<HTMLInputElement>(null);
  const [tooBig, setTooBig] = useState(false);
  // "Unsafe to work" stops the job (D94): no next step until MISK support resolves it.
  const next = job.stopped ? undefined : NEXT[job.status];
  const completion = job.photos.filter((p) => p.kind === 'completion');
  const tasks = job.tasks ?? [];
  const done = tasks.filter((task) => task.done).length;

  async function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    setTooBig(files.some((file) => file.size > MAX_FILE_BYTES));
    const fitting = files.filter((file) => file.size <= MAX_FILE_BYTES).slice(0, MAX_COMPLETION_PHOTOS - completion.length);
    if (fitting.length === 0) return;
    const result = await step.run(async () => {
      let latest: ProJob | null = null;
      for (const file of fitting) {
        latest = (await api.upload<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/photos`, file)).job;
        onChanged(latest);
      }
      return latest;
    });
    if (result) onChanged(result);
  }

  let button;
  if (job.stopped) {
    button = (
      <p className="info red" role="status">
        <Icon name="alert" /> <span>{t('job.stopped')}</span>
      </p>
    );
  } else if (next) {
    button = (
      <button
        type="button"
        className="cta dark"
        disabled={step.busy}
        onClick={() =>
          void step
            .run(() => api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/status`, { status: next.status }))
            .then((result) => result && onChanged(result.job))
        }
      >
        <Icon name={next.icon} /> {t(`job.go.${next.status}`)}
      </button>
    );
  } else if (job.status === 'working' && completion.length === 0) {
    button = (
      <button type="button" className="cta dark" disabled={step.busy} onClick={() => photoInput.current?.click()}>
        <Icon name="camera" /> {t('job.addPhotosComplete')}
      </button>
    );
  } else if (job.status === 'working') {
    button = (
      <button
        type="button"
        className="cta dark"
        disabled={step.busy}
        onClick={() =>
          void step
            .run(() => api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/complete`))
            .then((result) => result && onChanged(result.job))
        }
      >
        <Icon name="check" /> {done === tasks.length ? t('job.complete') : t('job.completePartly', { done, total: tasks.length })}
      </button>
    );
  } else if (job.status === 'completed') {
    button = (
      <Link to="/pro/week" className="cta dark">
        {t('job.seeWeek')} <Icon name="arrowR" />
      </Link>
    );
  } else {
    return null;
  }

  return (
    <div className="cta-bar">
      {job.status === 'working' && (
        <input
          ref={photoInput}
          type="file"
          accept={IMAGE_TYPES}
          multiple
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void addPhotos(event)}
        />
      )}
      {tooBig && (
        <p className="error-text" role="alert">
          {t('errors.file_too_large')}
        </p>
      )}
      <ErrorText error={step.error} />
      {button}
    </div>
  );
}

function JobView({
  job,
  onChanged,
  onCancelled,
}: {
  job: ProJob;
  onChanged: (job: ProJob) => void;
  onCancelled: (result: { reason: ProCancelReason; late: boolean }) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [params, setParams] = useSearchParams();
  const requested = params.get('sheet');
  const sheet = JOB_SHEETS.find((kind) => kind === requested) ?? null;
  const photo = useAction();
  const name = customerName(job, t);
  const completion = job.photos.filter((p) => p.kind === 'completion').map((p) => p.id);
  const customerPhotos = job.photos.filter((p) => p.kind === 'customer').map((p) => p.id);
  const stepIndex = STEPS.indexOf(job.status);
  const active = ACTIVE.includes(job.status);
  const street = job.address.split(',')[0] ?? job.address;
  const unread = job.unreadMessages ?? 0;
  const onHold = job.problemReportedAt !== null && job.problemResolvedAt === null;
  const payoutDay = job.payoutOn ? longDate(job.payoutOn, 'UTC') : null;

  const open = (kind: JobSheet) => setParams({ sheet: kind });
  const close = useCallback(() => setParams({}, { replace: true }), [setParams]);

  return (
    <>
      <div className="body stack">
        <section className="card" aria-labelledby="job-heading">
          <div className="row between">
            <h2 id="job-heading" className="b">
              {job.serviceName}
            </h2>
            <span className={`badge ${job.status === 'completed' ? 'g' : job.status === 'cancelled' ? 'grey' : 'b'}`}>{t(`job.stage.${job.status}`)}</span>
          </div>
          <p className="small muted">
            {dateTime(job.startsAt, timezone)} · {job.address}, {job.postcode}
          </p>
          {stepIndex >= 0 && (
            <ol className="flow" aria-label={t('job.progress')}>
              {STEPS.map((s, index) => (
                <li key={s} className={index <= stepIndex ? 'on' : ''}>
                  <span className="visually-hidden">
                    {t(`job.stage.${s}`)}: {index <= stepIndex ? t('booking.taskDone') : t('booking.taskTodo')}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <IssueState job={job} onChanged={onChanged} />

        {job.noShow && (
          <section className="card stack-tight" role="status" aria-labelledby="no-show-heading">
            <h2 id="no-show-heading" className="b">
              {t('job.noShowTitle')}
            </h2>
            <p className="earn">{euro(job.earningsCents)}</p>
            <p className="small muted">
              {payoutDay
                ? t('job.noShowText', { amount: euro(job.earningsCents), date: payoutDay })
                : t('job.noShowTextNoDate', { amount: euro(job.earningsCents) })}
            </p>
          </section>
        )}

        <section className="card customer-line" aria-label={t('offer.customer')}>
          <Avatar name={name} size="sm" />
          <span className="grow">
            <span className="b small block">{name}</span>
            <span className="tiny muted">
              {job.customer.ratingAverage != null && (job.customer.ratingCount ?? 0) > 0
                ? t('job.customerRated', { rating: job.customer.ratingAverage.toFixed(1), street })
                : t('job.customerNew', { street })}
            </span>
          </span>
          {job.status !== 'cancelled' && (
            <button
              type="button"
              className="iconbtn soft chat-btn"
              aria-label={unread > 0 ? t('job.chatUnread', { name, count: unread }) : t('job.chatWith', { name })}
              onClick={() => open('chat')}
            >
              <Icon name="chat" />
              {unread > 0 && (
                <span className="chat-badge" aria-hidden="true">
                  {unread}
                </span>
              )}
            </button>
          )}
        </section>

        {(job.notes || customerPhotos.length > 0) && (
          <section className="card stack" aria-label={t('offer.notes')}>
            {job.notes && <p className="small">“{job.notes}”</p>}
            <PhotoGrid ids={customerPhotos} label={t('job.customerPhotos')} />
          </section>
        )}

        <Checklist job={job} onChanged={onChanged} />

        {job.status === 'on_the_way' && <LocationShare job={job} />}

        {active && (
          <>
            <ExtraState job={job} />
            <WaitingPaid job={job} />
            <div className="job-actions" role="group" aria-label={t('job.actions')}>
              <button type="button" className="mini-btn" onClick={() => open('extra')}>
                <Icon name="plus" /> {t('job.addExtra')}
              </button>
              <button type="button" className="mini-btn" onClick={() => open('issue')}>
                <Icon name="alert" /> {t('job.reportIssue')}
              </button>
              {job.canCancel && (
                <button type="button" className="mini-btn danger-text" onClick={() => open('cancel')}>
                  <Icon name="x" /> {t('job.cancelJob')}
                </button>
              )}
            </div>
          </>
        )}

        {job.status === 'working' && completion.length > 0 && (
          <section aria-labelledby="photos-heading" className="stack">
            <h2 id="photos-heading" className="h-sm">
              {t('job.photos')}
            </h2>
            <PhotoGrid ids={completion} label={t('job.photos')} />
            {completion.length < MAX_COMPLETION_PHOTOS && (
              <span className="file-button">
                <input
                  id="more-photos"
                  type="file"
                  accept={IMAGE_TYPES}
                  className="visually-hidden"
                  disabled={photo.busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file || file.size > MAX_FILE_BYTES) return;
                    void photo
                      .run(() => api.upload<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/photos`, file))
                      .then((result) => result && onChanged(result.job));
                  }}
                />
                <label htmlFor="more-photos" className="mini-btn">
                  <Icon name="camera" /> {t('job.addPhoto')}
                </label>
              </span>
            )}
            <ErrorText error={photo.error} />
          </section>
        )}

        {job.status === 'completed' && (
          <>
            <section className="card" aria-labelledby="earned-heading">
              <div className="row between">
                <div>
                  <p id="earned-heading" className="small muted">
                    {t('job.youllEarn')}
                  </p>
                  <p className="earn">{euro(job.earningsCents)}</p>
                </div>
                {onHold ? (
                  <span className="badge r">{t('job.earningsOnHold')}</span>
                ) : (
                  <span className="badge">
                    <Icon name="clock" /> {t('job.earningsPending')}
                  </span>
                )}
              </div>
              <p className="tiny muted">
                {onHold
                  ? t('job.earningsOnHoldHint', { name })
                  : payoutDay
                    ? t('job.earningsPendingHint', { date: payoutDay })
                    : t('job.earningsPendingHintNoDate')}
              </p>
            </section>
            <WaitingPaid job={job} />
            {completion.length > 0 && (
              <section aria-labelledby="your-photos-heading" className="stack-tight">
                <h2 id="your-photos-heading" className="h-sm">
                  {t('job.yourPhotos')}
                </h2>
                <PhotoGrid ids={completion} label={t('job.photos')} />
              </section>
            )}
            <RateCustomer job={job} onChanged={onChanged} />
          </>
        )}
      </div>
      <MainButton job={job} onChanged={onChanged} />

      {sheet === 'chat' && <ChatSheet job={job} onClose={close} />}
      {sheet === 'extra' && active && (
        <ExtraWorkSheet
          job={job}
          onClose={close}
          onSent={(next) => {
            onChanged(next);
            close();
          }}
        />
      )}
      {sheet === 'issue' && active && (
        <IssueSheet
          job={job}
          onClose={close}
          onSendExtra={() => open('extra')}
          onSent={(next) => {
            onChanged(next);
            close();
          }}
        />
      )}
      {sheet === 'cancel' && job.canCancel && (
        <CancelJobSheet
          job={job}
          onClose={close}
          onCancelled={(result) => {
            close();
            onCancelled(result);
          }}
        />
      )}
    </>
  );
}

/** The Job sub-page of the pro app (D86): one accepted job while the pro does it. */
export function ProJobPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  const navigate = useNavigate();
  // Picks up the customer's answer to extra work, cancellations and new messages.
  usePolling(reload, 15_000, state.status === 'ready' && ACTIVE.includes(state.data.job.status));

  return (
    <>
      <AppHeader title={t('job.title')} back="/pro" />
      <ResourceState state={state} reload={reload}>
        {({ job }) => (
          <JobView
            job={job}
            onChanged={(next) => update(() => ({ job: next }))}
            // The job is no longer this pro's: the Jobs page shows "You cancelled this job" (D94).
            onCancelled={() => navigate('/pro', { replace: true })}
          />
        )}
      </ResourceState>
    </>
  );
}
