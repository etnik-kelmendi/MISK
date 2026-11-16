import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import { useResource } from '../../api/useResource';
import { Drawer } from '../../components/Drawer';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, longDate } from '../../lib/format';
import { useAction } from '../../lib/useAction';

type UserType = 'customer' | 'pro';
type UserStatus = 'active' | 'suspended' | 'deleted';
const TYPES = ['all', 'customer', 'pro'] as const;
const STATUSES = ['all', 'active', 'suspended', 'deleted'] as const;
const SEARCH_DELAY_MS = 250;
/** Must match USERS_PAGE_SIZE in the API. */
const PAGE_SIZE = 50;
const REASON_MAX = 500;
const MESSAGE_MAX = 500;

export interface UserRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  types: UserType[];
  status: UserStatus;
  joinedAt: string;
  lastActive: string | null;
}

interface UserAction {
  id: string;
  action: 'messaged' | 'suspended' | 'reinstated' | 'deleted';
  details: { text?: string; reason?: string; cancelledBookings?: number; endedPlans?: number; bookings?: number; plans?: number };
  createdAt: string;
  adminName: string | null;
}

export interface UserDetail extends UserRow {
  emailConfirmed: boolean;
  hasPassword: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  bookings: { total: number; upcoming: number; completed: number; cancelled: number };
  activePlans: { id: string; name: string; status: string }[];
  pro: {
    status: string;
    ratingAverage: number | null;
    ratingCount: number;
    jobsDone: number;
    documents: { kind: 'id' | 'certificate' | 'insurance' | 'background'; ok: boolean; state: string; expiresOn: string | null }[];
  } | null;
  actions: UserAction[];
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T => list.some((item) => item === value);

export function fullName(user: Pick<UserRow, 'firstName' | 'lastName'>): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ');
}

function TypeBadges({ types }: { types: UserType[] }) {
  const { t } = useTranslation();
  if (types.length === 0) return <span className="muted small">{t('admin.users.type.none')}</span>;
  return (
    <span className="row gap4 wrap">
      {types.map((type) => (
        <span key={type} className={`badge ${type === 'pro' ? 'grey' : 'g'}`}>
          {t(`admin.users.type.${type}`)}
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ status }: { status: UserStatus }) {
  const { t } = useTranslation();
  return <span className={`badge ${status === 'active' ? 'g' : status === 'suspended' ? 'a' : 'r'}`}>{t(`admin.users.status.${status}`)}</span>;
}

/** A confirmation that needs a reason: Suspend and Delete. */
function ReasonForm({
  kind,
  busy,
  onCancel,
  onConfirm,
}: {
  kind: 'suspend' | 'delete';
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const missing = tried && !reason.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!reason.trim()) {
      document.getElementById(id)?.focus();
      return;
    }
    onConfirm(reason.trim());
  }

  return (
    <form role="alertdialog" aria-labelledby={`${id}-title`} className="stack confirm" onSubmit={submit} noValidate>
      <p id={`${id}-title`} className="b">
        {t(`admin.users.${kind}.title`)}
      </p>
      <p className="small">{t(`admin.users.${kind}.text`)}</p>
      <div className="af">
        <label htmlFor={id}>{t(`admin.users.${kind}.reason`)}</label>
        <textarea
          id={id}
          rows={3}
          maxLength={REASON_MAX}
          value={reason}
          aria-invalid={missing || undefined}
          aria-describedby={missing ? `${id}-error` : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        <FieldError id={id} message={missing ? t('admin.users.reasonMissing') : null} />
      </div>
      <div className="row gap8">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('admin.users.keep')}
        </button>
        <button type="submit" className="abtn danger" disabled={busy}>
          {t(`admin.users.${kind}.confirm`)}
        </button>
      </div>
    </form>
  );
}

function MessageForm({ busy, onCancel, onSend }: { busy: boolean; onCancel: () => void; onSend: (text: string) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const missing = tried && !text.trim();
  return (
    <form
      className="stack confirm"
      aria-label={t('admin.users.message.title')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (!text.trim()) {
          document.getElementById(id)?.focus();
          return;
        }
        onSend(text.trim());
      }}
    >
      <div className="af">
        <label htmlFor={id}>{t('admin.users.message.label')}</label>
        <textarea
          id={id}
          rows={4}
          maxLength={MESSAGE_MAX}
          value={text}
          aria-invalid={missing || undefined}
          aria-describedby={missing ? `${id}-error` : `${id}-hint`}
          onChange={(e) => setText(e.target.value)}
        />
        {missing ? (
          <FieldError id={id} message={t('admin.users.message.missing')} />
        ) : (
          <span id={`${id}-hint`} className="hint">
            {t('admin.users.message.hint')}
          </span>
        )}
      </div>
      <div className="row gap8">
        <button type="button" className="abtn ghost" onClick={onCancel}>
          {t('admin.users.keep')}
        </button>
        <button type="submit" className="abtn" disabled={busy}>
          {t('admin.users.message.send')}
        </button>
      </div>
    </form>
  );
}

function ActionLine({ entry }: { entry: UserAction }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const d = entry.details;
  const extra =
    entry.action === 'messaged'
      ? d.text
      : entry.action === 'suspended' || entry.action === 'deleted'
        ? t('admin.users.log.reasonLine', {
            reason: d.reason ?? '',
            bookings: d.cancelledBookings ?? 0,
            plans: d.endedPlans ?? 0,
          })
        : null;
  return (
    <li>
      {t(`admin.users.log.${entry.action}`)}
      {extra && <div className="small log-note">{extra}</div>}
      <div className="small muted">{t('admin.users.log.by', { name: entry.adminName ?? '–', date: dateTime(entry.createdAt, timezone) })}</div>
    </li>
  );
}

function UserDetails({ user, onChanged }: { user: UserDetail; onChanged: (user: UserDetail) => void }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const api = useApi();
  const action = useAction();
  const [mode, setMode] = useState<'idle' | 'message' | 'suspend' | 'delete'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const deleted = user.status === 'deleted';

  async function run(path: string, body: unknown, done: string) {
    const result = await action.run(() => api.post<{ user: UserDetail }>(`/admin/users/${user.id}/${path}`, body));
    if (result) {
      setMode('idle');
      setNotice(done);
      onChanged(result.user);
    }
  }

  return (
    <div className="stack">
      <div className="row between gap8 wrap">
        <TypeBadges types={user.types} />
        <StatusBadge status={user.status} />
      </div>
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      {user.status === 'suspended' && user.suspendedReason && (
        <p className="note warn-note">
          {t('admin.users.suspendedNote', { date: user.suspendedAt ? longDate(user.suspendedAt, timezone) : '', reason: user.suspendedReason })}
        </p>
      )}
      {deleted && (
        <p className="note warn-note">
          {t('admin.users.deletedNote', { date: user.deletedAt ? longDate(user.deletedAt, timezone) : '', reason: user.deletedReason ?? '' })}
        </p>
      )}

      <section className="stack" aria-label={t('admin.users.details')}>
        <h3>{t('admin.users.details')}</h3>
        <dl className="kv">
          <dt>{t('admin.users.col.email')}</dt>
          <dd>{user.email ? <a href={`mailto:${user.email}`}>{user.email}</a> : '–'}</dd>
          <dt>{t('admin.users.col.phone')}</dt>
          <dd>{user.phone ? <a href={`tel:${user.phone}`}>{user.phone}</a> : '–'}</dd>
          <dt>{t('admin.users.signIn')}</dt>
          <dd>{user.hasPassword ? t('admin.users.signInEmail') : user.phone ? t('admin.users.signInPhone') : '–'}</dd>
          <dt>{t('admin.users.col.joined')}</dt>
          <dd>{longDate(user.joinedAt, timezone)}</dd>
          <dt>{t('admin.users.col.lastActive')}</dt>
          <dd>{user.lastActive ? dateTime(user.lastActive, timezone) : t('admin.users.never')}</dd>
          <dt>{t('admin.users.bookings')}</dt>
          <dd>{t('admin.users.bookingsLine', user.bookings)}</dd>
          <dt>{t('admin.users.plans')}</dt>
          <dd>{user.activePlans.length ? user.activePlans.map((p) => p.name).join(', ') : t('admin.users.noPlans')}</dd>
        </dl>
      </section>

      {user.pro && (
        <section className="stack" aria-label={t('admin.users.asPro')}>
          <h3>{t('admin.users.asPro')}</h3>
          <dl className="kv">
            <dt>{t('admin.users.proStatus')}</dt>
            <dd>{t(`proStatus.${user.pro.status as 'approved'}`, { defaultValue: user.pro.status })}</dd>
            <dt>{t('admin.users.rating')}</dt>
            <dd>
              {user.pro.ratingAverage === null
                ? t('admin.users.noRating')
                : t('admin.users.ratingValue', { average: user.pro.ratingAverage.toFixed(1), count: user.pro.ratingCount })}
            </dd>
            <dt>{t('admin.users.jobsDone')}</dt>
            <dd>{user.pro.jobsDone}</dd>
          </dl>
          <ul className="check-list">
            {user.pro.documents.map((doc) => (
              <li key={doc.kind} className="row between gap8">
                <span>
                  <span className="b">{t(`admin.pros.panel.check.${doc.kind}`)}</span>
                  {doc.expiresOn && <span className="small muted"> · {t('admin.users.until', { date: longDate(doc.expiresOn, timezone) })}</span>}
                </span>
                <span className={`badge ${doc.ok ? 'g' : 'r'}`}>{doc.ok ? t('admin.pros.panel.ok') : t('admin.pros.panel.openCheck')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!deleted && mode === 'idle' && (
        <div className="row gap8 wrap">
          <button type="button" className="abtn" onClick={() => setMode('message')}>
            {t('admin.users.message.button')}
          </button>
          {user.status === 'suspended' ? (
            <button type="button" className="abtn ghost" disabled={action.busy} onClick={() => void run('reinstate', undefined, t('admin.users.reinstated'))}>
              {t('admin.users.reinstate')}
            </button>
          ) : (
            <button type="button" className="abtn ghost" aria-haspopup="dialog" onClick={() => setMode('suspend')}>
              {t('admin.users.suspend.button')}
            </button>
          )}
          <button type="button" className="abtn ghost danger-text" aria-haspopup="dialog" onClick={() => setMode('delete')}>
            {t('admin.users.delete.button')}
          </button>
        </div>
      )}
      {mode === 'message' && (
        <MessageForm busy={action.busy} onCancel={() => setMode('idle')} onSend={(text) => void run('message', { text }, t('admin.users.message.sent'))} />
      )}
      {(mode === 'suspend' || mode === 'delete') && (
        <ReasonForm
          kind={mode}
          busy={action.busy}
          onCancel={() => setMode('idle')}
          onConfirm={(reason) => void run(mode, { reason }, t(mode === 'suspend' ? 'admin.users.suspended' : 'admin.users.deleted'))}
        />
      )}
      <ErrorText error={action.error} />

      <section className="stack" aria-label={t('admin.users.log.title')}>
        <h3>{t('admin.users.log.title')}</h3>
        {user.actions.length === 0 ? (
          <p className="small muted">{t('admin.users.log.none')}</p>
        ) : (
          <ul className="history">
            {user.actions.map((entry) => (
              <ActionLine key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function UserPanel({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ user: UserDetail }>(`/admin/users/${userId}`), [api, userId]);
  const { state, reload, update } = useResource(load);
  const title = state.status === 'ready' ? fullName(state.data.user) || t('admin.users.closedAccount') : t('admin.users.loading');
  return (
    <Drawer title={title} closeLabel={t('admin.users.close')} onClose={onClose}>
      <ResourceState state={state} reload={reload}>
        {({ user }) => (
          <UserDetails
            user={user}
            onChanged={(next) => {
              update(() => ({ user: next }));
              onChanged();
            }}
          />
        )}
      </ResourceState>
    </Drawer>
  );
}

/** Admin → Users: every customer and pro in one place (D65). */
export function UsersPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const typeParam = params.get('type');
  const type = isOneOf(TYPES, typeParam) ? typeParam : 'all';
  const statusParam = params.get('status');
  const status = isOneOf(STATUSES, statusParam) ? statusParam : 'all';
  const open = params.get('open');
  const [typed, setTyped] = useState(q);
  const [more, setMore] = useState<UserRow[]>([]);
  const moreAction = useAction();
  const returnFocus = useRef<HTMLElement | null>(null);

  const change = useCallback(
    (next: Record<string, string>) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          for (const [key, value] of Object.entries(next)) {
            if (value && value !== 'all') updated.set(key, value);
            else updated.delete(key);
          }
          return updated;
        },
        { replace: true },
      ),
    [setParams],
  );

  useEffect(() => {
    const trimmed = typed.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => change({ q: trimmed }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, q, change]);

  const query = useCallback(
    (offset: number) => {
      const search = new URLSearchParams();
      if (q) search.set('q', q);
      if (type !== 'all') search.set('type', type);
      if (status !== 'all') search.set('status', status);
      if (offset) search.set('offset', String(offset));
      return api.get<{ users: UserRow[]; matching: number; total: number }>(`/admin/users?${search.toString()}`);
    },
    [api, q, type, status],
  );
  const load = useCallback(() => {
    setMore([]);
    return query(0);
  }, [query]);
  const { state, reload } = useResource(load);

  return (
    <>
      <h1>{t('admin.users.title')}</h1>
      <p className="muted small">{t('admin.users.intro')}</p>
      <div className="row gap8 wrap filters">
        <div className="af grow">
          <label htmlFor="users-search">{t('admin.users.search')}</label>
          <input id="users-search" type="search" value={typed} placeholder={t('admin.users.searchPlaceholder')} onChange={(e) => setTyped(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="users-type">{t('admin.users.typeFilter')}</label>
          <select id="users-type" value={type} onChange={(e) => change({ type: e.target.value })}>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`admin.users.typeOption.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="af">
          <label htmlFor="users-status">{t('admin.users.statusFilter')}</label>
          <select id="users-status" value={status} onChange={(e) => change({ status: e.target.value })}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`admin.users.statusOption.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ResourceState state={state} reload={reload}>
        {({ users, matching, total }) => {
          const rows = [...users, ...more];
          return (
            <>
              <p className="small muted" role="status">
                {t('admin.users.shown', { shown: rows.length, total })}
                {matching > rows.length && ` · ${t('admin.users.matching', { count: matching })}`}
              </p>
              {rows.length === 0 ? (
                <p className="panel muted">{t('admin.users.none')}</p>
              ) : (
                <div className="panel scroll-x">
                  <table className="t">
                    <thead>
                      <tr>
                        {(['name', 'email', 'phone', 'type', 'status', 'joined', 'lastActive'] as const).map((col) => (
                          <th key={col} scope="col">
                            {t(`admin.users.col.${col}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <button
                              type="button"
                              className="link b"
                              onClick={(event) => {
                                returnFocus.current = event.currentTarget;
                                change({ open: user.id });
                              }}
                            >
                              {fullName(user) || (user.status === 'deleted' ? t('admin.users.closedAccount') : t('admin.users.noName'))}
                            </button>
                          </td>
                          <td className="small">{user.email ?? '–'}</td>
                          <td className="small nowrap">{user.phone ?? '–'}</td>
                          <td>
                            <TypeBadges types={user.types} />
                          </td>
                          <td>
                            <StatusBadge status={user.status} />
                          </td>
                          <td className="small nowrap">{longDate(user.joinedAt, timezone)}</td>
                          <td className="small nowrap">{user.lastActive ? dateTime(user.lastActive, timezone) : t('admin.users.never')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {matching > rows.length && (
                <button
                  type="button"
                  className="abtn ghost"
                  disabled={moreAction.busy}
                  onClick={() => void moreAction.run(() => query(rows.length)).then((r) => r && setMore((m) => [...m, ...r.users]))}
                >
                  {t('admin.users.more', { count: Math.min(PAGE_SIZE, matching - rows.length) })}
                </button>
              )}
              <ErrorText error={moreAction.error} />
            </>
          );
        }}
      </ResourceState>
      {open && (
        <UserPanel
          userId={open}
          onClose={() => {
            change({ open: '' });
            returnFocus.current?.focus();
          }}
          onChanged={reload}
        />
      )}
    </>
  );
}
