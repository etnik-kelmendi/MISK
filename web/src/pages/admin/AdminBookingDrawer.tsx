import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { AdminAction, AdminBooking, AdminVisit, BookingStatus, IssueReason, ProCancelReason } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Drawer } from '../../components/Drawer';
import { ErrorText } from '../../components/ErrorText';
import { PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dateTime, dayName, euro, zonedParts, zonedToIso } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { CustomerProfileCard } from './CustomerProfileCard';
import type { CustomerProfile } from '../../api/types';

/** The customer's full name, with a jump to their profile further down the panel. */
function CustomerLink({ profile }: { profile: CustomerProfile }) {
  const { t } = useTranslation();
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || t('admin.customer.noName');
  return (
    <>
      <span className="b">{name}</span>
      {' · '}
      <button
        type="button"
        className="link"
        onClick={() => {
          const card = document.getElementById('customer-profile');
          if (!card) return;
          card.focus({ preventScroll: true });
          // Not every environment can scroll smoothly (or at all); the focus alone still takes the reader there.
          if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      >
        {t('admin.booking.viewProfile')}
      </button>
    </>
  );
}

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
      // What the pro did on the job (D86).
      case 'pro_cancelled':
        return t(entry.details.late ? 'admin.booking.logAction.pro_cancelled_late' : 'admin.booking.logAction.pro_cancelled', {
          name: entry.details.proName ?? '',
          reason: t(`proCancel.reasons.${(entry.details.reason ?? 'other') as ProCancelReason}`),
        });
      case 'issue_reported':
        return t('admin.booking.logAction.issue_reported', {
          name: entry.details.proName ?? '',
          reason: t(`issue.reasons.${(entry.details.reason ?? 'other') as IssueReason}`),
        });
      case 'issue_resolved':
        return t('admin.booking.logAction.issue_resolved', { reason: t(`issue.reasons.${(entry.details.reason ?? 'other') as IssueReason}`) });
      default:
        return t(`admin.booking.logAction.${entry.action}`);
    }
  })();
  return (
    <li>
      {text}
      {(entry.action === 'pro_cancelled' || entry.action === 'issue_reported') && entry.details.note && (
        <div className="small log-note">{t('admin.booking.proNote', { note: entry.details.note })}</div>
      )}
      {entry.action === 'cancelled' && entry.details.note && (
        <div className="small log-note">
          {t('admin.booking.cancelNote.logged', { note: entry.details.note })}{' '}
          <span className="muted">
            {entry.details.sentToCustomer ? t('admin.booking.cancelNote.sentToCustomer') : t('admin.booking.cancelNote.teamOnly')}
          </span>
        </div>
      )}
      <div className="small muted">
        {t('admin.booking.logBy', { name: entry.adminName ?? '–', date: dateTime(entry.createdAt, timezone) })}
      </div>
    </li>
  );
}

/**
 * What the pro reported on site and the jobs pros gave back (D86). An open issue keeps the booking under
 * Needs action until someone in the team marks it resolved.
 */
function ProReports({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const action = useAction();
  const issues = booking.issues ?? [];
  const cancellations = booking.proCancellations ?? [];
  if (issues.length === 0 && cancellations.length === 0) return null;

  async function resolve(issueId: string) {
    const result = await action.run(() =>
      api.post<{ booking: AdminBooking }>(`/admin/bookings/${encodeURIComponent(booking.id)}/issues/${encodeURIComponent(issueId)}/resolve`),
    );
    if (result) onChanged(result.booking);
  }

  return (
    <section className="stack" aria-labelledby="pro-reports-heading">
      <h3 id="pro-reports-heading">{t('admin.booking.proReports')}</h3>
      {issues.map((issue) => (
        <div key={issue.id} className={`note stack ${issue.resolvedAt ? '' : 'warn-note'}`} role={issue.resolvedAt ? undefined : 'status'}>
          <p>
            <b>{t('admin.booking.issueBy', { name: issue.proName ?? '', reason: t(`issue.reasons.${issue.reason}`) })}</b>{' '}
            <span className="small muted">{dateTime(issue.createdAt, timezone)}</span>
          </p>
          {issue.details && <blockquote className="small">{issue.details}</blockquote>}
          {issue.resolvedAt ? (
            <p className="small muted">{t('admin.booking.issueResolvedAt', { date: dateTime(issue.resolvedAt, timezone) })}</p>
          ) : (
            <button type="button" className="abtn" disabled={action.busy} onClick={() => void resolve(issue.id)}>
              {t('admin.booking.resolveIssue')}
            </button>
          )}
        </div>
      ))}
      {cancellations.map((entry) => (
        <p key={entry.createdAt} className="small">
          {t(entry.late ? 'admin.booking.proCancelledLate' : 'admin.booking.proCancelled', {
            name: entry.proName ?? '',
            reason: t(`proCancel.reasons.${entry.reason}`),
            date: dateTime(entry.createdAt, timezone),
          })}
          {entry.note && <span className="block muted">“{entry.note}”</span>}
        </p>
      ))}
      <ErrorText error={action.error} />
    </section>
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
/** Must match CANCEL_NOTE_MAX in the API: the note fits in one text message with the rest (D63). */
const CANCEL_NOTE_MAX = 300;

function MoneyActions({ booking, onChanged }: { booking: AdminBooking; onChanged: (b: AdminBooking) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [confirm, setConfirm] = useState<Confirmable | null>(null);
  const [note, setNote] = useState('');
  const [sendNote, setSendNote] = useState(false);
  const [noteMissing, setNoteMissing] = useState(false);
  const noteId = useId();
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

  function open(kind: Confirmable) {
    action.clearError();
    setNote('');
    setSendNote(false);
    setNoteMissing(false);
    setConfirm(kind);
  }

  async function act(kind: Confirmable) {
    // Sending the note needs a note; the field says so and nothing is sent (D42).
    if (kind === 'cancel' && sendNote && !note.trim()) {
      setNoteMissing(true);
      document.getElementById(noteId)?.focus();
      return;
    }
    const body = kind === 'cancel' ? { note: note.trim() || undefined, sendToCustomer: sendNote } : undefined;
    const result = await action.run(() => api.post<{ booking: AdminBooking }>(`/admin/bookings/${booking.id}/${kind}`, body));
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
          {confirm === 'cancel' && (
            <div className="stack tight">
              <div className="af">
                <label htmlFor={noteId}>{t('admin.booking.cancelNote.label')}</label>
                <textarea
                  id={noteId}
                  rows={3}
                  maxLength={CANCEL_NOTE_MAX}
                  value={note}
                  aria-invalid={noteMissing && !note.trim() ? true : undefined}
                  aria-describedby={noteMissing && !note.trim() ? `${noteId}-error` : `${noteId}-hint`}
                  onChange={(e) => setNote(e.target.value)}
                />
                {noteMissing && !note.trim() ? (
                  <span id={`${noteId}-error`} className="error-text small" role="alert">
                    {t('admin.booking.cancelNote.missing')}
                  </span>
                ) : (
                  <span id={`${noteId}-hint`} className="hint">
                    {t('admin.booking.cancelNote.hint', { left: CANCEL_NOTE_MAX - note.length })}
                  </span>
                )}
              </div>
              <label className="row gap8 small">
                <input type="checkbox" checked={sendNote} onChange={(e) => setSendNote(e.target.checked)} />
                {t('admin.booking.cancelNote.send')}
              </label>
              <p className="tiny muted">{t('admin.booking.cancelNote.proNever')}</p>
            </div>
          )}
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
            <button key={kind} type="button" className="abtn ghost" aria-haspopup="dialog" onClick={() => open(kind)}>
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
          {booking.customerProfile ? (
            <CustomerLink profile={booking.customerProfile} />
          ) : (
            booking.customer.firstName
          )}
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
      {booking.customerRating && (
        <p className="small">
          {t('admin.booking.customerRated', { stars: booking.customerRating.stars, name: booking.pro?.firstName ?? '' })}
          {booking.customerRating.tags.length > 0 &&
            ` · ${booking.customerRating.tags.map((tag) => t(`customerRating.tags.${tag}`)).join(', ')}`}
        </p>
      )}
      <ProReports booking={booking} onChanged={onChanged} />

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
          {visit.customerProfile ? (
            <CustomerLink profile={visit.customerProfile} />
          ) : (
            [visit.customer.firstName, visit.customer.lastName].filter(Boolean).join(' ')
          )}
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
        {visit.pause && (
          <>
            <dt>{t('admin.booking.visit.paused')}</dt>
            <dd>
              {t('admin.booking.visit.pausedBy', {
                from: dayName(`${visit.pause.startsOn}T12:00:00Z`, 'UTC'),
                to: dayName(`${visit.pause.endsOn}T12:00:00Z`, 'UTC'),
                credit: euro(visit.pause.creditCents),
                count: visit.pause.visitsCalledOff,
              })}
            </dd>
          </>
        )}
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
