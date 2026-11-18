import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { useAction } from '../lib/useAction';
import { ErrorText } from './ErrorText';
import { Icon } from './Icon';

/**
 * Shown under a postcode MISK does not serve yet: the customer joins the waiting list for it and is told
 * when MISK opens there. Not a form of its own, because it sits inside the booking form. Give it a `key`
 * of the postcode so a new postcode starts fresh.
 */
export function Waitlist({ postcode }: { postcode: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [joined, setJoined] = useState<string | null>(null);

  async function join() {
    const result = await action.run(() => api.post<{ postcode: string }>('/waitlist', { postcode }));
    if (result) setJoined(result.postcode);
  }

  return (
    <div className="info amber waitlist-panel" role="status">
      <Icon name="bell" />
      <span className="stack tight grow">
        {joined ? (
          <span>{t('waitlist.joined', { postcode: joined })}</span>
        ) : (
          <>
            <b>{t('waitlist.unavailableTitle')}</b>
            <span>{t('waitlist.unavailableText')}</span>
            <ErrorText error={action.error} />
            <button type="button" className="btn btn-ghost" disabled={action.busy} onClick={() => void join()}>
              {t('waitlist.join')}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
