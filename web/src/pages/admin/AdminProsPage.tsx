import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { AdminProListItem, ProProfile, ProStatus } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { Stars } from '../../components/StatusBadge';
import { dateTime } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { DOCUMENT_KINDS } from '../pro/ApplicationForm';

const STATUSES: ProStatus[] = ['submitted', 'approved', 'rejected', 'suspended', 'draft'];

export function AdminProsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const load = useCallback(
    () => api.get<{ pros: AdminProListItem[] }>(`/admin/pros${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    [api, status],
  );
  const { state, reload } = useResource(load);

  return (
    <>
      <h1>{t('admin.pros.title')}</h1>
      <div className="seg wrap" role="group" aria-label={t('admin.pros.filter')}>
        <button type="button" className={status === '' ? 'on' : ''} aria-pressed={status === ''} onClick={() => setParams({})}>
          {t('admin.bookings.all')}
        </button>
        {STATUSES.map((s) => (
          <button key={s} type="button" className={status === s ? 'on' : ''} aria-pressed={status === s} onClick={() => setParams({ status: s })}>
            {t(`proStatus.${s}`)}
          </button>
        ))}
      </div>
      <ResourceState state={state} reload={reload}>
        {({ pros }) =>
          pros.length === 0 ? (
            <p className="panel muted">{t('admin.pros.none')}</p>
          ) : (
            <div className="panel scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.pros.name')}</th>
                    <th scope="col">{t('admin.pros.trades')}</th>
                    <th scope="col">{t('admin.pros.area')}</th>
                    <th scope="col">{t('admin.pros.documents')}</th>
                    <th scope="col">{t('admin.pros.rating')}</th>
                    <th scope="col">{t('admin.pros.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pros.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/admin/providers/${p.id}`} className="b">
                          {p.firstName ?? p.phone}
                        </Link>
                        {p.submittedAt && <span className="tiny muted block">{dateTime(p.submittedAt, timezone)}</span>}
                      </td>
                      <td>{p.trades.join(', ') || '–'}</td>
                      <td>{p.homePostcode ? t('admin.pros.areaLine', { postcode: p.homePostcode, km: p.radiusKm }) : '–'}</td>
                      <td>{t('admin.pros.docCount', { count: p.documentCount })}</td>
                      <td>
                        <Stars average={p.ratingAverage} count={p.ratingCount} />
                      </td>
                      <td>
                        <span className={`badge ${p.status === 'approved' ? 'g' : p.status === 'submitted' ? 'b' : 'grey'}`}>
                          {t(`proStatus.${p.status}`)}
                        </span>
                        {p.status === 'approved' && !p.payoutsEnabled && <span className="tiny muted block">{t('admin.pros.noPayouts')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceState>
    </>
  );
}

type AdminPro = ProProfile & { id: string; firstName: string | null; phone: string | null };

export function AdminProPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const market = useMarket();
  const load = useCallback(() => api.get<{ pro: AdminPro }>(`/admin/pros/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  const review = useAction();
  const [note, setNote] = useState('');

  async function decide(decision: 'approve' | 'reject' | 'suspend') {
    const result = await review.run(() =>
      api.post<{ pro: AdminPro }>(`/admin/pros/${encodeURIComponent(id)}/review`, { decision, note: note.trim() || undefined }),
    );
    if (result) {
      update((current) => ({ pro: { ...current.pro, ...result.pro } }));
      setNote('');
    }
  }

  return (
    <>
      <p>
        <Link to="/admin/providers">{t('admin.pros.back')}</Link>
      </p>
      <ResourceState state={state} reload={reload}>
        {({ pro }) => (
          <div className="agrid">
            <section className="panel stack">
              <div className="row between">
                <h1>{pro.firstName ?? pro.phone}</h1>
                <span className="badge b">{t(`proStatus.${pro.status}`)}</span>
              </div>
              <dl className="kv">
                <dt>{t('admin.pros.phone')}</dt>
                <dd>
                  <a href={`tel:${pro.phone ?? ''}`}>{pro.phone}</a>
                </dd>
                <dt>{t('admin.pros.trades')}</dt>
                <dd>{market.categories.filter((c) => pro.trades.includes(c.id)).map((c) => c.name).join(', ') || '–'}</dd>
                <dt>{t('admin.pros.area')}</dt>
                <dd>{pro.homePostcode ? t('admin.pros.areaLine', { postcode: pro.homePostcode, km: pro.radiusKm }) : '–'}</dd>
                <dt>{t('admin.pros.days')}</dt>
                <dd>{pro.workingDays.map((d) => t(`weekday.${d as 1 | 2 | 3 | 4 | 5 | 6 | 7}`)).join(', ')}</dd>
                <dt>{t('admin.pros.payouts')}</dt>
                <dd>{pro.payoutsEnabled ? t('admin.pros.payoutsReady') : t('admin.pros.noPayouts')}</dd>
                <dt>{t('admin.pros.rating')}</dt>
                <dd>
                  <Stars average={pro.ratingAverage} count={pro.ratingCount} />
                </dd>
              </dl>
              {pro.reviewNote && <p className="small muted">{t('admin.pros.lastNote', { note: pro.reviewNote })}</p>}
            </section>
            <section className="panel stack" aria-labelledby="docs-title">
              <h2 id="docs-title">{t('admin.pros.documents')}</h2>
              <ul className="history">
                {DOCUMENT_KINDS.map((kind) => {
                  const doc = pro.documents[kind];
                  return (
                    <li key={kind} className="row between">
                      <span>{t(`apply.doc.${kind}`)}</span>
                      {doc ? (
                        <a href={api.fileUrl(doc.uploadId)} target="_blank" rel="noreferrer">
                          <Icon name="file" /> {t('admin.pros.open')}
                        </a>
                      ) : (
                        <span className="muted">{t('admin.pros.missing')}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="af">
                <label htmlFor="review-note">{t('admin.pros.note')}</label>
                <textarea id="review-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                <span className="hint">{t('admin.pros.noteHint')}</span>
              </div>
              <div className="row gap8 wrap">
                {(pro.status === 'submitted' || pro.status === 'suspended') && (
                  <button type="button" className="abtn" disabled={review.busy} onClick={() => void decide('approve')}>
                    {t('admin.pros.approve')}
                  </button>
                )}
                {pro.status === 'submitted' && (
                  <button type="button" className="abtn ghost" disabled={review.busy || !note.trim()} onClick={() => void decide('reject')}>
                    {t('admin.pros.reject')}
                  </button>
                )}
                {pro.status === 'approved' && (
                  <button type="button" className="abtn danger" disabled={review.busy} onClick={() => void decide('suspend')}>
                    {t('admin.pros.suspend')}
                  </button>
                )}
              </div>
              <ErrorText error={review.error} />
            </section>
          </div>
        )}
      </ResourceState>
    </>
  );
}
