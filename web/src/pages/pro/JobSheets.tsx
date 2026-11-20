import type { TFunction } from 'i18next';
import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import {
  ISSUE_REASONS,
  PRO_CANCEL_REASONS,
  type IssueReason,
  type PriceItem,
  type ProCancelReason,
  type ProJob,
} from '../../api/types';
import { useResource } from '../../api/useResource';
import { ChatNote, ChatView, type ChatEvent } from '../../chat/ChatView';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { Sheet } from '../../components/Sheet';
import { dateTime, euro } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { formatDuration } from '../customer/BookingPage';
import { closedText, statusEvents } from '../customer/ChatPage';

/** The pop-ups of the Job page (D86), kept in the address as ?sheet=… so a link can open one. */
export const JOB_SHEETS = ['chat', 'extra', 'issue', 'cancel'] as const;
export type JobSheet = (typeof JOB_SHEETS)[number];

/** The longest note for extra work, an issue and a cancellation, as the API takes them. */
export const EXTRA_NOTE_MAX = 300;
export const ISSUE_DETAILS_MAX = 500;
export const CANCEL_NOTE_MAX = 300;

/** The customer's first name, or "your customer" when it is not known. */
export function customerName(job: ProJob, t: TFunction): string {
  return job.customer.firstName ?? t('chat.yourCustomer');
}

/** Status changes and extra work requests, shown between the messages of the pro's chat. */
export function proChatEvents(job: ProJob, name: string, t: TFunction): ChatEvent[] {
  return [
    ...statusEvents(job, 'pro', name, t),
    ...job.extras.map((extra) => ({
      key: `x-${extra.id}`,
      at: extra.createdAt,
      node: (
        <ChatNote>
          {t('chat.extraAsked', { description: extra.description, price: euro(extra.priceCents) })} · {t(`extra.status.${extra.status}`)}
        </ChatNote>
      ),
    })),
  ];
}

/** "Chat with the customer" (D86): the same conversation the customer sees on their Chat page. */
export function ChatSheet({ job, onClose }: { job: ProJob; onClose: () => void }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const name = customerName(job, t);
  return (
    <Sheet title={name} closeLabel={t('common.close')} onClose={onClose} bodyClassName="flush">
      <ChatView
        inSheet
        side="pro"
        path={`/pro/jobs/${encodeURIComponent(job.id)}/messages`}
        otherName={name}
        closedText={closedText(job.status, t)}
        statusLine={t(`job.stage.${job.status}`)}
        subtitle={`${job.serviceName} · ${dateTime(job.startsAt, timezone)}`}
        events={proChatEvents(job, name, t)}
        quickReplies={[t('chat.quick.onMyWay'), t('chat.quick.arrived'), t('chat.quick.late'), t('chat.quick.done')]}
      />
    </Sheet>
  );
}

/**
 * "Add extra work" (D86): the pro picks an item of the MISK price list and sends it to the customer, who
 * approves it before anything is charged. The price is always the server's.
 */
export function ExtraWorkSheet({ job, onClose, onSent }: { job: ProJob; onClose: () => void; onSent: (job: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const name = customerName(job, t);
  const load = useCallback(() => api.get<{ items: PriceItem[] }>(`/pro/jobs/${encodeURIComponent(job.id)}/price-list`), [api, job.id]);
  const list = useResource(load);
  const [itemId, setItemId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { run, busy, error } = useAction();
  const waiting = job.extras.some((extra) => extra.status === 'pending' || extra.status === 'awaiting_payment');
  const form = useValidation({ item: itemId === null && t('proExtra.pickOne') }, { item: 'extra-item-first' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check() || itemId === null) return;
    const result = await run(() =>
      api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/extras`, { itemId, ...(note.trim() ? { note: note.trim() } : {}) }),
    );
    if (result) onSent(result.job);
  }

  return (
    <Sheet
      title={t('job.addExtra')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        !waiting && (
          <button type="submit" form="extra-form" className="cta dark" disabled={busy || list.state.status !== 'ready'}>
            {t('proExtra.send', { name })}
          </button>
        )
      }
    >
      {waiting ? (
        <p className="info amber" role="status">
          <Icon name="clock" /> <span>{t('proExtra.waitFirst', { name })}</span>
        </p>
      ) : (
        <form id="extra-form" className="stack" onSubmit={submit} noValidate>
          <p className="small muted">{t('proExtra.intro', { name })}</p>
          <ResourceState state={list.state} reload={list.reload}>
            {({ items }) =>
              items.length === 0 ? (
                <p className="small muted">{t('proExtra.empty')}</p>
              ) : (
                <fieldset className="opt-list" {...form.describe('item')}>
                  <legend className="visually-hidden">{t('proExtra.list')}</legend>
                  {items.map((item, index) => (
                    <label key={item.id} className={`opt center ${itemId === item.id ? 'on' : ''}`}>
                      <input
                        id={index === 0 ? 'extra-item-first' : undefined}
                        type="radio"
                        name="extra-item"
                        className="visually-hidden"
                        checked={itemId === item.id}
                        onChange={() => setItemId(item.id)}
                      />
                      <span className="radio" aria-hidden="true" />
                      <span className="grow">
                        <b>{item.name}</b>
                        <span className="os">{t('proExtra.takes', { duration: formatDuration(item.durationMinutes, t) })}</span>
                      </span>
                      <b>+{euro(item.priceCents)}</b>
                    </label>
                  ))}
                  <FieldError id="extra-item-first" message={form.message('item')} />
                </fieldset>
              )
            }
          </ResourceState>
          <div className="field">
            <label htmlFor="extra-note">{t('proExtra.note', { name })}</label>
            <input
              id="extra-note"
              maxLength={EXTRA_NOTE_MAX}
              placeholder={t('proExtra.notePlaceholder')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {job.proSharePct !== undefined && (
            <p className="info">
              <Icon name="tag" /> <span>{t('proExtra.share', { pct: job.proSharePct })}</span>
            </p>
          )}
          <ErrorText error={error} />
        </form>
      )}
    </Sheet>
  );
}

/** "Report an issue" (D86): a problem on site, sent to MISK support. */
export function IssueSheet({ job, onClose, onSent }: { job: ProJob; onClose: () => void; onSent: (job: ProJob) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const name = customerName(job, t);
  const [reason, setReason] = useState<IssueReason | null>(null);
  const [details, setDetails] = useState('');
  const { run, busy, error } = useAction();
  const form = useValidation(
    {
      reason: reason === null && t('issue.reasonMissing'),
      details: reason === 'other' && !details.trim() && t('issue.detailsMissing'),
    },
    { reason: `issue-${ISSUE_REASONS[0]}`, details: 'issue-details' },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check() || reason === null) return;
    const result = await run(() =>
      api.post<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(job.id)}/issue`, {
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
      }),
    );
    if (result) onSent(result.job);
  }

  return (
    <Sheet
      title={t('issue.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <button type="submit" form="issue-form" className="cta dark" disabled={busy}>
          {t('issue.send')}
        </button>
      }
    >
      <form id="issue-form" className="stack" onSubmit={submit} noValidate>
        <fieldset className="opt-list" {...form.describe('reason')}>
          <legend className="visually-hidden">{t('issue.reasonsLabel')}</legend>
          {ISSUE_REASONS.map((value) => (
            <label key={value} className={`opt ${reason === value ? 'on' : ''}`}>
              <input
                id={`issue-${value}`}
                type="radio"
                name="issue-reason"
                className="visually-hidden"
                checked={reason === value}
                onChange={() => setReason(value)}
              />
              <span className="radio" aria-hidden="true" />
              <span className="grow b">
                {t(`issue.reasons.${value}`)}
                <span className="os">{t(`issue.hints.${value}`, { name })}</span>
              </span>
            </label>
          ))}
          <FieldError id={`issue-${ISSUE_REASONS[0]}`} message={form.message('reason')} />
        </fieldset>
        <div className="field">
          <label htmlFor="issue-details">{reason === 'other' ? t('issue.detailsRequired') : t('issue.details')}</label>
          <textarea
            id="issue-details"
            rows={3}
            maxLength={ISSUE_DETAILS_MAX}
            placeholder={t('issue.detailsPlaceholder')}
            value={details}
            {...form.describe('details')}
            onChange={(event) => setDetails(event.target.value)}
          />
          <FieldError id="issue-details" message={form.message('details')} />
        </div>
        <ErrorText error={error} />
      </form>
    </Sheet>
  );
}

/**
 * "Cancel job" (D86): the rules first, then a required reason. The job goes back to other pros and the
 * customer is told; the page shows what happened.
 */
export function CancelJobSheet({
  job,
  onClose,
  onCancelled,
}: {
  job: ProJob;
  onClose: () => void;
  onCancelled: (result: { reason: ProCancelReason; late: boolean }) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const name = customerName(job, t);
  const [reason, setReason] = useState<ProCancelReason | null>(null);
  const [note, setNote] = useState('');
  const { run, busy, error } = useAction();
  const form = useValidation(
    {
      reason: reason === null && t('proCancel.reasonMissing'),
      note: reason === 'other' && !note.trim() && t('proCancel.noteMissing'),
    },
    { reason: `cancel-${PRO_CANCEL_REASONS[0]}`, note: 'cancel-note' },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check() || reason === null) return;
    const result = await run(() =>
      api.post<{ cancelled: { reason: ProCancelReason; late: boolean } }>(`/pro/jobs/${encodeURIComponent(job.id)}/cancel`, {
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
    if (result) onCancelled(result.cancelled);
  }

  return (
    <Sheet
      title={t('proCancel.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="cta ghost" onClick={onClose}>
            {t('proCancel.keep')}
          </button>
          <button type="submit" form="cancel-form" className="cta red" disabled={busy}>
            {t('proCancel.confirm')}
          </button>
        </>
      }
    >
      <form id="cancel-form" className="stack" onSubmit={submit} noValidate>
        <p className="info amber">
          <Icon name="bell" />
          <span>{t('proCancel.lead', { name })}</span>
        </p>
        <ul className="stack small">
          <li className="row gap8">
            <Icon name="clock" /> <span>{t('proCancel.early')}</span>
          </li>
          <li className="row gap8">
            <Icon name="alert" /> <span>{t('proCancel.late')}</span>
          </li>
        </ul>
        {job.cancelIsLate && (
          <p className="info red" role="status">
            <Icon name="alert" /> <span>{t('proCancel.nowLate')}</span>
          </p>
        )}
        <fieldset {...form.describe('reason')}>
          <legend className="h-sm">{t('proCancel.reason')}</legend>
          <div className="chips">
            {PRO_CANCEL_REASONS.map((value) => (
              <label key={value} className={`chip dark ${reason === value ? 'on' : ''}`}>
                <input
                  id={`cancel-${value}`}
                  type="radio"
                  name="cancel-reason"
                  className="visually-hidden"
                  checked={reason === value}
                  onChange={() => setReason(value)}
                />
                {t(`proCancel.reasons.${value}`)}
              </label>
            ))}
          </div>
          <FieldError id={`cancel-${PRO_CANCEL_REASONS[0]}`} message={form.message('reason')} />
        </fieldset>
        <div className="field">
          <label htmlFor="cancel-note">{reason === 'other' ? t('proCancel.note') : t('proCancel.noteOptional')}</label>
          <textarea
            id="cancel-note"
            rows={2}
            maxLength={CANCEL_NOTE_MAX}
            value={note}
            {...form.describe('note')}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldError id="cancel-note" message={form.message('note')} />
        </div>
        <ErrorText error={error} />
      </form>
    </Sheet>
  );
}
