import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingStatus, ProJob } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon, type IconKey } from '../../components/Icon';
import { FileButton, IMAGE_TYPES, PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro, parseEuroToCents, time } from '../../lib/format';
import { formatDuration } from '../customer/BookingPage';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { FieldError } from '../../components/FieldError';
import { usePolling } from '../../lib/usePolling';
import { AppHeader } from '../../shells/Shells';

const STEPS: BookingStatus[] = ['accepted', 'on_the_way', 'working', 'completed'];
/** How long extra work may take, in 15-minute steps up to 8 hours (D83). */
export const EXTRA_DURATIONS = Array.from({ length: 32 }, (_, index) => (index + 1) * 15);
/** The phone's position is sent at most this often while the pro is on the way (D83). */
export const LOCATION_EVERY_MS = 20_000;

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
  const name = job.customer.firstName ?? t('chat.yourCustomer');

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
        {sentAt &&<span className="block tiny muted">{t('job.location.sent', { time: time(sentAt, timezone) })}</span>}
      </span>
    </section>
  );
}
const NEXT: Partial<Record<BookingStatus, { status: 'on_the_way' | 'working'; icon: IconKey }>> = {
  accepted: { status: 'on_the_way', icon: 'truck' },
  on_the_way: { status: 'working', icon: 'play' },
};

function ExtraForm({ job, onChanged }: { job: ProJob; onChanged: (j: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('');
  const { run, busy, error } = useAction();
  const cents = parseEuroToCents(price);
  const form = useValidation(
    {
      description: !description.trim()
        ? t('validation.extraWhatMissing')
        : description.trim().length < 3 && t('validation.noteShort', { min: 3 }),
      price: !price.trim() ? t('validation.extraPriceMissing') : cents === null && t('job.extraPriceInvalid'),
      duration: !duration && t('validation.extraDurationMissing'),
    },
    { description: 'extra-description', price: 'extra-price', duration: 'extra-duration' },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check() || cents === null || !duration) {
      return;
    }
    const result = await run(() =>
      api.post<{ job: ProJob }>(`/pro/jobs/${job.id}/extras`, {
        description: description.trim(),
        priceCents: cents,
        durationMinutes: Number(duration),
      }),
    );
    if (result) {
      onChanged(result.job);
      setOpen(false);
      setDescription('');
      setPrice('');
      setDuration('');
    }
  }

  if (!open) {
    return (
      <button type="button" className="mini-btn" onClick={() => setOpen(true)}>
        <Icon name="plus" /> {t('job.addExtra')}
      </button>
    );
  }
  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="extra-description">{t('job.extraWhat')}</label>
        <input
          id="extra-description"
          required
          minLength={3}
          maxLength={200}
          value={description}
          {...form.describe('description')}
          onChange={(event) => setDescription(event.target.value)}
        />
        <FieldError id="extra-description" message={form.message('description')} />
      </div>
      <div className="field">
        <label htmlFor="extra-price">{t('job.extraPrice')}</label>
        <input
          id="extra-price"
          inputMode="decimal"
          required
          value={price}
          {...form.describe('price')}
          onChange={(event) => setPrice(event.target.value)}
        />
        {form.message('price') ? (
          <FieldError id="extra-price" message={form.message('price')} />
        ) : (
          price && cents === null && <span className="error-text">{t('job.extraPriceInvalid')}</span>
        )}
      </div>
      <div className="field">
        <label htmlFor="extra-duration">{t('job.extraDuration')}</label>
        <select id="extra-duration" required value={duration} {...form.describe('duration')} onChange={(event) => setDuration(event.target.value)}>
          <option value="">{t('job.extraDurationChoose')}</option>
          {EXTRA_DURATIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {formatDuration(minutes, t)}
            </option>
          ))}
        </select>
        <FieldError id="extra-duration" message={form.message('duration')} />
      </div>
      <p className="tiny muted">{t('job.extraExplained')}</p>
      <ErrorText error={error} />
      <div className="row gap8">
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('job.sendExtra')}
        </button>
      </div>
    </form>
  );
}

function JobView({ job, onChanged }: { job: ProJob; onChanged: (j: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const step = useAction();
  const photo = useAction();
  const completion = job.photos.filter((p) => p.kind === 'completion').map((p) => p.id);
  const customerPhotos = job.photos.filter((p) => p.kind === 'customer').map((p) => p.id);
  const next = NEXT[job.status];
  const stepIndex = STEPS.indexOf(job.status);
  const active = ['accepted', 'on_the_way', 'working'].includes(job.status);

  return (
    <>
      <div className="body">
        <div className="card">
          <div className="row between">
            <h2 className="b">{job.serviceName}</h2>
            <StatusBadge status={job.status} />
          </div>
          <p className="small muted">
            {dateTime(job.startsAt, timezone)} · {job.address}, {job.postcode}
          </p>
          <div className="row between">
            <p className="small">{t('job.customer', { name: job.customer.firstName ?? '' })}</p>
            {job.status !== 'cancelled' && (
              <Link to={`/pro/jobs/${encodeURIComponent(job.id)}/chat`} className="mini-btn">
                <Icon name="chat" /> {t('job.chat')}
              </Link>
            )}
          </div>
          {job.notes && <p className="small">“{job.notes}”</p>}
          {stepIndex >= 0 && (
            <ol className="flow" aria-label={t('job.progress')}>
              {STEPS.map((s, index) => (
                <li key={s} className={index <= stepIndex ? 'on' : ''}>
                  <span className="visually-hidden">{t(`status.${s}`)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        {job.status === 'on_the_way' && <LocationShare job={job} />}
        <PhotoGrid ids={customerPhotos} label={t('job.customerPhotos')} />

        {job.extras.map((extra) => (
          <div key={extra.id} className="card row between">
            <span>
              <span className="b small block">{extra.description}</span>
              {extra.durationMinutes ? (
                <span className="tiny muted block">{t('job.extraTakes', { duration: formatDuration(extra.durationMinutes, t) })}</span>
              ) : null}
              <span className="tiny muted">{t(`extra.status.${extra.status}`)}</span>
            </span>
            <span className="b">+{euro(extra.priceCents)}</span>
          </div>
        ))}
        {active && !job.extras.some((e) => e.status === 'pending' || e.status === 'awaiting_payment') && (
          <ExtraForm job={job} onChanged={onChanged} />
        )}

        {job.status === 'working' && (
          <section aria-labelledby="photos-heading">
            <h2 id="photos-heading" className="h-sm">
              {t('job.photos')}
            </h2>
            <PhotoGrid ids={completion} label={t('job.photos')} />
            {completion.length < 6 && (
              <FileButton
                label={t('job.addPhoto')}
                accept={IMAGE_TYPES}
                icon="camera"
                onFile={async (file) => {
                  const result = await photo.run(() => api.upload<{ job: ProJob }>(`/pro/jobs/${job.id}/photos`, file));
                  if (result) {
                    onChanged(result.job);
                  }
                }}
              />
            )}
            <ErrorText error={photo.error} />
          </section>
        )}

        {job.status === 'completed' && (
          <div className="card row between">
            <div>
              <p className="small muted">{t('job.earned')}</p>
              <p className="earn">{euro(job.earningsCents)}</p>
            </div>
            <p className="small muted right">{t('job.paidOut')}</p>
          </div>
        )}
        {job.status === 'completed' && <PhotoGrid ids={completion} label={t('job.photos')} />}
        <ErrorText error={step.error} />
      </div>
      {(next || job.status === 'working') && (
        <div className="cta-bar">
          {next ? (
            <button
              type="button"
              className="cta dark"
              disabled={step.busy}
              onClick={() =>
                void step
                  .run(() => api.post<{ job: ProJob }>(`/pro/jobs/${job.id}/status`, { status: next.status }))
                  .then((result) => result && onChanged(result.job))
              }
            >
              <Icon name={next.icon} /> {t(`job.go.${next.status}`)}
            </button>
          ) : (
            <button
              type="button"
              className="cta dark"
              disabled={step.busy || completion.length === 0}
              onClick={() =>
                void step
                  .run(() => api.post<{ job: ProJob }>(`/pro/jobs/${job.id}/complete`))
                  .then((result) => result && onChanged(result.job))
              }
            >
              <Icon name="check" /> {completion.length ? t('job.complete') : t('job.photoFirst')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

export function ProJobPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const load = useCallback(() => api.get<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  // Picks up the customer's answer to extra work and cancellations.
  usePolling(reload, 15_000, state.status === 'ready' && state.data.job.status !== 'completed');

  return (
    <>
      <AppHeader title={t('job.title')} back="/pro" />
      <ResourceState state={state} reload={reload}>
        {({ job }) => <JobView job={job} onChanged={(next) => update(() => ({ job: next }))} />}
      </ResourceState>
    </>
  );
}
