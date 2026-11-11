import { useCallback, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import { EXPIRING_KINDS, type AdminProDetail, type ProActionEntry, type ProCheck } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Drawer } from '../../components/Drawer';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro, longDate, zonedToIso } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { FieldError } from '../../components/FieldError';
import { fullName, LOW_ACCEPTANCE_PCT, LOW_ON_TIME_PCT, Pct } from './proFormat';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type Changed = (pro: AdminProDetail, notice?: string) => void;

/** A short text the admin must write before an action goes out, e.g. a reason or a message to the pro. */
function NoteForm({
  label,
  submitLabel,
  danger = false,
  onSubmit,
  onCancel,
  busy,
}: {
  label: string;
  submitLabel: string;
  danger?: boolean;
  onSubmit: (note: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [note, setNote] = useState('');
  const form = useValidation(
    { note: !note.trim() ? t('validation.noteMissing') : note.trim().length < 3 && t('validation.noteShort', { min: 3 }) },
    { note: id },
  );
  return (
    <form
      className="stack confirm"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (form.check()) {
          onSubmit(note.trim());
        }
      }}
    >
      <div className="af">
        <label htmlFor={id}>{label}</label>
        <textarea id={id} rows={3} maxLength={500} value={note} {...form.describe('note')} onChange={(e) => setNote(e.target.value)} />
        <FieldError id={id} message={form.message('note')} />
      </div>
      <div className="row gap8 wrap">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('admin.pros.panel.cancel')}
        </button>
        <button type="submit" className={danger ? 'abtn danger' : 'abtn'} disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function CheckItem({ pro, check, onChanged }: { pro: AdminProDetail; check: ProCheck; onChanged: Changed }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const action = useAction();
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  const doc = check.document;
  const [expiresOn, setExpiresOn] = useState(doc?.expiresOn ?? '');
  const documentName = t(`admin.pros.panel.check.${check.kind}`);
  const expiryId = useId();
  const canDecide = doc !== null && doc.reviewStatus !== 'accepted';
  const canRemind = check.state === 'missing' || check.state === 'rejected' || check.state === 'expired' || check.state === 'expiring';

  const explanation = (() => {
    switch (check.state) {
      case 'missing':
        return t('admin.pros.panel.state.missing');
      case 'waiting_review':
        return t('admin.pros.panel.state.waiting_review', { date: doc ? longDate(doc.uploadedAt, timezone) : '' });
      case 'rejected':
        return t('admin.pros.panel.state.rejected', { note: doc?.reviewNote ?? '' });
      case 'expired':
      case 'expiring':
        return t(`admin.pros.panel.state.${check.state}`, { date: doc?.expiresOn ? longDate(doc.expiresOn, timezone) : '' });
      case 'valid':
        return doc?.expiresOn
          ? t('admin.pros.panel.state.valid', { date: longDate(doc.expiresOn, timezone) })
          : t('admin.pros.panel.state.validForever');
    }
  })();

  async function post(path: string, body: unknown, notice?: string) {
    const result = await action.run(() =>
      api.post<{ pro: AdminProDetail; backToActive?: boolean }>(`/admin/pros/${pro.id}/documents/${check.kind}/${path}`, body),
    );
    if (result) {
      setMode('idle');
      onChanged(result.pro, result.backToActive ? t('admin.pros.panel.backToActive') : notice);
    }
  }

  return (
    <li>
      <div className="row between gap8">
        <span className="b">{documentName}</span>
        <span className={`badge ${check.ok ? 'g' : 'r'}`}>{check.ok ? t('admin.pros.panel.ok') : t('admin.pros.panel.openCheck')}</span>
      </div>
      <p className={`small ${check.state === 'expired' || check.state === 'rejected' ? 'low' : 'muted'}`}>{explanation}</p>
      {doc && (
        <p className="small">
          {t('admin.pros.panel.file', { name: doc.fileName || documentName, date: longDate(doc.uploadedAt, timezone) })}
          {' · '}
          {doc.expiresOn ? t('admin.pros.panel.expires', { date: longDate(doc.expiresOn, timezone) }) : t('admin.pros.panel.noExpiry')}
          {' · '}
          <a
            href={api.fileUrl(doc.uploadId)}
            target="_blank"
            rel="noreferrer"
            aria-label={t('admin.pros.panel.viewLabel', { name: documentName })}
          >
            {t('admin.pros.panel.view')}
          </a>
        </p>
      )}
      {canDecide && mode === 'idle' && (
        <div className="row gap8 wrap filters">
          {EXPIRING_KINDS.includes(check.kind) && (
            <div className="af">
              <label htmlFor={expiryId}>{t('admin.pros.panel.expiryLabel')}</label>
              <input id={expiryId} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </div>
          )}
          <button
            type="button"
            className="abtn"
            disabled={action.busy}
            aria-label={t('admin.pros.panel.acceptLabel', { document: documentName })}
            onClick={() => void post('accept', expiresOn && expiresOn !== doc.expiresOn ? { expiresOn } : {})}
          >
            {t('admin.pros.panel.accept')}
          </button>
          {doc.reviewStatus === 'pending' && (
            <button
              type="button"
              className="abtn ghost"
              aria-label={t('admin.pros.panel.rejectLabel', { document: documentName })}
              onClick={() => setMode('reject')}
            >
              {t('admin.pros.panel.reject')}
            </button>
          )}
        </div>
      )}
      {mode === 'reject' && (
        <NoteForm
          label={t('admin.pros.panel.rejectNote', { document: documentName })}
          submitLabel={t('admin.pros.panel.rejectSend')}
          danger
          busy={action.busy}
          onCancel={() => setMode('idle')}
          onSubmit={(note) => void post('reject', { note })}
        />
      )}
      {canRemind && (
        <button
          type="button"
          className="abtn ghost"
          disabled={action.busy}
          aria-label={t('admin.pros.panel.remindLabel', { document: documentName })}
          onClick={() => void post('remind', undefined, t('admin.pros.panel.reminded'))}
        >
          <Icon name="chat" /> {t('admin.pros.panel.remind')}
        </button>
      )}
      <ErrorText error={action.error} />
    </li>
  );
}

/** Approve, ask for more information, or reject a new application. */
function Decision({ pro, onChanged }: { pro: AdminProDetail; onChanged: Changed }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [mode, setMode] = useState<'idle' | 'info' | 'reject'>('idle');

  async function post(path: string, body?: unknown) {
    const result = await action.run(() => api.post<{ pro: AdminProDetail }>(`/admin/pros/${pro.id}/${path}`, body));
    if (result) {
      setMode('idle');
      onChanged(result.pro);
    }
  }

  return (
    <section className="stack" aria-labelledby="decision-heading">
      <h3 id="decision-heading">{t('admin.pros.panel.decision')}</h3>
      {pro.status === 'info_requested' && pro.reviewNote && (
        <p className="note">{t('admin.pros.panel.infoRequested', { message: pro.reviewNote })}</p>
      )}
      {mode === 'idle' && (
        <>
          <div className="row gap8 wrap">
            <button type="button" className="abtn" disabled={!pro.allChecksOk || action.busy} onClick={() => void post('approve')}>
              <Icon name="check" /> {t('admin.pros.panel.approve')}
            </button>
            <button type="button" className="abtn ghost" onClick={() => setMode('info')}>
              {t('admin.pros.panel.requestInfo')}
            </button>
            <button type="button" className="abtn ghost" onClick={() => setMode('reject')}>
              {t('admin.pros.panel.rejectApplication')}
            </button>
          </div>
          {!pro.allChecksOk && <p className="small muted">{t('admin.pros.panel.approveHint')}</p>}
        </>
      )}
      {mode === 'info' && (
        <NoteForm
          label={t('admin.pros.panel.requestInfoLabel')}
          submitLabel={t('admin.pros.panel.requestInfoSend')}
          busy={action.busy}
          onCancel={() => setMode('idle')}
          onSubmit={(message) => void post('request-info', { message })}
        />
      )}
      {mode === 'reject' && (
        <NoteForm
          label={t('admin.pros.panel.rejectApplicationLabel')}
          submitLabel={t('admin.pros.panel.rejectApplicationSend')}
          danger
          busy={action.busy}
          onCancel={() => setMode('idle')}
          onSubmit={(note) => void post('reject', { note })}
        />
      )}
      <ErrorText error={action.error} />
    </section>
  );
}

/** Watch list, coaching call, pausing jobs, suspending and reinstating. */
function Actions({ pro, onChanged }: { pro: AdminProDetail; onChanged: Changed }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const action = useAction();
  const [mode, setMode] = useState<'idle' | 'coaching' | 'suspend'>('idle');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [invalid, setInvalid] = useState(false);

  async function post(path: string, body?: unknown, notice?: (result: { pro: AdminProDetail; handOver?: HandOver }) => string) {
    const result = await action.run(() => api.post<{ pro: AdminProDetail; handOver?: HandOver }>(`/admin/pros/${pro.id}/${path}`, body));
    if (result) {
      setMode('idle');
      onChanged(result.pro, notice?.(result));
    }
  }

  if (pro.status === 'suspended') {
    return (
      <section className="stack" aria-labelledby="actions-heading">
        <h3 id="actions-heading">{t('admin.pros.panel.actions')}</h3>
        <button
          type="button"
          className="abtn"
          disabled={action.busy}
          onClick={() =>
            void post('reinstate', undefined, (r) =>
              r.pro.status === 'approved' ? t('admin.pros.panel.reinstated') : t('admin.pros.panel.reinstatedPending'),
            )
          }
        >
          {t('admin.pros.panel.reinstate')}
        </button>
        <ErrorText error={action.error} />
      </section>
    );
  }

  return (
    <section className="stack" aria-labelledby="actions-heading">
      <h3 id="actions-heading">{t('admin.pros.panel.actions')}</h3>
      {mode === 'idle' && (
        <div className="row gap8 wrap">
          <button
            type="button"
            className="abtn ghost"
            disabled={action.busy}
            onClick={() => void post('watch-list', { on: !pro.watchListAt })}
          >
            {pro.watchListAt ? t('admin.pros.panel.watchOff') : t('admin.pros.panel.watchOn')}
          </button>
          <button type="button" className="abtn ghost" onClick={() => setMode('coaching')}>
            {t('admin.pros.panel.coaching')}
          </button>
          {pro.jobsPausedAt ? (
            <button type="button" className="abtn ghost" disabled={action.busy} onClick={() => void post('resume')}>
              {t('admin.pros.panel.resume')}
            </button>
          ) : (
            <button type="button" className="abtn ghost" disabled={action.busy} onClick={() => void post('pause')}>
              {t('admin.pros.panel.pause')}
            </button>
          )}
          <button type="button" className="abtn danger" onClick={() => setMode('suspend')}>
            {t('admin.pros.panel.suspend')}
          </button>
        </div>
      )}
      {mode === 'coaching' && (
        <form
          className="stack confirm"
          onSubmit={(event) => {
            event.preventDefault();
            const startsAt = zonedToIso(date, time, timezone);
            setInvalid(startsAt === null);
            if (startsAt) void post('coaching', { startsAt });
          }}
        >
          <div className="row gap8 wrap filters">
            <div className="af">
              <label htmlFor="coaching-date">{t('admin.pros.panel.coachingDate')}</label>
              <input id="coaching-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="af">
              <label htmlFor="coaching-time">{t('admin.pros.panel.coachingTime')}</label>
              <input id="coaching-time" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          {invalid && (
            <p className="error-text" role="alert">
              {t('admin.pros.panel.coachingInvalid')}
            </p>
          )}
          <div className="row gap8">
            <button type="button" className="abtn ghost" onClick={() => setMode('idle')}>
              {t('admin.pros.panel.cancel')}
            </button>
            <button type="submit" className="abtn" disabled={action.busy}>
              {t('admin.pros.panel.coachingSend')}
            </button>
          </div>
        </form>
      )}
      {mode === 'suspend' && (
        <NoteForm
          label={t('admin.pros.panel.suspendLabel')}
          submitLabel={t('admin.pros.panel.suspendSend')}
          danger
          busy={action.busy}
          onCancel={() => setMode('idle')}
          onSubmit={(reason) =>
            void post('suspend', { reason }, (r) =>
              r.handOver
                ? [
                    t('admin.pros.panel.handOver', { bookings: r.handOver.bookings, plans: r.handOver.plans }),
                    r.handOver.plansWithoutPro > 0 ? t('admin.pros.panel.handOverMissing', { count: r.handOver.plansWithoutPro }) : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                : '',
            )
          }
        />
      )}
      <ErrorText error={action.error} />
    </section>
  );
}

interface HandOver {
  bookings: number;
  plans: number;
  plansWithoutPro: number;
}

function LogLine({ entry }: { entry: ProActionEntry }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const docName = (kind?: string) => (kind ? t(`admin.pros.panel.check.${kind as 'id'}`) : '');
  const d = entry.details;
  const text = t(`admin.pros.panel.logAction.${entry.action}`, {
    document: docName(d.document),
    documents: (d.documents ?? []).map((k) => docName(k)).join(', '),
    note: d.note ?? '',
    message: d.message ?? '',
    reason: d.reason ?? '',
    date: d.at ? dateTime(d.at, timezone) : '',
  });
  return (
    <li>
      {text}
      <div className="small muted">
        {t('admin.pros.panel.logBy', { name: entry.adminName ?? t('admin.pros.panel.system'), date: dateTime(entry.createdAt, timezone) })}
      </div>
    </li>
  );
}

function ProDetails({ pro, notice, onChanged }: { pro: AdminProDetail; notice: string | null; onChanged: Changed }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const applying = pro.status === 'submitted' || pro.status === 'info_requested';
  const working = pro.status === 'approved' || pro.status === 'pending_approval' || pro.status === 'suspended';
  const reasonValue = { low_acceptance: pro.acceptancePct, late: pro.onTimePct, low_rating: pro.ratingAverage?.toFixed(1) };

  return (
    <>
      <div className="row between gap8">
        <div className="small muted">{pro.trades.join(', ')}</div>
        <span className={`badge ${pro.status === 'approved' ? 'g' : pro.status === 'suspended' ? 'r' : 'a'}`}>
          {t(`proStatus.${pro.status}`)}
        </span>
      </div>
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      {pro.status === 'suspended' && pro.suspendedAt && (
        <p className="note warn-note">
          {t('admin.pros.panel.suspendedNote', { date: longDate(pro.suspendedAt, timezone), reason: pro.suspendedReason ?? '' })}
        </p>
      )}
      {pro.jobsPausedAt && <p className="note warn-note">{t('admin.pros.panel.paused', { date: longDate(pro.jobsPausedAt, timezone) })}</p>}
      {pro.watchListAt && <p className="note">{t('admin.pros.panel.onWatch', { date: longDate(pro.watchListAt, timezone) })}</p>}
      {pro.coachingCallAt && (
        <p className="note">{t('admin.pros.panel.coachingBooked', { date: dateTime(pro.coachingCallAt, timezone) })}</p>
      )}

      {pro.qualityReasons.length > 0 && (
        <section className="quality" aria-labelledby="quality-heading">
          <h3 id="quality-heading">
            <Icon name="alert" /> {t('admin.pros.panel.quality')}
          </h3>
          <ul className="history">
            {pro.qualityReasons.map((reason) => (
              <li key={reason}>{t(`admin.pros.panel.qualityReason.${reason}`, { value: reasonValue[reason] ?? '' })}</li>
            ))}
          </ul>
        </section>
      )}

      {working && (
        <section className="stack" aria-labelledby="numbers-heading">
          <h3 id="numbers-heading">{t('admin.pros.panel.numbers')}</h3>
          <dl className="kv">
            <dt>{t('admin.pros.panel.rating')}</dt>
            <dd>
              {pro.ratingAverage === null
                ? t('admin.pros.panel.noRating')
                : t('admin.pros.panel.ratingValue', { average: pro.ratingAverage.toFixed(1), count: pro.ratingCount })}
            </dd>
            <dt>{t('admin.pros.panel.jobs30')}</dt>
            <dd>{pro.jobs30}</dd>
            <dt>{t('admin.pros.panel.acceptance')}</dt>
            <dd>
              <Pct value={pro.acceptancePct} low={LOW_ACCEPTANCE_PCT} />
            </dd>
            <dt>{t('admin.pros.panel.onTime')}</dt>
            <dd>
              <Pct value={pro.onTimePct} low={LOW_ON_TIME_PCT} />
            </dd>
            <dt>{t('admin.pros.panel.earned')}</dt>
            <dd>{euro(pro.earnedThisMonthCents)}</dd>
          </dl>
        </section>
      )}

      <section className="stack" aria-labelledby="details-heading">
        <h3 id="details-heading">{t('admin.pros.panel.details')}</h3>
        <dl className="kv">
          <dt>{t('admin.pros.panel.phone')}</dt>
          <dd>{pro.phone ? <a href={`tel:${pro.phone}`}>{pro.phone}</a> : '–'}</dd>
          {pro.email && (
            <>
              <dt>{t('admin.pros.panel.email')}</dt>
              <dd>
                <a href={`mailto:${pro.email}`}>{pro.email}</a>
              </dd>
            </>
          )}
          <dt>{t('admin.pros.panel.home')}</dt>
          <dd>{pro.homePostcode ? `${pro.homePostcode}${pro.postcodeName ? ` · ${pro.postcodeName}` : ''}` : '–'}</dd>
          <dt>{t('admin.pros.panel.travel')}</dt>
          <dd>{t('admin.pros.panel.travelKm', { km: pro.radiusKm })}</dd>
          <dt>{t('admin.pros.panel.days')}</dt>
          <dd>{pro.workingDays.map((day) => WEEKDAYS[day - 1]).join(', ') || '–'}</dd>
          {pro.submittedAt && (
            <>
              <dt>{t('admin.pros.panel.applied')}</dt>
              <dd>{longDate(pro.submittedAt, timezone)}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="stack" aria-labelledby="checks-heading">
        <h3 id="checks-heading">{applying ? t('admin.pros.panel.checks') : t('admin.pros.panel.documents')}</h3>
        <ul className="check-list">
          {pro.checks.map((check) => (
            <CheckItem
              key={`${check.kind}-${check.document?.uploadId ?? 'none'}-${check.state}`}
              pro={pro}
              check={check}
              onChanged={onChanged}
            />
          ))}
        </ul>
      </section>

      {applying && <Decision pro={pro} onChanged={onChanged} />}
      {working && <Actions pro={pro} onChanged={onChanged} />}

      {working && (
        <>
          <section className="stack" aria-labelledby="regulars-heading">
            <h3 id="regulars-heading">{t('admin.pros.panel.regulars')}</h3>
            {pro.regulars.length === 0 ? (
              <p className="small muted">{t('admin.pros.panel.noRegulars')}</p>
            ) : (
              <ul className="history">
                {pro.regulars.map((r) => (
                  <li key={r.id}>{t('admin.pros.panel.regularLine', { name: r.firstName ?? '', plan: r.planName })}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="stack" aria-labelledby="payouts-heading">
            <h3 id="payouts-heading">{t('admin.pros.panel.payouts')}</h3>
            <dl className="kv">
              <dt>{t('admin.pros.panel.bank')}</dt>
              <dd>
                {!pro.hasPayoutAccount
                  ? t('admin.pros.panel.noBank')
                  : pro.bank === null
                    ? t('admin.pros.panel.bankUnavailable')
                    : pro.bank.bankLast4
                      ? t('admin.pros.panel.bankLast4', { last4: pro.bank.bankLast4 })
                      : t('admin.pros.panel.noBank')}
              </dd>
              <dt>{t('admin.pros.panel.nextPayout')}</dt>
              <dd>
                {pro.bank?.nextPayout
                  ? t('admin.pros.panel.nextPayoutValue', {
                      amount: euro(pro.bank.nextPayout.amountCents),
                      date: longDate(pro.bank.nextPayout.arrivesOn, timezone),
                    })
                  : t('admin.pros.panel.noNextPayout')}
              </dd>
            </dl>
            {pro.payouts.length > 0 && (
              <>
                <h4 className="small b">{t('admin.pros.panel.recentPayouts')}</h4>
                <ul className="history small">
                  {pro.payouts.map((p, i) => (
                    <li key={i}>
                      {t('admin.pros.panel.payoutLine', {
                        amount: euro(p.amountCents),
                        source: t(`admin.pros.panel.payoutSource.${p.source}`),
                        status: t(`payoutStatus.${p.status as 'sent'}`, { defaultValue: p.status }),
                        date: longDate(p.createdAt, timezone),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="stack" aria-labelledby="reviews-heading">
            <h3 id="reviews-heading">{t('admin.pros.panel.reviews')}</h3>
            {pro.reviews.length === 0 ? (
              <p className="small muted">{t('admin.pros.panel.noReviews')}</p>
            ) : (
              <ul className="history">
                {pro.reviews.map((r, i) => (
                  <li key={i}>
                    {t('admin.pros.panel.reviewLine', { stars: r.stars, service: r.service, name: r.customerName ?? '' })}
                    <div className="small muted">{longDate(r.createdAt, timezone)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="stack" aria-labelledby="log-heading">
        <h3 id="log-heading">{t('admin.pros.panel.log')}</h3>
        {pro.actions.length === 0 ? (
          <p className="small muted">{t('admin.pros.panel.noLog')}</p>
        ) : (
          <ul className="history">
            {pro.actions.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function AdminProPanel({ proId, onClose, onChanged }: { proId: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ pro: AdminProDetail }>(`/admin/pros/${proId}`), [api, proId]);
  const { state, reload, update } = useResource(load);
  const [notice, setNotice] = useState<string | null>(null);
  const title = state.status === 'ready' ? fullName(state.data.pro) : t('admin.pros.panel.loading');

  const changed = useCallback<Changed>(
    (pro, message) => {
      update(() => ({ pro }));
      setNotice(message ?? null);
      onChanged();
    },
    [update, onChanged],
  );

  return (
    <Drawer title={title} closeLabel={t('admin.pros.panel.close')} onClose={onClose}>
      <ResourceState state={state} reload={reload}>
        {({ pro }) => <ProDetails pro={pro} notice={notice} onChanged={changed} />}
      </ResourceState>
    </Drawer>
  );
}
