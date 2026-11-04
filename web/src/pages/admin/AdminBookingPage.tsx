import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { AdminBooking } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, euro } from '../../lib/format';
import { useAction } from '../../lib/useAction';

interface Candidate {
  id: string;
  firstName: string | null;
  distanceKm: number;
  ratingAverage: number | null;
}

const REASSIGNABLE = new Set(['searching', 'unassigned', 'accepted', 'on_the_way']);

function Actions({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [confirm, setConfirm] = useState<'cancel' | 'refund' | null>(null);
  const [proId, setProId] = useState('');
  const canReassign = REASSIGNABLE.has(booking.status);
  const loadCandidates = useCallback(
    () => (canReassign ? api.get<{ candidates: Candidate[] }>(`/admin/bookings/${booking.id}/candidates`) : Promise.resolve({ candidates: [] })),
    [api, booking.id, canReassign],
  );
  const candidates = useResource(loadCandidates);
  const canCancel = booking.status !== 'completed' && booking.status !== 'cancelled';
  const canRefund = booking.status === 'completed' && booking.paymentStatus === 'captured';

  async function act(path: string, body?: unknown) {
    const result = await action.run(() => api.post<{ booking: AdminBooking }>(`/admin/bookings/${booking.id}/${path}`, body));
    if (result) {
      onChanged(result.booking);
      setConfirm(null);
      candidates.reload();
    }
  }

  return (
    <section className="panel stack" aria-labelledby="actions-heading">
      <h2 id="actions-heading">{t('admin.booking.actions')}</h2>
      {canReassign && (
        <div className="row gap8 wrap">
          <div className="af grow">
            <label htmlFor="reassign">{t('admin.booking.assignTo')}</label>
            <select id="reassign" value={proId} onChange={(e) => setProId(e.target.value)}>
              <option value="">{t('admin.booking.restartSearch')}</option>
              {candidates.state.status === 'ready' &&
                candidates.state.data.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {t('admin.booking.candidate', {
                      name: c.firstName ?? '',
                      km: c.distanceKm,
                      rating: c.ratingAverage === null ? '–' : c.ratingAverage.toFixed(1),
                    })}
                  </option>
                ))}
            </select>
          </div>
          <button type="button" className="abtn" disabled={action.busy} onClick={() => void act('reassign', proId ? { proId } : {})}>
            {proId ? t('admin.booking.assign') : t('admin.booking.restart')}
          </button>
        </div>
      )}
      {(canCancel || canRefund) &&
        (confirm ? (
          <div role="alertdialog" aria-labelledby="confirm-text" className="stack">
            <p id="confirm-text">{t(`admin.booking.confirm.${confirm}`)}</p>
            <div className="row gap8">
              <button type="button" className="abtn ghost" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="abtn danger" disabled={action.busy} onClick={() => void act(confirm)}>
                {t(`admin.booking.do.${confirm}`)}
              </button>
            </div>
          </div>
        ) : (
          <div className="row gap8">
            {canCancel && (
              <button type="button" className="abtn ghost" onClick={() => setConfirm('cancel')}>
                {t('admin.booking.do.cancel')}
              </button>
            )}
            {canRefund && (
              <button type="button" className="abtn ghost" onClick={() => setConfirm('refund')}>
                {t('admin.booking.do.refund')}
              </button>
            )}
          </div>
        ))}
      <ErrorText error={action.error} />
    </section>
  );
}

export function AdminBookingPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ booking: AdminBooking }>(`/admin/bookings/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);

  return (
    <>
      <p>
        <Link to="/admin/bookings">{t('admin.booking.back')}</Link>
      </p>
      <ResourceState state={state} reload={reload}>
        {({ booking }) => (
          <div className="agrid">
            <div className="stack">
              <section className="panel">
                <div className="row between">
                  <h1>{booking.serviceName}</h1>
                  <StatusBadge status={booking.status} />
                </div>
                <dl className="kv">
                  <dt>{t('admin.booking.when')}</dt>
                  <dd>{dateTime(booking.startsAt, timezone)}</dd>
                  <dt>{t('admin.booking.where')}</dt>
                  <dd>
                    {booking.address}, {booking.postcode}
                  </dd>
                  <dt>{t('admin.booking.customer')}</dt>
                  <dd>
                    {booking.customer.firstName} · <a href={`tel:${booking.customer.phone ?? ''}`}>{booking.customer.phone}</a>
                  </dd>
                  <dt>{t('admin.booking.pro')}</dt>
                  <dd>
                    {booking.pro ? (
                      <>
                        <Link to={`/admin/providers/${booking.pro.id}`}>{booking.pro.firstName}</Link> ·{' '}
                        <a href={`tel:${booking.pro.phone ?? ''}`}>{booking.pro.phone}</a>
                      </>
                    ) : (
                      '–'
                    )}
                  </dd>
                  <dt>{t('admin.booking.notes')}</dt>
                  <dd>{booking.notes || '–'}</dd>
                  <dt>{t('admin.booking.money')}</dt>
                  <dd>
                    {t('admin.booking.moneyLine', {
                      total: euro(booking.totalCents),
                      fee: euro(booking.feeCents),
                      extras: euro(booking.extrasCents),
                      share: booking.proSharePct,
                    })}
                  </dd>
                  <dt>{t('admin.booking.payment')}</dt>
                  <dd>{t(`payment.${booking.paymentStatus}`)}</dd>
                </dl>
              </section>
              <PhotoGrid ids={booking.photos.map((p) => p.id)} label={t('admin.booking.photos')} />
              <Actions booking={booking} onChanged={(next) => update(() => ({ booking: next }))} />
            </div>
            <div className="stack">
              <section className="panel">
                <h2>{t('admin.booking.history')}</h2>
                <ol className="history">
                  {booking.events.map((e, i) => (
                    <li key={`${e.status}-${i}`}>
                      <StatusBadge status={e.status} /> <span className="small muted">{dateTime(e.at, timezone)}</span>
                    </li>
                  ))}
                </ol>
              </section>
              <section className="panel">
                <h2>{t('admin.booking.offers')}</h2>
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
              {booking.extras.length > 0 && (
                <section className="panel">
                  <h2>{t('booking.extras')}</h2>
                  <ul className="history">
                    {booking.extras.map((x) => (
                      <li key={x.id}>
                        {x.description} · {euro(x.priceCents)} · {t(`extra.status.${x.status}`)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {booking.payouts.length > 0 && (
                <section className="panel">
                  <h2>{t('admin.booking.payouts')}</h2>
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
            </div>
          </div>
        )}
      </ResourceState>
    </>
  );
}
