import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { useAction } from '../lib/useAction';
import { ErrorText } from './ErrorText';
import { Icon } from './Icon';

/** Emails a new link to confirm the address. The answer is the same whether or not the account exists. */
export function ResendVerification({ email, className = 'btn btn-ghost' }: { email: string; className?: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const [sent, setSent] = useState(false);

  async function resend() {
    setSent(false);
    const ok = await run(() => api.post('/auth/verify-email/resend', { email: email.trim() }).then(() => true));
    setSent(Boolean(ok));
  }

  return (
    <div className="stack">
      {sent && (
        <p className="info" role="status">
          <Icon name="check" /> {t('verifyEmail.resent')}
        </p>
      )}
      <ErrorText error={error} />
      <button type="button" className={className} disabled={busy || !email.trim()} onClick={() => void resend()}>
        {busy ? t('common.sending') : t('verifyEmail.resend')}
      </button>
    </div>
  );
}
