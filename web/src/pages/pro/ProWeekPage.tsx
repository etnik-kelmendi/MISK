import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { EarningsSummary, ProAvailability, ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { addDays } from '../../lib/calendar';
import { dayKey, dayName, dayParts, euro, isoWeekday, longDate, time, zonedToIso } from '../../lib/format';
import { loadSchedule, type ScheduleItem } from '../../lib/proSchedule';
import { OnlineSwitch, saveOnline } from './OnlineSwitch';
import { ProPlansSection } from './ProVisitPage';
import { displayLocale } from '../../lib/locale';

const DAY_MS = 24 * 3600 * 1000;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** Counted in the week: everything except a visit the customer skipped (D90). */
const counts = (item: ScheduleItem) => item.status !== 'skipped' && item.status !== 'cancelled';

/** Whether the pro is off on a day ("YYYY-MM-DD"): a day off, a holiday, or not one of their working days (D99). */
export function isDayOff(availability: ProAvailability | undefined, key: string, weekday: number): boolean {
  if (!availability) return false;
  return (
    availability.daysOff.some((entry) => entry.day === key) ||
    availability.holidays.some((holiday) => holiday.startsOn <= key && key <= holiday.endsOn) ||
    !availability.workingDays.includes(weekday)
  );
}

/**
 * Noon of each of the 7 calendar days from `start` on, in the market time zone, as ISO text. The days are counted
 * on the calendar, not in 24-hour steps, so a clock change never skips or repeats a day.
 */
export function nextSevenDays(start: Date, timezone: string): string[] {
  const first = dayKey(start.toISOString(), timezone);
  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(first, i);
    return zonedToIso(key, '12:00', timezone) ?? `${key}T12:00:00.000Z`;
  });
}

/** "Mon, Tue, Wed" for the pro's working days, in the market's short weekday names. */
function workingDaysText(days: number[], noDays: string): string {
  if (days.length === 0) return noDays;
  // 5 January 2026 was a Monday.
  return WEEKDAYS.filter((day) => days.includes(day))
    .map((day) => new Intl.DateTimeFormat(displayLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day, 12))))
    .join(', ');
}

/** The Availability card (D99): working days, hours and days off, opening the Availability page. */
function AvailabilityCard({ availability }: { availability: ProAvailability }) {
  const { t } = useTranslation();
  const summary = [
    workingDaysText(availability.workingDays, t('week.noWorkingDays')),
    `${availability.workStart}–${availability.workEnd}`,
    ...(availability.daysOff.length ? [t('week.daysOff', { count: availability.daysOff.length })] : []),
  ].join(' · ');
  return (
    // The back arrow of the Availability page returns here rather than to the Profile.
    <Link to="/pro/availability" state={{ back: '/pro/week' }} className="card row link-card gap8">
      <span className="tile-icon" aria-hidden="true">
        <Icon name="clock" />
      </span>
      <span className="grow min0">
        <span className="b small block">{t('week.availability')}</span>
        <span className="tiny muted">{summary}</span>
      </span>
      <span className="mini-btn" aria-hidden="true">
        {t('week.edit')}
      </span>
    </Link>
  );
}

/** The payout card (D99): the next payout day, what is ready and pending, opening the Earnings page. */
function PayoutCard() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ summary: EarningsSummary }>('/pro/earnings/summary'), [api]);
  const { state } = useResource(load);
  if (state.status !== 'ready') return null;
  const { summary } = state.data;
  return (
    <Link to="/pro/earnings" className="card row link-card gap8">
      <Icon name="card" />
      <span className="grow min0">
        <span className="b small block">{t('week.nextPayout', { date: longDate(summary.nextPayoutOn, 'UTC') })}</span>
        <span className="tiny muted">
          {t('week.payoutLine', { ready: euro(summary.readyCents), pending: euro(summary.pendingCents) })}
          {summary.bankLast4 && ` · ${t('week.payoutTo', { last4: summary.bankLast4 })}`}
        </span>
      </span>
      <Icon name="chevR" />
    </Link>
  );
}

/** One job or plan visit of the chosen day: plan visits have an orange edge, one-off jobs a green one. */
function DayItem({ item, timezone }: { item: ScheduleItem; timezone: string }) {
  const { t } = useTranslation();
  const visit = item.kind === 'visit';
  return (
    <Link to={item.href} className={`job link-card ${visit ? 'rec' : 'one'} ${item.status === 'skipped' ? 'skipped' : ''}`}>
      <span className="jt">{time(item.startsAt, timezone)}</span>
      <span className="grow min0">
        <span className="b small block">{item.title}</span>
        <span className="tiny muted">{item.address}</span>
      </span>
      <span className="right stack-tight">
        <span className="b small block">{euro(item.earningsCents)}</span>
        {visit ? (
          <span className="badge a">
            <Icon name="repeat" /> {t('week.plan')}
          </span>
        ) : (
          <span className="badge g">{t('week.oneOff')}</span>
        )}
        {/* Skipped by the customer (D90): listed, but not expected. */}
        {item.status === 'skipped' && <span className="badge grey">{t('visit.skipped')}</span>}
      </span>
    </Link>
  );
}

/** My week (D86, D99): the next 7 days with their earnings, the chosen day's jobs, availability and payouts. */
export function ProWeekPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [start] = useState(() => new Date());
  const days = useMemo(() => nextSevenDays(start, timezone), [start, timezone]);
  const [selected, setSelected] = useState(() => dayKey(start.toISOString(), timezone));

  const loadProfile = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const profile = useResource(loadProfile);
  const loadJobs = useCallback(
    () => loadSchedule(api, { from: new Date(start.getTime() - DAY_MS), to: new Date(start.getTime() + 8 * DAY_MS) }),
    [api, start],
  );
  const jobs = useResource(loadJobs);

  const current = profile.state.status === 'ready' ? profile.state.data.profile : null;
  const availability = current?.availability;
  const updateProfile = profile.update;
  const setOnline = useCallback(
    async (online: boolean) => {
      if (!current) throw new Error('The profile is not loaded yet');
      const next = await saveOnline(api, current, online);
      updateProfile(() => ({ profile: next }));
      return next;
    },
    [api, current, updateProfile],
  );

  const dayKeys = days.map((d) => dayKey(d, timezone));
  const list = jobs.state.status === 'ready' ? jobs.state.data : [];
  const inWeek = list.filter((item) => dayKeys.includes(dayKey(item.startsAt, timezone)));
  const weekTotal = inWeek.filter(counts).reduce((sum, item) => sum + item.earningsCents, 0);
  const recurring = inWeek.filter((item) => item.kind === 'visit' && counts(item)).length;
  // Every holiday from today on (the server lists only those), each with its dates.
  const holidays = availability?.holidays ?? [];

  return (
    <>
      <header className="prohead">
        <div className="row between">
          <h1>{t('week.title')}</h1>
          {current?.status === 'approved' && <OnlineSwitch profile={current} onChange={setOnline} />}
        </div>
        <div className="row gap8 kpi-row">
          <div className="kpi-dark">
            <p className="tiny subtle">{t('week.thisWeek')}</p>
            <p className="b big">{jobs.state.status === 'ready' ? euro(weekTotal) : '–'}</p>
          </div>
          <div className="kpi-dark">
            <p className="tiny subtle">{t('week.recurring')}</p>
            <p className="b big accent">{jobs.state.status === 'ready' ? recurring : '–'}</p>
          </div>
        </div>
      </header>
      <div className="body">
        {holidays.map((holiday) => (
          <div key={holiday.id} className="info amber" role="note">
            <Icon name="sun" />
            <p>
              <b>{t('week.holiday', { range: `${longDate(holiday.startsOn, 'UTC')} – ${longDate(holiday.endsOn, 'UTC')}` })}</b>{' '}
              {t('week.holidayText')}
              {(availability?.visitsOnDaysOff.length ?? 0) > 0 && ` ${t('week.holidayVisits')}`}
            </p>
          </div>
        ))}
        {availability && <AvailabilityCard availability={availability} />}
        <ResourceState state={jobs.state} reload={jobs.reload}>
          {(items) => {
            const byDay = new Map<string, ScheduleItem[]>();
            for (const item of items) {
              const key = dayKey(item.startsAt, timezone);
              byDay.set(key, [...(byDay.get(key) ?? []), item]);
            }
            const totals = dayKeys.map((key) => (byDay.get(key) ?? []).filter(counts).reduce((sum, item) => sum + item.earningsCents, 0));
            const max = Math.max(1, ...totals);
            const index = Math.max(0, dayKeys.indexOf(selected));
            const shown = byDay.get(selected) ?? [];
            const selectedIso = days[index] ?? start.toISOString();
            // The heading always names the date, also for today: "Today, Thu 26 Nov · 2 jobs".
            const dayLabel = index === 0 ? t('week.todayDate', { date: dayName(selectedIso, timezone) }) : dayName(selectedIso, timezone);
            const off = isDayOff(availability, selected, isoWeekday(selectedIso, timezone));
            return (
              <>
                <section className="card" aria-labelledby="by-day">
                  <div className="row between">
                    <h2 id="by-day" className="b small">
                      {t('week.byDay')}
                    </h2>
                    <span className="tiny muted">{t('week.tapDay')}</span>
                  </div>
                  <div className="bars">
                    {days.map((d, i) => {
                      const key = dayKeys[i] ?? '';
                      const total = totals[i] ?? 0;
                      const label = i === 0 ? t('week.today') : dayParts(d, timezone).weekday;
                      return (
                        <button
                          key={key}
                          type="button"
                          className="bcol"
                          aria-pressed={key === selected}
                          aria-label={t('week.barLabel', { day: i === 0 ? t('week.today') : dayName(d, timezone), amount: euro(total) })}
                          onClick={() => setSelected(key)}
                        >
                          <span className="tiny b" aria-hidden="true">
                            {total ? euro(total) : ''}
                          </span>
                          <span
                            className={`bar ${key === selected ? 'hl' : ''}`}
                            style={{ height: `${Math.max(4, (total / max) * 70)}px` }}
                            aria-hidden="true"
                          />
                          <span className="bl" aria-hidden="true">
                            {label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <h2 className="h-sm row gap8 wrap" id="day-heading">
                  <span>
                    {dayLabel} · {t('week.jobsOn', { count: shown.length })}
                  </span>
                  {off && <span className="badge grey">{t('week.dayOff')}</span>}
                </h2>
                {shown.length === 0 ? (
                  <p className="card small muted center">
                    {t('week.dayOff')} <Icon name="sun" />
                  </p>
                ) : (
                  <ul className="stack" aria-labelledby="day-heading">
                    {shown.map((item) => (
                      <li key={item.key}>
                        <DayItem item={item} timezone={timezone} />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          }}
        </ResourceState>
        {current?.status === 'approved' && <PayoutCard />}
        {/* The plans in the pro's trades moved here from the Jobs page, which follows the design (D86). */}
        <ProPlansSection />
      </div>
    </>
  );
}
