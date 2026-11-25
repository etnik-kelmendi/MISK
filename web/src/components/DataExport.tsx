import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { useMarket } from '../api/MarketContext';
import { useResource } from '../api/useResource';
import { dateTime } from '../lib/format';
import { useAction } from '../lib/useAction';
import { ErrorText } from './ErrorText';
import { Icon } from './Icon';

/** GET /account/data-export (D100). */
export interface DataExportStatus {
  /** The account's email address, masked; null without one. */
  email: string | null;
  pending: boolean;
  requestedAt: string | null;
  sentAt: string | null;
  nextAllowedAt: string | null;
}

/**
 * "Download my data" (D100), a row of a Terms list: asks MISK to email a copy of the person's own data to their email
 * address within 48 hours (one request a day). Without an email address it links to Personal information first.
 */
export function DataExportRow({ personalPath }: { personalPath: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ export: DataExportStatus }>('/account/data-export'), [api]);
  const { state, update } = useResource(load);
  const send = useAction();
  const status = state.status === 'ready' ? state.data.export : null;

  const row = (
    <>
      <span className="li" aria-hidden="true">
        <Icon name="download" />
      </span>
      <span className="grow">{t('legal.download')}</span>
    </>
  );

  let note: ReactNode = <span className="tiny muted block">{t('legal.downloadHint')}</span>;
  let action: ReactNode = null;
  if (status && !status.email) {
    note = (
      <span className="tiny muted block">
        {t('legal.downloadNoEmail')}{' '}
        <Link to={personalPath} className="brand-text b">
          {t('legal.downloadAddEmail')}
        </Link>
      </span>
    );
  } else if (status?.pending) {
    note = (
      <span className="small brand-text block" role="status">
        {t('legal.downloadPending', { email: status.email })}
      </span>
    );
  } else if (status?.nextAllowedAt) {
    note = (
      <span className="tiny muted block" role="status">
        {status.sentAt && `${t('legal.downloadSent', { email: status.email, date: dateTime(status.sentAt, timezone) })} `}
        {t('legal.downloadAgain', { date: dateTime(status.nextAllowedAt, timezone) })}
      </span>
    );
  } else if (status) {
    action = (
      <button
        type="button"
        className="mini-btn"
        disabled={send.busy}
        onClick={() =>
          void send.run(() => api.post<{ export: DataExportStatus }>('/account/data-export')).then((result) => {
            if (result) update(() => ({ export: result.export }));
          })
        }
      >
        {t('legal.downloadSend')}
      </button>
    );
  }

  return (
    <li className="data-export">
      <div className="lrow">
        {row}
        {action}
      </div>
      <div className="data-export-note">
        {note}
        <ErrorText error={send.error} />
      </div>
    </li>
  );
}
