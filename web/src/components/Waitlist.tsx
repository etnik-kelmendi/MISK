import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { ApiError } from '../api/client';
import { useAction } from '../lib/useAction';
import { ErrorText } from './ErrorText';

const POSTCODE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/;

/**
 * "Your postcode is not listed?" Puts the customer on the waitlist for it; they are told when MISK opens
 * there. Not a form of its own, because it sits inside the booking form.
 */
export function Waitlist() {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [postcode, setPostcode] = useState('');
  const [joined, setJoined] = useState<string | null>(null);
  const valid = POSTCODE_FORMAT.test(postcode.trim());
  const served = action.error instanceof ApiError && action.error.code === 'postcode_served';

  async function join() {
    if (!valid) return;
    const result = await action.run(() => api.post<{ postcode: string }>('/waitlist', { postcode: postcode.trim() }));
    if (result) setJoined(result.postcode);
  }

  if (joined) {
    return (
      <p className="info small" role="status">
        {t('waitlist.joined', { postcode: joined })}
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="link small" onClick={() => setOpen(true)}>
        {t('waitlist.notListed')}
      </button>
    );
  }
  return (
    <div className="stack tight">
      <div className="field">
        <label htmlFor="waitlist-postcode">{t('waitlist.postcode')}</label>
        <input
          id="waitlist-postcode"
          autoComplete="postal-code"
          maxLength={10}
          value={postcode}
          onChange={(e) => setPostcode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void join();
            }
          }}
        />
      </div>
      {served ? (
        <p className="small" role="status">
          {t('waitlist.served', { postcode: postcode.trim().toUpperCase() })}
        </p>
      ) : (
        <ErrorText error={action.error} />
      )}
      <button type="button" className="btn btn-ghost" disabled={!valid || action.busy} onClick={() => void join()}>
        {t('waitlist.join')}
      </button>
    </div>
  );
}
