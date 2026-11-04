import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { AdminAccount } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useUser } from '../../auth/AuthContext';
import { ErrorText } from '../../components/ErrorText';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';

export const MIN_PASSWORD_LENGTH = 12;

function PasswordFields({ id, value, onChange }: { id: string; value: { first: string; second: string }; onChange: (v: { first: string; second: string }) => void }) {
  const { t } = useTranslation();
  const mismatch = value.second.length > 0 && value.first !== value.second;
  return (
    <>
      <div className="af">
        <label htmlFor={`${id}-password`}>{t('admin.team.password')}</label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={value.first}
          onChange={(e) => onChange({ ...value, first: e.target.value })}
        />
        <span className="hint">{t('admin.team.passwordHint', { min: MIN_PASSWORD_LENGTH })}</span>
      </div>
      <div className="af">
        <label htmlFor={`${id}-repeat`}>{t('admin.team.repeat')}</label>
        <input
          id={`${id}-repeat`}
          type="password"
          autoComplete="new-password"
          required
          value={value.second}
          onChange={(e) => onChange({ ...value, second: e.target.value })}
        />
        {mismatch && <span className="error-text">{t('admin.team.mismatch')}</span>}
      </div>
    </>
  );
}

const valid = (p: { first: string; second: string }) => p.first.length >= MIN_PASSWORD_LENGTH && p.first === p.second;
const empty = { first: '', second: '' };

function ResetForm({ admin, onDone, onCancel }: { admin: AdminAccount; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const me = useUser();
  const { run, busy, error } = useAction();
  const [password, setPassword] = useState(empty);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const done = await run(() => api.post(`/admin/team/${admin.id}/password`, { password: password.first }).then(() => true));
    if (done) {
      onDone();
    }
  }

  return (
    <form className="fgrid service-form" onSubmit={submit} aria-label={t('admin.team.resetFor', { name: admin.username })}>
      <PasswordFields id={`reset-${admin.id}`} value={password} onChange={setPassword} />
      <p className="small muted full">{admin.id === me.id ? t('admin.team.resetOwn') : t('admin.team.resetOther')}</p>
      <div className="row gap8 full">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="abtn" disabled={busy || !valid(password)}>
          {t('admin.team.setPassword')}
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function AddAdminForm({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(empty);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const created = await run(() => api.post('/admin/team', { username, password: password.first }));
    if (created) {
      setUsername('');
      setPassword(empty);
      onAdded();
    }
  }

  return (
    <form className="panel fgrid" onSubmit={submit} aria-labelledby="add-admin">
      <h2 id="add-admin" className="full">
        {t('admin.team.add')}
      </h2>
      <div className="af full">
        <label htmlFor="new-admin-username">{t('admin.login.username')}</label>
        <input
          id="new-admin-username"
          autoComplete="off"
          required
          minLength={3}
          maxLength={254}
          pattern="\S+"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <PasswordFields id="new-admin" value={password} onChange={setPassword} />
      <p className="small muted full">{t('admin.team.shareSafely')}</p>
      <button type="submit" className="abtn" disabled={busy || !valid(password) || username.trim().length < 3}>
        {t('admin.team.addButton')}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

export function TeamPage() {
  const { t } = useTranslation();
  const api = useApi();
  const me = useUser();
  const load = useCallback(() => api.get<{ admins: AdminAccount[] }>('/admin/team'), [api]);
  const { state, reload } = useResource(load);
  const [resetting, setResetting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <h1>{t('admin.team.title')}</h1>
      <p className="muted small">{t('admin.team.intro')}</p>
      {notice && (
        <p className="info" role="status">
          {notice}
        </p>
      )}
      <ResourceState state={state} reload={reload}>
        {({ admins }) => (
          <section className="panel" aria-labelledby="admins-heading">
            <h2 id="admins-heading">{t('admin.team.admins')}</h2>
            <ul className="history">
              {admins.map((admin) => (
                <li key={admin.id} className="stack">
                  <div className="row between">
                    <span>
                      <span className="b">{admin.username}</span> {admin.id === me.id && <span className="badge g">{t('admin.team.you')}</span>}
                    </span>
                    {resetting !== admin.id && (
                      <button
                        type="button"
                        className="abtn ghost"
                        onClick={() => {
                          setNotice(null);
                          setResetting(admin.id);
                        }}
                      >
                        {t('admin.team.setPassword')}
                      </button>
                    )}
                  </div>
                  {resetting === admin.id && (
                    <ResetForm
                      admin={admin}
                      onCancel={() => setResetting(null)}
                      onDone={() => {
                        setResetting(null);
                        setNotice(t('admin.team.changed', { name: admin.username }));
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </ResourceState>
      <AddAdminForm
        onAdded={() => {
          setNotice(t('admin.team.added'));
          reload();
        }}
      />
    </>
  );
}
