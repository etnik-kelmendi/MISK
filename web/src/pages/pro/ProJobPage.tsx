import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingStatus, ProJob } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon, type IconKey } from '../../components/Icon';
import { FileButton, IMAGE_TYPES, PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro, parseEuroToCents } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { AppHeader } from '../../shells/Shells';

const STEPS: BookingStatus[] = ['accepted', 'on_the_way', 'working', 'completed'];
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
  const { run, busy, error } = useAction();
  const cents = parseEuroToCents(price);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (cents === null) {
      return;
    }
    const result = await run(() => api.post<{ job: ProJob }>(`/pro/jobs/${job.id}/extras`, { description, priceCents: cents }));
    if (result) {
      onChanged(result.job);
      setOpen(false);
      setDescription('');
      setPrice('');
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
    <form className="card stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor="extra-description">{t('job.extraWhat')}</label>
        <input
          id="extra-description"
          required
          minLength={3}
          maxLength={200}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="extra-price">{t('job.extraPrice')}</label>
        <input id="extra-price" inputMode="decimal" required value={price} onChange={(event) => setPrice(event.target.value)} />
        {price && cents === null && <span className="error-text">{t('job.extraPriceInvalid')}</span>}
      </div>
      <p className="tiny muted">{t('job.extraExplained')}</p>
      <ErrorText error={error} />
      <div className="row gap8">
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || cents === null || description.trim().length < 3}>
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
          <p className="small">{t('job.customer', { name: job.customer.firstName ?? '' })}</p>
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
        <PhotoGrid ids={customerPhotos} label={t('job.customerPhotos')} />

        {job.extras.map((extra) => (
          <div key={extra.id} className="card row between">
            <span>
              <span className="b small block">{extra.description}</span>
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
