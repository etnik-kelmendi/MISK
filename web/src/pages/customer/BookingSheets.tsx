import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { CustomerBooking, Receipt } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { IMAGE_TYPES, MAX_FILE_BYTES } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { Sheet } from '../../components/Sheet';
import { dateTime, euro } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';

/** Photos a customer can add to a problem report, as the API allows. */
export const MAX_PROBLEM_PHOTOS = 5;
/** What a customer picks first in a problem report; it starts the note MISK support reads. */
export const PROBLEM_TYPES = ['not_finished', 'poor_quality', 'damage', 'no_show', 'wrong_price', 'other'] as const;
type ProblemType = (typeof PROBLEM_TYPES)[number];
/** The note the API takes is at most 1000 characters, including the problem type in front. */
const PROBLEM_TEXT_MAX = 900;

/** The booking the report or receipt is about, as both the list and the booking page know it. */
export interface SheetBooking {
  id: string;
  serviceName: string;
  startsAt: string;
  proName: string | null;
}

/**
 * Report a problem (D67): what went wrong, more detail and photos. Within 24 hours of the job this puts the
 * payment on hold until MISK support has looked at it.
 */
export function ReportSheet({
  booking,
  onClose,
  onReported,
}: {
  booking: SheetBooking;
  onClose: () => void;
  onReported: (booking: CustomerBooking) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [type, setType] = useState<ProblemType | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [tooBig, setTooBig] = useState(false);
  /** The booking once the report is in, while photos are still being sent. */
  const [reported, setReported] = useState<CustomerBooking | null>(null);
  const { run, busy, error } = useAction();
  const trimmed = text.trim();
  const form = useValidation(
    {
      type: type === null && t('validation.problemTypeMissing'),
      note:
        type === 'other' && !trimmed
          ? t('validation.problemMissing')
          : trimmed.length > 0 && trimmed.length < 3 && t('validation.noteShort', { min: 3 }),
      // At least one photo is needed so support can see the problem; a resend after a failed upload has sent them already.
      photos: !reported && files.length === 0 && t('validation.problemPhotosMissing'),
    },
    { type: `problem-type-${PROBLEM_TYPES[0]}`, note: 'problem-note', photos: 'problem-photos' },
  );

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    // Files over 8 MB are left out here, so nobody waits for an upload the API would refuse.
    setTooBig(picked.some((file) => file.size > MAX_FILE_BYTES));
    setFiles((current) => [...current, ...picked.filter((file) => file.size <= MAX_FILE_BYTES)].slice(0, MAX_PROBLEM_PHOTOS));
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!form.check() || type === null) return;
    const label = t(`problem.types.${type}`);
    const note = trimmed ? `${label}: ${trimmed}` : label;
    const result = await run(async () => {
      // Sending again after a failed photo only sends the photos still waiting: the report itself is in.
      let latest = reported ?? (await api.post<{ booking: CustomerBooking }>(`/bookings/${booking.id}/problem`, { note })).booking;
      setReported(latest);
      const waiting = [...files];
      while (waiting.length > 0) {
        const [file] = waiting;
        if (!file) break;
        latest = (await api.upload<{ booking: CustomerBooking }>(`/bookings/${booking.id}/problem/photos`, file)).booking;
        waiting.shift();
        setFiles([...waiting]);
      }
      return latest;
    });
    if (result) onReported(result);
  }

  const name = booking.proName ?? t('problem.yourPro');
  return (
    <Sheet
      title={t('problem.open')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        // aria-disabled rather than disabled while no photo is chosen, so a tap still shows why it cannot be sent.
        <button
          type="submit"
          form="problem-form"
          className="cta red"
          disabled={busy}
          aria-disabled={!reported && files.length === 0 ? true : undefined}
        >
          {t('problem.send')}
        </button>
      }
    >
      <form id="problem-form" className="stack" onSubmit={submit} noValidate>
        <p className="small muted">
          {[booking.serviceName, dateTime(booking.startsAt, timezone), booking.proName].filter(Boolean).join(' · ')}
        </p>
        <fieldset {...form.describe('type')}>
          <legend className="h-sm">{t('problem.title')}</legend>
          <div className="chips">
            {PROBLEM_TYPES.map((value) => (
              <label key={value} className={`chip ${type === value ? 'on' : ''}`}>
                <input
                  id={`problem-type-${value}`}
                  type="radio"
                  name="problem-type"
                  className="visually-hidden"
                  checked={type === value}
                  onChange={() => setType(value)}
                />
                {t(`problem.types.${value}`)}
              </label>
            ))}
          </div>
          <FieldError id={`problem-type-${PROBLEM_TYPES[0]}`} message={form.message('type')} />
        </fieldset>
        <div className="field">
          <label htmlFor="problem-note" className="h-sm">
            {t('problem.note')}
          </label>
          <textarea
            id="problem-note"
            rows={3}
            maxLength={PROBLEM_TEXT_MAX}
            placeholder={t('problem.notePlaceholder')}
            value={text}
            {...form.describe('note')}
            onChange={(e) => setText(e.target.value)}
          />
          <FieldError id="problem-note" message={form.message('note')} />
        </div>
        <div className="stack">
          <span className="h-sm">{t('problem.photos', { max: MAX_PROBLEM_PHOTOS })}</span>
          {files.length > 0 && (
            <ul className="stack" aria-label={t('problem.chosen')}>
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="row between gap8 small">
                  <span className="grow">{file.name}</span>
                  <button
                    type="button"
                    className="link"
                    aria-label={t('problem.removePhoto', { name: file.name })}
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  >
                    {t('problem.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {files.length < MAX_PROBLEM_PHOTOS && (
            <span className="file-button">
              <input
                id="problem-photos"
                type="file"
                accept={IMAGE_TYPES}
                multiple
                className="visually-hidden"
                onChange={choose}
                disabled={busy}
                {...form.describe('photos')}
              />
              <label htmlFor="problem-photos" className="mini-btn">
                <Icon name="camera" /> {t('problem.addPhotos')}
              </label>
            </span>
          )}
          {/* "Send report" is in the footer, away from the photos, so this one is announced and highlighted (D107). */}
          <FieldError id="problem-photos" message={form.message('photos')} alert />
          {tooBig && (
            <span className="error-text" role="alert">
              {t('errors.file_too_large')}
            </span>
          )}
        </div>
        <p className="info">
          <Icon name="shield" />
          <span>{t('problem.hint', { name })}</span>
        </p>
        <ErrorText error={error} />
      </form>
    </Sheet>
  );
}

const STATE_BADGE: Record<Receipt['state'], string> = {
  paid: 'g',
  charging: 'a',
  on_hold: 'r',
  refunded: 'grey',
  released: 'grey',
  unpaid: 'grey',
};

/** The receipt of a finished booking (D67), with a PDF download and a copy by email. */
export function ReceiptSheet({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ receipt: Receipt }>(`/bookings/${encodeURIComponent(bookingId)}/receipt`), [api, bookingId]);
  const { state, reload } = useResource(load);
  const email = useAction();
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function sendEmail() {
    setSentTo(null);
    const result = await email.run(() => api.post<{ sentTo: string }>(`/bookings/${encodeURIComponent(bookingId)}/receipt/email`));
    if (result) setSentTo(result.sentTo);
  }

  const ready = state.status === 'ready';
  return (
    <Sheet
      title={t('receipt.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      footer={
        ready && (
          <>
            <button type="button" className="cta ghost" disabled={email.busy} onClick={() => void sendEmail()}>
              {t('receipt.email')}
            </button>
            <a className="cta" href={`${api.baseUrl}/bookings/${encodeURIComponent(bookingId)}/receipt.pdf`} download>
              <Icon name="download" /> {t('receipt.pdf')}
            </a>
          </>
        )
      }
    >
      <ResourceState state={state} reload={reload}>
        {({ receipt }) => {
          // A package lists each service (D68).
          const jobLines = receipt.lines.filter((line) => line.kind === 'job').length;
          return (
          <div className="stack">
            <section className="card" aria-label={t('receipt.title')}>
              <div className="row between">
                <div>
                  <p className="b">{t('receipt.brand')}</p>
                  <p className="tiny muted">{t('receipt.number', { number: receipt.number })}</p>
                </div>
                <span className={`badge ${STATE_BADGE[receipt.state]}`}>{t(`receipt.state.${receipt.state}`)}</span>
              </div>
              <p className="tiny muted receipt-meta">
                {[dateTime(receipt.date, timezone), receipt.proName, receipt.address].filter(Boolean).join(' · ')}
              </p>
              <div className="receipt-rule" />
              {receipt.lines.map((line, index) => (
                <p key={index} className="line">
                  <span className={line.kind === 'fee' || line.kind === 'tip' ? 'muted' : undefined}>
                    {line.kind === 'job'
                      ? jobLines > 1
                        ? line.label
                        : receipt.serviceName
                      : line.kind === 'extra'
                        ? line.label
                        : t(`receipt.kind.${line.kind}`)}
                  </span>
                  <span>{euro(line.cents)}</span>
                </p>
              ))}
              <p className="line total">
                <span>{t('book.total')}</span>
                <span>{euro(receipt.totalCents)}</span>
              </p>
              {receipt.paymentMethod && (
                <p className="line">
                  <span className="muted">{t('receipt.paymentMethod')}</span>
                  <span>{receipt.paymentMethod.label}</span>
                </p>
              )}
              <p className="tiny muted">{t('receipt.vat')}</p>
            </section>
            {(receipt.state === 'charging' || receipt.state === 'on_hold') && (
              <p className="info">
                <Icon name="clock" />
                <span>
                  {receipt.state === 'on_hold'
                    ? t('receipt.onHold')
                    : receipt.chargeAt
                      ? t('receipt.chargeAt', { date: dateTime(receipt.chargeAt, timezone) })
                      : t('receipt.charging')}
                </span>
              </p>
            )}
            {sentTo && (
              <p className="info" role="status">
                <Icon name="check" />
                <span>{t('receipt.sent', { email: sentTo })}</span>
              </p>
            )}
            <ErrorText error={email.error} />
          </div>
          );
        }}
      </ResourceState>
    </Sheet>
  );
}
