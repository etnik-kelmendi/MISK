import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import { useResource } from '../../../api/useResource';
import { Icon } from '../../../components/Icon';
import { ResourceState } from '../../../components/ResourceState';
import { AppHeader } from '../../../shells/Shells';
import { PRO_PROFILE_PATHS, type Metric, type Performance } from './types';

type RateKey = 'acceptance' | 'onTime' | 'completion';
const RATES: RateKey[] = ['acceptance', 'onTime', 'completion'];

/** A bar from 0 to `max` with the value's share filled, red below its goal. */
function Bar({ label, value, max, low, text }: { label: string; value: number; max: number; low: boolean; text: string }) {
  const width = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span
      className="meter perf-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={text}
    >
      <span className={`meter-fill ${low ? 'danger' : ''}`} style={{ width: `${width}%` }} />
    </span>
  );
}

/** One rate (acceptance, on time, completed jobs): the number, its bar and its goal; red when below the goal. */
function RateCard({ name, metric }: { name: RateKey; metric: Metric }) {
  const { t } = useTranslation();
  const label = t(`perf.${name}.title`);
  const valueText = metric.value === null ? t('perf.noData') : t('perf.pct', { value: metric.value });
  return (
    <section className={`card perf-card ${metric.belowGoal ? 'below' : ''}`} aria-labelledby={`perf-${name}`}>
      <div className="row between">
        <h2 id={`perf-${name}`} className="small b">
          {label}
        </h2>
        <b className={metric.belowGoal ? 'error-strong' : 'brand-text'}>{valueText}</b>
      </div>
      <Bar
        label={label}
        value={metric.value ?? 0}
        max={100}
        low={metric.belowGoal}
        text={metric.value === null ? t('perf.noData') : t('perf.barText', { value: metric.value, goal: metric.goal })}
      />
      <div className="row between tiny muted wrap gap4">
        <span>{t(`perf.${name}.hint`)}</span>
        <span className={metric.belowGoal ? 'error-strong' : ''}>{t('perf.goal', { goal: metric.goal })}</span>
      </div>
      {metric.belowGoal && <p className="visually-hidden">{t('perf.belowGoal')}</p>}
    </section>
  );
}

/** The message at the top: the pro's place in their main trade this month, or what helps to get more jobs. */
function RankMessage({ rank }: { rank: Performance['rank'] }) {
  const { t } = useTranslation();
  const top = rank?.topPercent;
  return (
    <div className={`info ${top ? '' : 'amber'}`} role="status">
      <Icon name="sparkle" />
      <p>
        {rank && top ? (
          <>
            <b>{t('perf.topTitle', { pct: top, trade: rank.trade })}</b> {t('perf.topText')}
          </>
        ) : (
          t('perf.notTop')
        )}
      </p>
    </div>
  );
}

/**
 * Performance (D100): the last 30 days against their goals, each number with a bar and its goal next to it, red
 * when below the goal: acceptance rate (85%), on time (90%), completed jobs (98%), late cancellations ("1 of 3")
 * and the rating with the quality-check rule. The message on top tells the pro where they stand in their trade.
 */
export function PerformancePage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ performance: Performance }>('/pro/performance'), [api]);
  const { state, reload } = useResource(load);
  return (
    <>
      <AppHeader title={t('proProfile.performance')} back={PRO_PROFILE_PATHS.profile} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ performance }) => {
            const late = performance.lateCancellations;
            const rating = performance.rating;
            return (
              <div className="stack">
                <RankMessage rank={performance.rank} />
                {RATES.map((name) => (
                  <RateCard key={name} name={name} metric={performance[name]} />
                ))}
                <section className={`card perf-card ${late.belowGoal ? 'below' : ''}`} aria-labelledby="perf-late">
                  <div className="row between">
                    <h2 id="perf-late" className="small b">
                      {t('perf.late.title')}
                    </h2>
                    <b className={late.belowGoal ? 'error-strong' : ''}>{t('perf.late.value', { count: late.value, limit: late.limit })}</b>
                  </div>
                  <Bar
                    label={t('perf.late.title')}
                    value={late.value}
                    max={late.limit}
                    low={late.belowGoal}
                    text={t('perf.late.value', { count: late.value, limit: late.limit })}
                  />
                  {/* The limit stands where the other cards have their goal (D105); red from one below it, as one more pauses offers (D100). */}
                  <div className="row between tiny muted wrap gap4">
                    <span className={late.belowGoal ? 'error-strong' : ''}>{t('perf.late.hint', { limit: late.limit })}</span>
                    <span className={late.belowGoal ? 'error-strong' : ''}>{t('perf.late.goal', { limit: late.limit })}</span>
                  </div>
                </section>
                <section className={`card perf-card ${rating.belowGoal ? 'below' : ''}`} aria-labelledby="perf-rating">
                  <div className="row between">
                    <h2 id="perf-rating" className="small b">
                      {t('perf.rating.title')}
                    </h2>
                    <b className={rating.belowGoal ? 'error-strong' : 'stars'}>
                      {rating.value === null ? t('perf.noRating') : `★ ${rating.value.toFixed(1)}`}
                    </b>
                  </div>
                  <Bar
                    label={t('perf.rating.title')}
                    value={rating.value ?? 0}
                    max={5}
                    low={rating.belowGoal}
                    text={
                      rating.value === null
                        ? t('perf.noRating')
                        : t('perf.rating.barText', { value: rating.value.toFixed(1), goal: rating.goal })
                    }
                  />
                  <div className="row between tiny muted wrap gap4">
                    <span>{t('perf.rating.hint')}</span>
                    <span className={rating.belowGoal ? 'error-strong' : ''}>{t('perf.rating.goal', { goal: rating.goal })}</span>
                  </div>
                </section>
                <p className="tiny muted">{t('perf.window', { days: performance.windowDays })}</p>
              </div>
            );
          }}
        </ResourceState>
      </div>
    </>
  );
}
