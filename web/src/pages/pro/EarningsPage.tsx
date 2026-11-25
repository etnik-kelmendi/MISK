import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { EarningFilter, EarningItem, EarningStatus, EarningsPage as EarningsData } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { euro, longDate } from '../../lib/format';
import { useAction } from '../../lib/useAction';

const FILTERS: EarningFilter[] = ['all', 'pending', 'ready', 'paid'];
const PAGE_SIZE = 20;
/** Badge colour per status, as in the design: Pending amber, Ready blue, Paid green, On hold red. */
const BADGE: Record<EarningStatus, string> = { pending: 'a', ready: 'b', paid: 'g', on_hold: 'r', stand_in: 'grey' };

/** One job or plan visit: what the pro gets, its status and, for a one-off job, the breakdown (D99). */
function EarningCard({ item }: { item: EarningItem }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const breakdown = item.breakdown;
  return (
    <li className="card" aria-labelledby={`earning-${item.id}`}>
      <div className="row between top">
        <div className="min0">
          <p id={`earning-${item.id}`} className="b small">
            {item.title}
          </p>
          <p className="tiny muted">{t('earnings.meta', { date: longDate(item.date, timezone), customer: item.customerName ?? t('earnings.customer') })}</p>
        </div>
        <div className="right flex-none">
          {/* A visit a stand-in did for the pro is paid to the stand-in (D99): no amount here. */}
          {item.kind !== 'stand_in' && <p className="b">{euro(item.youGetCents)}</p>}
          <span className={`badge ${BADGE[item.status]}`}>{t(`earnings.status.${item.status}`)}</span>
        </div>
      </div>
      {item.kind === 'stand_in' ? (
        <p className="ebd">
          <span>{t('earnings.standIn')}</span>
        </p>
      ) : breakdown === null ? (
        <p className="ebd">
          <span>{t('earnings.planVisit')}</span>
        </p>
      ) : breakdown.type === 'no_show' ? (
        <p className="ebd">
          <span>{t('earnings.noShow')}</span>
          <span className="you">{t('earnings.youGet', { amount: euro(item.youGetCents) })}</span>
        </p>
      ) : (
        <p className="ebd">
          {breakdown.type === 'late_cancel' && <span>{t('earnings.lateCancel')}</span>}
          {breakdown.lines.map((line, index) => (
            <span key={`${line.kind}-${index}`}>
              {line.kind === 'job'
                ? t('earnings.job', { amount: euro(line.cents) })
                : line.kind === 'waiting'
                  ? t('earnings.waiting', { amount: euro(line.cents) })
                  : t('earnings.extra', { label: line.label, amount: euro(line.cents) })}
            </span>
          ))}
          {breakdown.commissionPct !== null && (
            <span>{t('earnings.commission', { pct: breakdown.commissionPct, amount: euro(breakdown.commissionCents) })}</span>
          )}
          {breakdown.tipCents > 0 && <span>{t('earnings.tip', { amount: euro(breakdown.tipCents) })}</span>}
          <span className="you">{t('earnings.youGet', { amount: euro(item.youGetCents) })}</span>
        </p>
      )}
    </li>
  );
}

/** The Earnings page (D99): Ready, Pending and Paid, this month's statement, every job and past payouts. */
export function EarningsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [filter, setFilter] = useState<EarningFilter>('all');
  const load = useCallback(() => api.get<EarningsData>(`/pro/earnings?status=${filter}&limit=${PAGE_SIZE}`), [api, filter]);
  const { state, reload, update } = useResource(load);
  const more = useAction();

  async function showMore(offset: number) {
    const next = await more.run(() => api.get<EarningsData>(`/pro/earnings?status=${filter}&limit=${PAGE_SIZE}&offset=${offset}`));
    if (next) update((current) => ({ ...current, items: [...current.items, ...next.items], hasMore: next.hasMore }));
  }

  const summary = state.status === 'ready' ? state.data.summary : null;
  return (
    <>
      <header className="prohead">
        <div className="row between">
          <h1>{t('earnings.title')}</h1>
          <a className="mini-btn dark-btn" href={`${api.baseUrl}/pro/earnings/statement`} download aria-label={t('earnings.statementLabel')}>
            <Icon name="download" /> {t('earnings.statement')}
          </a>
        </div>
        <div className="row gap8 kpi-row kpi3">
          <div className="kpi-dark min0">
            <p className="tiny subtle">{t('earnings.ready')}</p>
            <p className="b">{summary ? euro(summary.readyCents) : '–'}</p>
            <p className="tiny subtle ellipsis">{summary ? t('earnings.readyHint', { date: longDate(summary.nextPayoutOn, 'UTC') }) : ''}</p>
          </div>
          <div className="kpi-dark min0">
            <p className="tiny subtle">{t('earnings.pending')}</p>
            <p className="b accent">{summary ? euro(summary.pendingCents) : '–'}</p>
            <p className="tiny subtle ellipsis">{t('earnings.pendingHint')}</p>
          </div>
          <div className="kpi-dark min0">
            <p className="tiny subtle">{t('earnings.paid')}</p>
            <p className="b paid-total">{summary ? euro(summary.paidThisMonthCents) : '–'}</p>
            <p className="tiny subtle ellipsis">{t('earnings.paidHint')}</p>
          </div>
        </div>
      </header>
      <div className="body">
        <div className="seg" role="group" aria-label={t('earnings.filters')}>
          {FILTERS.map((key) => (
            <button key={key} type="button" className={filter === key ? 'on' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {t(`earnings.filter.${key}`)}
            </button>
          ))}
        </div>
        <ResourceState state={state} reload={reload}>
          {(data) => (
            <>
              {data.items.length === 0 ? (
                <p className="card small muted center">{t('earnings.empty')}</p>
              ) : (
                <ul className="stack" aria-label={t('earnings.list')}>
                  {data.items.map((item) => (
                    <EarningCard key={`${item.kind}-${item.id}`} item={item} />
                  ))}
                </ul>
              )}
              {data.hasMore && (
                <button type="button" className="btn btn-ghost wide" disabled={more.busy} onClick={() => void showMore(data.items.length)}>
                  {t('earnings.more')}
                </button>
              )}
              <ErrorText error={more.error} />
              <div className="info">
                <Icon name="clock" />
                <p>
                  <b>{t('earnings.explainPending')}</b> {t('earnings.explainPendingText')} <b>{t('earnings.explainReady')}</b>{' '}
                  {t('earnings.explainReadyText')} <b>{t('earnings.explainPaid')}</b> {t('earnings.explainPaidText')}
                </p>
              </div>
              <section aria-labelledby="payouts-heading">
                <h2 id="payouts-heading" className="h-sm">
                  {t('earnings.payouts')}
                </h2>
                {data.payouts.length === 0 ? (
                  <p className="small muted">{t('earnings.noPayouts')}</p>
                ) : (
                  <ul className="lgroup">
                    {data.payouts.map((payout) => (
                      <li key={payout.id} className="lrow">
                        <span className="li" aria-hidden="true">
                          <Icon name="card" />
                        </span>
                        <span className="grow">
                          <span className="block">{euro(payout.amountCents)}</span>
                          <span className="tiny muted">
                            {payout.bankLast4
                              ? t('earnings.payoutMeta', { date: longDate(payout.paidOn, 'UTC'), last4: payout.bankLast4 })
                              : t('earnings.payoutMetaNoBank', { date: longDate(payout.paidOn, 'UTC') })}
                          </span>
                        </span>
                        <span className="badge g">{t('earnings.status.paid')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </ResourceState>
      </div>
    </>
  );
}
