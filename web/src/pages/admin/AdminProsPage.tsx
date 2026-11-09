import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import { PRO_TABS, type AdminProListItem, type AdminProSummary, type ProTab } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { longDate } from '../../lib/format';
import { usePolling } from '../../lib/usePolling';
import { AdminProPanel } from './AdminProPanel';
import { fullName, LOW_ACCEPTANCE_PCT, LOW_ON_TIME_PCT, Pct } from './proFormat';

/** The page refreshes itself this often, so new applications and status changes show up. */
const REFRESH_MS = 30_000;
const SEARCH_DELAY_MS = 250;
const UUID = /^[0-9a-f-]{36}$/i;

function isTab(value: string | null): value is ProTab {
  return PRO_TABS.some((tab) => tab === value);
}

/** Copies the invite link; when the browser refuses, shows the link so it can be copied by hand. */
function InviteButton({ url }: { url: string | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch (error) {
      console.warn('Clipboard not available', error);
      setState('failed');
    }
  }

  return (
    <div className="stack tight">
      <button type="button" className="abtn" disabled={!url} onClick={() => void copy()}>
        <Icon name="copy" /> {t('admin.pros.invite')}
      </button>
      {state === 'copied' && (
        <p className="small ok" role="status">
          {t('admin.pros.inviteCopied')}
        </p>
      )}
      {state === 'failed' && url && (
        <div className="af" role="status">
          <label htmlFor="invite-link">{t('admin.pros.inviteFailed')}</label>
          <input id="invite-link" className="invite-link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </div>
  );
}

function NameButton({ pro, onOpen }: { pro: AdminProListItem; onOpen: (id: string, from: HTMLElement) => void }) {
  const { t } = useTranslation();
  const name = fullName(pro);
  return (
    <span className="name-cell">
      <button type="button" className="link b" aria-label={t('admin.pros.open', { name })} onClick={(e) => onOpen(pro.id, e.currentTarget)}>
        {name}
      </button>
      {pro.qualityReasons.length > 0 && (
        <span className="flag warn">
          <Icon name="alert" label={t('admin.pros.qualityIcon')} />
        </span>
      )}
      {pro.expiringDocument && (
        <span className="flag exp">
          <Icon name="clock" label={t('admin.pros.expiringIcon')} />
        </span>
      )}
    </span>
  );
}

const COLUMNS = {
  applications: ['name', 'trade', 'applied', 'checks'],
  active: ['name', 'trade', 'jobs', 'acceptance', 'onTime', 'regulars', 'status'],
  pending_approval: ['name', 'trade', 'documents'],
  suspended: ['name', 'trade', 'reason', 'since'],
} as const;
type Column = (typeof COLUMNS)[ProTab][number];

function ProTable({ tab, pros, onOpen }: { tab: ProTab; pros: AdminProListItem[]; onOpen: (id: string, from: HTMLElement) => void }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();

  function cell(pro: AdminProListItem, col: Column) {
    switch (col) {
      case 'name':
        return (
          <span className="row gap8 wrap">
            <NameButton pro={pro} onOpen={onOpen} />
            {tab === 'applications' && pro.ready && <span className="badge g">{t('admin.pros.ready')}</span>}
            {pro.status === 'info_requested' && <span className="badge a">{t('admin.pros.infoRequested')}</span>}
          </span>
        );
      case 'trade':
        return pro.trades.join(', ') || '–';
      case 'applied':
        return pro.submittedAt ? longDate(pro.submittedAt, timezone) : '–';
      case 'checks':
        return t('admin.pros.checksDone', { done: pro.checksDone, total: pro.checksTotal });
      case 'jobs':
        return pro.jobs30;
      case 'acceptance':
        return <Pct value={pro.acceptancePct} low={LOW_ACCEPTANCE_PCT} />;
      case 'onTime':
        return <Pct value={pro.onTimePct} low={LOW_ON_TIME_PCT} />;
      case 'regulars':
        return pro.regularCustomers;
      case 'status':
        return (
          <span className="row gap8 wrap">
            {pro.jobsPaused ? (
              <span className="badge r">{t('admin.pros.statusPaused')}</span>
            ) : (
              <span className="badge g">{t('admin.pros.statusActive')}</span>
            )}
            {pro.watchList && <span className="badge a">{t('admin.pros.statusWatch')}</span>}
          </span>
        );
      case 'documents':
        return (
          <span className="stack tight">
            {pro.expiredDocument && <span className="low">{t('admin.pros.expired')}</span>}
            {pro.waitingDocuments > 0 && <span>{t('admin.pros.waiting', { count: pro.waitingDocuments })}</span>}
          </span>
        );
      case 'reason':
        return pro.suspendedReason ?? '–';
      case 'since':
        return pro.suspendedAt ? longDate(pro.suspendedAt, timezone) : '–';
    }
  }

  return (
    <div className="panel scroll-x">
      <table className="t">
        <thead>
          <tr>
            {COLUMNS[tab].map((col) => (
              <th key={col} scope="col">
                {t(`admin.pros.col.${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pros.map((pro) => (
            <tr key={pro.id} className={pro.qualityReasons.length > 0 ? 'hl' : undefined}>
              {COLUMNS[tab].map((col) => (
                <td key={col}>{cell(pro, col)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminProsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: ProTab = isTab(tabParam) ? tabParam : 'applications';
  const q = params.get('q') ?? '';
  const openParam = params.get('open');
  const open = openParam && UUID.test(openParam) ? openParam : null;
  const [typed, setTyped] = useState(q);
  const returnFocus = useRef<HTMLElement | null>(null);

  const change = useCallback(
    (next: Record<string, string>) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          for (const [key, value] of Object.entries(next)) {
            if (value) updated.set(key, value);
            else updated.delete(key);
          }
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Search as the admin types, without a request per key press.
  useEffect(() => {
    const trimmed = typed.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => change({ q: trimmed }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, q, change]);

  const loadSummary = useCallback(() => api.get<AdminProSummary>('/admin/pros/summary'), [api]);
  const { state: summaryState, reload: reloadSummary } = useResource(loadSummary);
  const loadList = useCallback(() => {
    const search = new URLSearchParams({ tab });
    if (q) search.set('q', q);
    return api.get<{ pros: AdminProListItem[] }>(`/admin/pros?${search.toString()}`);
  }, [api, tab, q]);
  const { state: listState, reload: reloadList } = useResource(loadList);
  const reloadAll = useCallback(() => {
    reloadSummary();
    reloadList();
  }, [reloadSummary, reloadList]);
  usePolling(reloadAll, REFRESH_MS);

  const openPro = (id: string, from: HTMLElement) => {
    returnFocus.current = from;
    change({ open: id });
  };
  const close = useCallback(() => {
    change({ open: '' });
    returnFocus.current?.focus();
  }, [change]);

  const data = summaryState.status === 'ready' ? summaryState.data : null;
  const pct = (value: number | null) => (value === null ? t('admin.pros.none') : t('admin.pros.pct', { value }));
  const kpis = [
    { key: 'active', value: data?.kpis.activePros, hint: null, alert: false },
    { key: 'online', value: data?.kpis.onlineNow, hint: null, alert: false },
    { key: 'acceptance', value: data ? pct(data.kpis.avgAcceptancePct) : undefined, hint: t('admin.pros.kpi.acceptanceHint'), alert: false },
    {
      key: 'expiring',
      value: data?.kpis.documentsExpiring,
      hint: t('admin.pros.kpi.expiringHint'),
      alert: (data?.kpis.documentsExpiring ?? 0) > 0,
    },
  ] as const;

  return (
    <>
      <div className="row between wrap gap8">
        <h1>{t('admin.pros.title')}</h1>
        <InviteButton url={data?.inviteUrl ?? null} />
      </div>

      <section className="kpis pros-kpis" aria-label={t('admin.pros.title')}>
        {kpis.map((kpi) => (
          <div key={kpi.key} className="kpi">
            <div className="kl">{t(`admin.pros.kpi.${kpi.key}`)}</div>
            <div className={`kv2 ${kpi.alert ? 'low' : ''}`}>{kpi.value ?? '…'}</div>
            {kpi.hint && <div className="kd muted">{kpi.hint}</div>}
          </div>
        ))}
      </section>

      <div className="seg wrap" role="group" aria-label={t('admin.pros.tabsLabel')}>
        {PRO_TABS.map((key) => (
          <button
            key={key}
            type="button"
            className={key === tab ? 'on' : ''}
            aria-pressed={key === tab}
            onClick={() => change({ tab: key === 'applications' ? '' : key })}
          >
            {t('admin.pros.tabCount', { label: t(`admin.pros.tab.${key}`), count: data?.counts[key] ?? 0 })}
          </button>
        ))}
      </div>

      <div className="row gap8 wrap filters">
        <div className="af grow">
          <label htmlFor="pro-search">{t('admin.pros.search')}</label>
          <input
            id="pro-search"
            type="search"
            maxLength={60}
            placeholder={t('admin.pros.searchHint')}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      </div>

      <ResourceState state={listState} reload={reloadList}>
        {({ pros }) =>
          pros.length === 0 ? (
            <p className="panel muted">{t(`admin.pros.empty.${tab}`)}</p>
          ) : (
            <ProTable tab={tab} pros={pros} onOpen={openPro} />
          )
        }
      </ResourceState>

      {open && <AdminProPanel proId={open} onClose={close} onChanged={reloadAll} />}
    </>
  );
}

/** Old links to one pro open them in the side panel of the Providers page. */
export function AdminProRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={UUID.test(id) ? `/admin/providers?tab=active&open=${id}` : '/admin/providers'} replace />;
}
