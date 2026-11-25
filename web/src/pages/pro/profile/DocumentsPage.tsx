import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import { useMarket } from '../../../api/MarketContext';
import { useResource } from '../../../api/useResource';
import { ErrorText } from '../../../components/ErrorText';
import { Icon, type IconKey } from '../../../components/Icon';
import { DOCUMENT_TYPES, FileButton } from '../../../components/Photos';
import { ResourceState } from '../../../components/ResourceState';
import { longDate } from '../../../lib/format';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';
import { PRO_PROFILE_PATHS, type DocumentStatus, type ProDocumentView } from './types';

/** Today in the market, "YYYY-MM-DD". */
function marketToday(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const BADGE: Record<DocumentStatus, string> = { valid: 'g', expiring: 'a', checking: 'b', expired: 'r', missing: 'grey' };
const ICON: Record<DocumentStatus, IconKey> = { valid: 'check', expiring: 'shield', checking: 'clock', expired: 'alert', missing: 'upload' };

/**
 * One document: its name, status (Valid, Expiring soon in orange, Being checked, Expired) and date, and "Upload new".
 * A document that runs out asks for the date printed on the new copy first.
 */
function DocumentCard({ doc, onUploaded }: { doc: ProDocumentView; onUploaded: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const upload = useAction();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const dateId = `doc-date-${doc.kind}`;
  const datePassed = doc.expires && date !== '' && date < marketToday(timezone);
  const dateText = doc.expiresOn ? longDate(doc.expiresOn, timezone) : null;
  const line = (() => {
    switch (doc.status) {
      case 'checking':
        return dateText ? t('docs.line.checkingUntil', { date: dateText }) : t('docs.line.checking');
      case 'expired':
        return t('docs.line.expired', { date: dateText ?? '' });
      case 'missing':
        return t('docs.line.missing');
      default:
        return dateText ? t('docs.line.validUntil', { date: dateText }) : t('docs.line.noExpiry');
    }
  })();

  async function send(file: File) {
    const query = doc.expires ? `?expiresOn=${encodeURIComponent(date)}` : '';
    const result = await upload.run(() => api.upload<unknown>(`/pro/documents/${doc.kind}${query}`, file));
    if (result) {
      setOpen(false);
      setDate('');
      onUploaded();
    }
  }

  return (
    <li className={`doc doc-${doc.status}`}>
      <span className="di" aria-hidden="true">
        <Icon name={ICON[doc.status]} />
      </span>
      <span className="grow stack tight">
        <span className="b small block">{t(`apply.doc.${doc.kind}`)}</span>
        <span className={`tiny ${doc.status === 'expired' ? 'error-text' : 'muted'}`}>{line}</span>
        {doc.notAccepted && <span className="tiny error-text">{t('docs.notAccepted', { note: doc.reviewNote ?? '' })}</span>}
      </span>
      <span className="doc-side">
        <span className={`badge ${BADGE[doc.status]}`}>{t(`docs.status.${doc.status}`)}</span>
        {doc.status !== 'checking' &&
          (doc.expires ? (
            <button type="button" className="mini-btn" aria-expanded={open} aria-controls={`${dateId}-form`} onClick={() => setOpen(!open)}>
              <Icon name="upload" /> {t('docs.uploadNew')}
              <span className="visually-hidden"> {t(`apply.doc.${doc.kind}`)}</span>
            </button>
          ) : (
            <FileButton label={t('docs.uploadNew')} target={t(`apply.doc.${doc.kind}`)} accept={DOCUMENT_TYPES} onFile={send} />
          ))}
      </span>
      {open && doc.expires && (
        <div id={`${dateId}-form`} className="doc-upload stack tight">
          <div className="field compact">
            <label htmlFor={dateId} className="tiny">
              {t('apply.expiresOn')}
            </label>
            <input
              id={dateId}
              type="date"
              value={date}
              aria-invalid={datePassed || undefined}
              aria-describedby={`${dateId}-hint${datePassed ? ` ${dateId}-passed` : ''}`}
              onChange={(event) => {
                setDate(event.target.value);
                upload.clearError();
              }}
            />
            <span id={`${dateId}-hint`} className="tiny muted">
              {t('apply.expiresOnHint')}
            </span>
            {datePassed && (
              <span id={`${dateId}-passed`} role="alert" className="tiny error-text">
                {t('apply.expiredDate')}
              </span>
            )}
          </div>
          <FileButton
            label={t('docs.chooseFile')}
            target={t(`apply.doc.${doc.kind}`)}
            accept={DOCUMENT_TYPES}
            disabled={!date || datePassed}
            onFile={send}
          />
        </div>
      )}
      {upload.error !== null && upload.error !== undefined && (
        <div className="doc-upload">
          <ErrorText error={upload.error} />
        </div>
      )}
    </li>
  );
}

/**
 * Documents (D100): each document with its status and date and "Upload new". A new copy is "Being checked" until
 * MISK accepts it; an accepted older copy keeps covering the pro meanwhile. Reminders go 30 and 7 days before a
 * document runs out.
 */
export function DocumentsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ documents: ProDocumentView[] }>('/pro/documents'), [api]);
  const { state, reload } = useResource(load);
  return (
    <>
      <AppHeader title={t('proProfile.documents')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ documents }) => (
            <ul className="plain-list" aria-label={t('proProfile.documents')}>
              {documents.map((doc) => (
                <DocumentCard key={doc.kind} doc={doc} onUploaded={reload} />
              ))}
            </ul>
          )}
        </ResourceState>
        <div className="info amber">
          <Icon name="bell" />
          <p>{t('docs.rule')}</p>
        </div>
        <p className="tiny muted">{t('docs.reminders')}</p>
      </div>
    </>
  );
}
