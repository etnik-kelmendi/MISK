import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import {
  ADMIN_ROLES,
  type ActivityEntry,
  type AdminAccount,
  type AdminArea,
  type AdminRole,
  type Channel,
  type MessageKind,
  type TeamMember,
} from '../../api/types';
import { useResource } from '../../api/useResource';
import { useUser } from '../../auth/AuthContext';
import { ErrorText } from '../../components/ErrorText';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { useSave } from './settings/SaveStatus';

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

function EmailForm({ admin, onSaved, onCancel }: { admin: AdminAccount; onSaved: (a: AdminAccount) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const [email, setEmail] = useState(admin.email ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.patch<{ admin: AdminAccount }>(`/admin/team/${admin.id}`, { email: email.trim() || null }));
    if (result) {
      onSaved(result.admin);
    }
  }

  return (
    <form className="fgrid service-form" onSubmit={submit}>
      <div className="af full">
        <label htmlFor={`email-${admin.id}`}>{t('admin.team.email')}</label>
        <input id={`email-${admin.id}`} type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        <span className="hint">{t('admin.team.emailHint')}</span>
      </div>
      <div className="row gap8 full">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="abtn" disabled={busy}>
          {t('admin.team.saveEmail')}
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

function PendingRequests({ admins, onDone }: { admins: AdminAccount[]; onDone: (notice: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  if (admins.length === 0) {
    return null;
  }

  async function decide(admin: AdminAccount, decision: 'approve' | 'decline') {
    const done = await run(() => api.post(`/admin/team/${admin.id}/${decision}`).then(() => true));
    if (done) {
      onDone(t(`admin.team.requests.${decision}d`, { name: admin.email ?? admin.username }));
    }
  }

  return (
    <section className="panel" aria-labelledby="requests-heading">
      <h2 id="requests-heading">{t('admin.team.requests.title', { count: admins.length })}</h2>
      <p className="small muted">{t('admin.team.requests.intro')}</p>
      <ul className="history">
        {admins.map((admin) => (
          <li key={admin.id} className="row between wrap">
            <span>
              <span className="b">{[admin.firstName, admin.lastName].filter(Boolean).join(' ')}</span>
              <span className="small muted block">{admin.email}</span>
            </span>
            <span className="row gap8">
              <button type="button" className="abtn ghost" disabled={busy} onClick={() => void decide(admin, 'decline')}>
                {t('admin.team.requests.decline')}
              </button>
              <button type="button" className="abtn" disabled={busy} onClick={() => void decide(admin, 'approve')}>
                {t('admin.team.requests.approve')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </section>
  );
}

function name(member: { firstName: string | null; lastName: string | null; username: string }) {
  return [member.firstName, member.lastName].filter(Boolean).join(' ') || member.username;
}

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function InviteForm({ onSent, onCancel }: { onSent: (email: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [role, setRole] = useState<AdminRole>('support');
  const valid = EMAIL_FORMAT.test(email.trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const result = await track(() =>
      api.post<{ member: TeamMember }>('/admin/team/invite', {
        email: email.trim(),
        role,
        ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
      }),
    );
    if (result) onSent(email.trim());
  }

  return (
    <form className="panel stack" onSubmit={submit} noValidate aria-labelledby="invite-heading">
      <h2 id="invite-heading">{t('admin.settings.team.inviteTitle')}</h2>
      <div className="row gap8 wrap filters">
        <div className="af grow">
          <label htmlFor="invite-email">{t('admin.settings.team.inviteEmail')}</label>
          <input id="invite-email" type="email" autoComplete="off" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="invite-name">{t('admin.settings.team.inviteName')}</label>
          <input id="invite-name" maxLength={60} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="invite-role">{t('admin.settings.team.inviteRole')}</label>
          <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
            {ADMIN_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`admin.settings.team.roles.${r}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row gap8">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('admin.settings.team.cancel')}
        </button>
        <button type="submit" className="abtn" disabled={!valid}>
          {t('admin.settings.team.inviteSend')}
        </button>
      </div>
    </form>
  );
}

function AccessList({ role, access }: { role: AdminRole; access: Record<AdminRole, AdminArea[]> }) {
  const { t } = useTranslation();
  if (role === 'admin') return <span className="small">{t('admin.settings.team.everything')}</span>;
  return <span className="small">{(access[role] ?? []).map((a) => t(`admin.settings.team.areas.${a}`)).join(', ')}</span>;
}

function Members({ onNotice }: { onNotice: (notice: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const me = useUser();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ members: TeamMember[]; access: Record<AdminRole, AdminArea[]> }>('/admin/team/members'), [api]);
  const { state, reload } = useResource(load);
  const [inviting, setInviting] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [editingEmail, setEditingEmail] = useState<string | null>(null);

  async function changeRole(member: TeamMember, role: AdminRole) {
    const result = await track(() => api.patch(`/admin/team/${member.id}/role`, { role }));
    if (result) reload();
  }

  return (
    <>
      <section className="panel stack" aria-labelledby="members-heading">
        <div className="row between wrap gap8">
          <h2 id="members-heading">{t('admin.settings.team.members')}</h2>
          <button type="button" className="abtn" onClick={() => setInviting(true)}>
            {t('admin.settings.team.invite')}
          </button>
        </div>
        <ResourceState state={state} reload={reload}>
          {({ members, access }) => (
            <div className="scroll-x">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.settings.team.name')}</th>
                    <th scope="col">{t('admin.settings.team.role')}</th>
                    <th scope="col">{t('admin.settings.team.access')}</th>
                    <th scope="col">{t('admin.settings.team.lastActive')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('admin.team.setPassword')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members
                    .filter((m) => !m.pending)
                    .map((member) => (
                      <tr key={member.id}>
                        <td>
                          <span className="b">{name(member)}</span> {member.id === me.id && <span className="badge g">{t('admin.team.you')}</span>}{' '}
                          {member.invitedAt && !member.lastActive && <span className="badge a">{t('admin.settings.team.invited')}</span>}
                          <div className="small muted">{member.email ?? member.username}</div>
                        </td>
                        <td>
                          <select
                            aria-label={t('admin.settings.team.roleLabel', { name: name(member) })}
                            value={member.role}
                            onChange={(e) => void changeRole(member, e.target.value as AdminRole)}
                          >
                            {ADMIN_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {t(`admin.settings.team.roles.${r}`)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <AccessList role={member.role} access={access} />
                        </td>
                        <td className="small">{member.lastActive ? dateTime(member.lastActive, timezone) : t('admin.settings.team.never')}</td>
                        <td>
                          {resetting === member.id ? (
                            <ResetForm
                              admin={member}
                              onCancel={() => setResetting(null)}
                              onDone={() => {
                                setResetting(null);
                                onNotice(t('admin.team.changed', { name: member.username }));
                              }}
                            />
                          ) : editingEmail === member.id ? (
                            <EmailForm
                              admin={member}
                              onCancel={() => setEditingEmail(null)}
                              onSaved={(saved) => {
                                setEditingEmail(null);
                                onNotice(t('admin.team.emailSaved', { name: saved.username }));
                                reload();
                              }}
                            />
                          ) : (
                            <span className="row gap8 wrap">
                              <button type="button" className="abtn ghost" onClick={() => setEditingEmail(member.id)}>
                                {t('admin.team.editEmail')}
                              </button>
                              <button type="button" className="abtn ghost" onClick={() => setResetting(member.id)}>
                                {t('admin.team.setPassword')}
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </ResourceState>
      </section>
      {inviting && (
        <InviteForm
          onCancel={() => setInviting(false)}
          onSent={(email) => {
            setInviting(false);
            onNotice(t('admin.settings.team.inviteSent', { email }));
            reload();
          }}
        />
      )}
    </>
  );
}

function Requests({ onNotice }: { onNotice: (notice: string) => void }) {
  const api = useApi();
  const load = useCallback(() => api.get<{ admins: AdminAccount[] }>('/admin/team'), [api]);
  const { state, reload } = useResource(load);
  if (state.status !== 'ready') return null;
  return (
    <PendingRequests
      admins={state.data.admins.filter((admin) => admin.pending)}
      onDone={(message) => {
        onNotice(message);
        reload();
      }}
    />
  );
}

const KNOWN_ACTIONS = [
  'service_fee',
  'commission',
  'payout_interval',
  'zone_added',
  'zone_edited',
  'zone_live',
  'zone_paused',
  'channel_on',
  'channel_off',
  'test_sent',
  'invited',
  'role_changed',
] as const;
type KnownAction = (typeof KNOWN_ACTIONS)[number];

function ActivityLine({ entry }: { entry: ActivityEntry }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const d = entry.details as Record<string, string | number | undefined>;
  const known = KNOWN_ACTIONS.find((a) => a === entry.action) as KnownAction | undefined;
  const asMoney = (value: unknown) => (typeof value === 'number' ? euro(value) : '');
  const text = known
    ? t(`admin.settings.team.action.${known}`, {
        from: known === 'service_fee' ? asMoney(d.from) : String(d.from ?? ''),
        to: known === 'service_fee' ? asMoney(d.to) : String(d.to ?? ''),
        code: String(d.code ?? ''),
        channel: d.channel ? t(`admin.settings.notifications.${d.channel as Channel}`) : '',
        message: d.message ? t(`admin.settings.notifications.kind.${d.message as MessageKind}`) : '',
        email: String(d.email ?? ''),
        role: d.role ? t(`admin.settings.team.roles.${d.role as AdminRole}`) : '',
      })
    : [entry.subject, entry.action.replace(/_/g, ' ')].filter(Boolean).join(': ');
  return (
    <li>
      <span className="badge grey">{t(`admin.settings.team.area.${entry.area as 'fees'}`, { defaultValue: entry.area })}</span> {text}
      <div className="small muted">
        {t('admin.settings.team.by', { name: entry.adminFullName || entry.adminName || '–', date: dateTime(entry.createdAt, timezone) })}
      </div>
    </li>
  );
}

/** Every change across the control panel: who, what and when, newest first. */
const ACTIVITY_PAGE = 100;

function ActivityLog() {
  const { t } = useTranslation();
  const api = useApi();
  const [older, setOlder] = useState<ActivityEntry[]>([]);
  const more = useAction();
  const load = useCallback(() => api.get<{ activity: ActivityEntry[] }>('/admin/activity'), [api]);
  const { state, reload } = useResource(load);

  return (
    <section className="panel stack" aria-labelledby="activity-heading">
      <h2 id="activity-heading">{t('admin.settings.team.activity')}</h2>
      <p className="small muted">{t('admin.settings.team.activityIntro')}</p>
      <ResourceState state={state} reload={reload}>
        {({ activity }) => {
          const all = [...activity, ...older];
          const last = all.at(-1);
          return all.length === 0 ? (
            <p className="small muted">{t('admin.settings.team.noActivity')}</p>
          ) : (
            <>
              <ul className="history">
                {all.map((entry) => (
                  <ActivityLine key={entry.id} entry={entry} />
                ))}
              </ul>
              {all.length % ACTIVITY_PAGE === 0 && last && (
                <button
                  type="button"
                  className="abtn ghost"
                  disabled={more.busy}
                  onClick={() =>
                    void more
                      .run(() => api.get<{ activity: ActivityEntry[] }>(`/admin/activity?before=${encodeURIComponent(last.createdAt)}`))
                      .then((r) => r && setOlder((o) => [...o, ...r.activity]))
                  }
                >
                  {t('admin.settings.team.older')}
                </button>
              )}
              <ErrorText error={more.error} />
            </>
          );
        }}
      </ResourceState>
    </section>
  );
}

/** Settings → Team & access. */
export function TeamPage() {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="stack">
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      <Requests onNotice={setNotice} />
      <Members onNotice={setNotice} />
      <ActivityLog />
    </div>
  );
}
