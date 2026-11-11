import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useApi } from '../api/ApiContext';
import type { User } from '../api/types';
import { useAuth, useUser } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { PushToggle } from '../components/PushToggle';
import { useAction } from '../lib/useAction';
import { useValidation } from '../lib/useValidation';
import { FieldError } from '../components/FieldError';
import { AppHeader } from '../shells/Shells';

/** Name and sign-out, shared by the customer and pro apps. */
export function AccountPage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const { setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [saved, setSaved] = useState(false);
  const { run, busy, error } = useAction();
  const form = useValidation({ firstName: !firstName.trim() && t('validation.firstNameMissing') }, { firstName: 'account-name' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (!form.check()) {
      return;
    }
    const result = await run(() => api.patch<{ user: User }>('/account', { firstName: firstName.trim() }));
    if (result) {
      setUser(result.user);
      setSaved(true);
    }
  }

  return (
    <>
      <AppHeader title={t('account.title')} />
      <div className="body">
        <form className="card stack" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="account-name">{t('signIn.firstName')}</label>
            <input
              id="account-name"
              required
              maxLength={60}
              autoComplete="given-name"
              value={firstName}
              {...form.describe('firstName')}
              onChange={(event) => setFirstName(event.target.value)}
            />
            <FieldError id="account-name" message={form.message('firstName')} />
          </div>
          <p className="small muted">{t('account.phone', { phone: user.phone ?? '' })}</p>
          <ErrorText error={error} />
          {saved && (
            <p className="small brand-text" role="status">
              {t('common.saved')}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('common.save')}
          </button>
        </form>
        <div className="card">
          <PushToggle />
        </div>
        <button type="button" className="btn btn-ghost wide" onClick={() => void logout().then(() => navigate('/signin'))}>
          <Icon name="logout" /> {t('common.signOut')}
        </button>
      </div>
    </>
  );
}
