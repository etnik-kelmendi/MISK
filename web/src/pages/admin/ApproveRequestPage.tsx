import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { Api } from '../../api/client';
import { errorKey } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';

interface Approved {
  email: string;
  firstName: string | null;
  lastName: string | null;
}

let linkToken: string | null = null;
const approvals = new Map<string, Promise<Approved>>();

/** Reads the token from the link's #fragment once, then removes it from the address bar and history. */
function readToken(): string {
  if (linkToken === null) {
    linkToken = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }
  return linkToken;
}

/** Sends each link to the API exactly once, however often the page renders. */
function approveOnce(api: Api, token: string): Promise<Approved> {
  let approval = approvals.get(token);
  if (!approval) {
    approval = api.post<{ admin: Approved }>('/auth/admin/approve', { token }).then((result) => result.admin);
    approvals.set(token, approval);
  }
  return approval;
}

/** For tests: forgets the link read from an earlier page. */
export function forgetApprovalLink() {
  linkToken = null;
  approvals.clear();
}

/**
 * Opened from the link in the email admins get about an account request. Opening it approves the
 * request at once (D22); the new admin can then sign in with their email.
 */
export function ApproveRequestPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [token] = useState(readToken);
  const [state, setState] = useState<{ status: 'working' } | { status: 'done'; admin: Approved } | { status: 'failed'; error: unknown }>(
    token ? { status: 'working' } : { status: 'failed', error: null },
  );

  useEffect(() => {
    if (!token) {
      return;
    }
    let current = true;
    approveOnce(api, token).then(
      (admin) => current && setState({ status: 'done', admin }),
      (error: unknown) => current && setState({ status: 'failed', error }),
    );
    return () => {
      current = false;
    };
  }, [api, token]);

  return (
    <main className="admin-login">
      <div className="panel stack">
        <div className="logo">
          <span className="logo-mark">
            <Icon name="leaf" />
          </span>
          <h1>{t('admin.approve.title')}</h1>
        </div>
        {state.status === 'working' && (
          <p className="muted" role="status">
            {t('admin.approve.working')}
          </p>
        )}
        {state.status === 'done' && (
          <p className="info" role="status">
            <Icon name="check" />{' '}
            {t('admin.approve.done', {
              name: [state.admin.firstName, state.admin.lastName].filter(Boolean).join(' '),
              email: state.admin.email,
            })}
          </p>
        )}
        {state.status === 'failed' && (
          <p className="error-text" role="alert">
            {state.error ? t(`errors.${errorKey(state.error)}`) : t('errors.invalid_approval_link')}
          </p>
        )}
        <Link to="/admin/settings/team">{t('admin.approve.toTeam')}</Link>
      </div>
    </main>
  );
}
