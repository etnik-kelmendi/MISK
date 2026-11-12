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
import { Icon } from '../../components/Icon';
import { useSave } from './settings/SaveStatus';

export const MIN_PASSWORD_LENGTH = 12;
/** Must match INVITE_LINK_DAYS in the API. */
const INVITE_LINK_DAYS = 7;

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

/** Up to two initials for the avatar: "Elion Thaqi" → "ET", "sam@misk.app" → "S". */
export function initials(text: string): string {
  const words = text.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** A teammate counts as online when they used the control panel in the last few minutes. */
const ONLINE_MINUTES = 5;

/** "Invite teammate": makes a link for a role that the admin copies and sends however they like. */
function InviteLink({ onClose, onMade }: { onClose: () => void; onMade: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const [role, setRole] = useState<AdminRole>('support');
  const [made, setMade] = useState<{ link: string; role: AdminRole } | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCopied(null);
    const result = await track(() => api.post<{ invite: { role: AdminRole }; link: string }>('/admin/team/invites', { role }));
    if (result) {
      setMade({ link: result.link, role: result.invite.role });
      onMade();
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('yes');
    } catch {
      // Clipboard access can be refused; the link is selected so it can be copied by hand.
      document.getElementById('invite-link')?.focus();
      setCopied('no');
    }
  }

  return (
    <section className="panel stack" aria-labelledby="invite-heading">
      <h2 id="invite-heading">{t('admin.settings.team.inviteTitle')}</h2>
      {made ? (
        <>
          <p className="small">{t('admin.settings.team.linkReady', { role: t(`admin.settings.team.roles.${made.role}`) })}</p>
          <div className="row gap8 wrap">
            <input
              id="invite-link"
              className="link-box grow"
              readOnly
              value={made.link}
              aria-label={t('admin.settings.team.linkLabel')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="abtn" onClick={() => void copy(made.link)}>
              <Icon name="copy" /> {t('admin.settings.team.copy')}
            </button>
          </div>
          <p className="small muted" role="status">
            {copied === 'yes'
              ? t('admin.settings.team.copied')
              : copied === 'no'
                ? t('admin.settings.team.copyByHand')
                : t('admin.settings.team.linkRules', { days: INVITE_LINK_DAYS })}
          </p>
          <div className="row gap8">
            <button type="button" className="abtn ghost" onClick={() => setMade(null)}>
              {t('admin.settings.team.another')}
            </button>
            <button type="button" className="abtn ghost" onClick={onClose}>
              {t('admin.settings.team.done')}
            </button>
          </div>
        </>
      ) : (
        <form className="row gap8 wrap filters" onSubmit={(e) => void create(e)} aria-label={t('admin.settings.team.inviteTitle')}>
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
          <button type="button" className="abtn ghost" onClick={onClose}>
            {t('admin.settings.team.cancel')}
          </button>
          <button type="submit" className="abtn">
            {t('admin.settings.team.createLink')}
          </button>
        </form>
      )}
    </section>
  );
}

interface OpenInvite {
  id: string;
  role: AdminRole;
  createdAt: string;
  expiresAt: string;
  createdBy: string | null;
}

/** Links that can still be used, so an admin can withdraw one that went to the wrong person. */
function OpenInvites({ version }: { version: number }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const { timezone } = useMarket();
  // version changes when a new link is made, which loads the list again.
  const load = useCallback(() => api.get<{ invites: OpenInvite[] }>('/admin/team/invites').then((r) => ({ ...r, version })), [api, version]);
  const { state, reload } = useResource(load);
  if (state.status !== 'ready' || state.data.invites.length === 0) return null;

  async function withdraw(id: string) {
    const result = await track(() => api.delete(`/admin/team/invites/${id}`).then(() => true));
    if (result) reload();
  }

  return (
    <section className="panel stack" aria-labelledby="open-invites-heading">
      <h2 id="open-invites-heading">{t('admin.settings.team.openInvites')}</h2>
      <ul className="logrows">
        {state.data.invites.map((invite) => (
          <li key={invite.id} className="logrow">
            <span className="lt">
              {t('admin.settings.team.openInvite', {
                role: t(`admin.settings.team.roles.${invite.role}`),
                by: invite.createdBy ?? '–',
                until: dateTime(invite.expiresAt, timezone),
              })}
            </span>
            <button
              type="button"
              className="abtn ghost sm"
              aria-label={t('admin.settings.team.withdrawLabel', { role: t(`admin.settings.team.roles.${invite.role}`) })}
              onClick={() => void withdraw(invite.id)}
            >
              {t('admin.settings.team.withdraw')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AccessList({ role, access }: { role: AdminRole; access: Record<AdminRole, AdminArea[]> }) {
  const { t } = useTranslation();
  if (role === 'admin') return <span className="small">{t('admin.settings.team.everything')}</span>;
  return <span className="small">{(access[role] ?? []).map((a) => t(`admin.settings.team.areas.${a}`)).join(', ')}</span>;
}

function Members() {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const me = useUser();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ members: TeamMember[]; access: Record<AdminRole, AdminArea[]> }>('/admin/team/members'), [api]);
  const { state, reload } = useResource(load);
  const [inviting, setInviting] = useState(false);
  const [invites, setInvites] = useState(0);
  // Read once when the page opens, so "Online now" does not change on its own while rendering.
  const [now] = useState(() => Date.now());

  async function changeRole(member: TeamMember, role: AdminRole) {
    const result = await track(() => api.patch(`/admin/team/${member.id}/role`, { role }));
    if (result) reload();
  }

  return (
    <>
      <section className="panel stack" aria-labelledby="members-heading">
        <div className="panel-title">
          <h2 id="members-heading">{t('admin.settings.team.members')}</h2>
          <button type="button" className="abtn" onClick={() => setInviting(true)}>
            <Icon name="plus" /> {t('admin.settings.team.invite')}
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
                  </tr>
                </thead>
                <tbody>
                  {members
                    .filter((m) => !m.pending)
                    .map((member) => (
                      <tr key={member.id}>
                        <td>
                          <div className="who">
                            <span className="av" aria-hidden="true">
                              {initials(name(member))}
                            </span>
                            <div>
                              <span className="b">{name(member)}</span>{' '}
                              {member.id === me.id && <span className="badge g">{t('admin.team.you')}</span>}{' '}
                              {member.invitedAt && !member.lastActive && <span className="badge a">{t('admin.settings.team.invited')}</span>}
                              <div className="small muted">{member.email ?? member.username}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <select
                            className={`role ${member.role === 'admin' ? 'admin' : 'other'}`}
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
                        <td className="small muted nowrap">
                          {!member.lastActive
                            ? t('admin.settings.team.never')
                            : now - new Date(member.lastActive).getTime() < ONLINE_MINUTES * 60_000
                              ? t('admin.settings.team.online')
                              : dateTime(member.lastActive, timezone)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </ResourceState>
      </section>
      {inviting && <InviteLink onClose={() => setInviting(false)} onMade={() => setInvites((n) => n + 1)} />}
      <OpenInvites version={invites} />
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
  'trade_removed',
  'account_created',
  'password_reset',
  'email_changed',
  'request_approved',
  'request_approved_by_link',
  'request_declined',
  'invite_link_created',
  'invite_link_revoked',
  'joined_by_invite',
] as const;
type KnownAction = (typeof KNOWN_ACTIONS)[number];

function ActivityLine({ entry, now }: { entry: ActivityEntry; now: number }) {
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
        name: String(d.name ?? ''),
      })
    : [entry.subject, entry.action.replace(/_/g, ' ')].filter(Boolean).join(': ');
  const who = entry.adminFullName || entry.adminName || t('admin.settings.team.system');
  const recent = now - new Date(entry.createdAt).getTime() < RECENT_HOURS * 3_600_000;
  return (
    <li className={recent ? 'logrow new' : 'logrow'}>
      <span className="ld" aria-hidden="true" />
      <span className="lt">
        <span className="b">{who}</span>: {text}{' '}
        <span className="badge grey">{t(`admin.settings.team.area.${entry.area as 'fees'}`, { defaultValue: entry.area })}</span>
      </span>
      <time className="tiny muted lw" dateTime={entry.createdAt}>
        {dateTime(entry.createdAt, timezone)}
      </time>
    </li>
  );
}

/** Every change across the control panel: who, what and when, newest first. */
const ACTIVITY_PAGE = 100;
/** Lines from the last day get the green dot. */
const RECENT_HOURS = 24;

function ActivityLog() {
  const { t } = useTranslation();
  const api = useApi();
  const [older, setOlder] = useState<ActivityEntry[]>([]);
  const [now] = useState(() => Date.now());
  const more = useAction();
  const load = useCallback(() => api.get<{ activity: ActivityEntry[] }>('/admin/activity'), [api]);
  const { state, reload } = useResource(load);

  return (
    <section className="panel stack" aria-labelledby="activity-heading">
      <div className="panel-title">
        <h2 id="activity-heading">{t('admin.settings.team.activity')}</h2>
        <span className="small muted">{t('admin.settings.team.activityIntro')}</span>
      </div>
      <ResourceState state={state} reload={reload}>
        {({ activity }) => {
          const all = [...activity, ...older];
          const last = all.at(-1);
          return all.length === 0 ? (
            <p className="small muted">{t('admin.settings.team.noActivity')}</p>
          ) : (
            <>
              <ul className="logrows">
                {all.map((entry) => (
                  <ActivityLine key={entry.id} entry={entry} now={now} />
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
      <Members />
      <ActivityLog />
    </div>
  );
}
