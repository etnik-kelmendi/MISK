import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { HandOverResult, ProAvailability, VisitOnDayOff } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, dayKey, longDate } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { AppHeader } from '../../shells/Shells';

/** Working hours run on the hour; a day can end at midnight (24:00). */
const START_OPTIONS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
const END_OPTIONS = Array.from({ length: 24 }, (_, hour) => `${String(hour + 1).padStart(2, '0')}:00`);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** A weekday name (1 = Monday), short ("Mon") or long ("Monday"). 5 January 2026 was a Monday. */
function weekdayName(day: number, style: 'short' | 'long'): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day, 12)));
}

/** "Wed 3 Dec 2026" for a calendar day "2026-12-03". */
function dayLabel(day: string): string {
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  return `${weekday} ${longDate(day, 'UTC')}`;
}

type Change = (next: ProAvailability) => void;

/** Where the back arrow goes: My week when the page was opened from its Availability card, else the Profile. */
function backPath(state: unknown): string {
  const back = (state as { back?: unknown } | null)?.back;
  return back === '/pro/week' ? '/pro/week' : '/pro/profile';
}

/** Seven buttons, Monday to Sunday, each switching a working day on or off; saved at once (D99). */
function WorkingDays({ availability, onChange }: { availability: ProAvailability; onChange: Change }) {
  const { t } = useTranslation();
  const api = useApi();
  const save = useAction();
  const [lastOne, setLastOne] = useState(false);

  async function toggle(day: number) {
    const on = availability.workingDays.includes(day);
    const next = on ? availability.workingDays.filter((d) => d !== day) : [...availability.workingDays, day].sort((a, b) => a - b);
    if (next.length === 0) {
      setLastOne(true);
      return;
    }
    setLastOne(false);
    const result = await save.run(() => api.put<{ availability: ProAvailability }>('/pro/working-days', { workingDays: next }));
    if (result) onChange(result.availability);
  }

  return (
    <section aria-labelledby="days-heading">
      <h2 id="days-heading" className="h-sm">
        {t('availability.workingDays')}
      </h2>
      <div className="wk dark" role="group" aria-labelledby="days-heading">
        {WEEKDAYS.map((day) => {
          const on = availability.workingDays.includes(day);
          return (
            <button
              key={day}
              type="button"
              className={on ? 'on' : ''}
              aria-pressed={on}
              aria-label={weekdayName(day, 'long')}
              disabled={save.busy}
              onClick={() => void toggle(day)}
            >
              {weekdayName(day, 'short')}
            </button>
          );
        })}
      </div>
      <p className="tiny muted">{t('availability.workingDaysHint')}</p>
      {lastOne && (
        <p className="small error-text" role="alert">
          {t('availability.keepOneDay')}
        </p>
      )}
      <ErrorText error={save.error} />
    </section>
  );
}

/** One start and finish time for every working day (D94); only new offers follow them. */
function WorkingHours({ availability, onChange }: { availability: ProAvailability; onChange: Change }) {
  const { t } = useTranslation();
  const api = useApi();
  const hours = useAction();
  const [start, setStart] = useState(availability.workStart);
  const [end, setEnd] = useState(availability.workEnd);
  const [saved, setSaved] = useState(false);
  const startOptions = START_OPTIONS.includes(start) ? START_OPTIONS : [start, ...START_OPTIONS];
  const endOptions = END_OPTIONS.includes(end) ? END_OPTIONS : [...END_OPTIONS, end];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const result = await hours.run(() =>
      api.put<{ availability: ProAvailability }>('/pro/working-hours', { workStart: start, workEnd: end }),
    );
    if (result) {
      onChange(result.availability);
      setSaved(true);
    }
  }

  return (
    <section aria-labelledby="hours-heading">
      <h2 id="hours-heading" className="h-sm">
        {t('availability.hours')}
      </h2>
      <form className="card stack" onSubmit={submit} noValidate aria-labelledby="hours-heading">
        <div className="row gap8 wrap">
          <div className="field">
            <label htmlFor="work-start">{t('availability.start')}</label>
            <select id="work-start" value={start} onChange={(event) => setStart(event.target.value)}>
              {startOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="work-end">{t('availability.finish')}</label>
            <select id="work-end" value={end} onChange={(event) => setEnd(event.target.value)}>
              {endOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="tiny muted">{t('availability.hoursHint')}</p>
        <p className="tiny muted">{t('availability.keepsJobs')}</p>
        <ErrorText error={hours.error} />
        <div className="row gap8">
          <button type="submit" className="mini-btn pro-btn" disabled={hours.busy}>
            {t('availability.save')}
          </button>
          {saved && (
            <span className="tiny muted" role="status">
              <Icon name="check" /> {t('availability.saved')}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

/** Single days off (D99): a list with "Remove", and "Add a day off" with a date from today on. */
function DaysOff({
  availability,
  onChange,
  onAdded,
}: {
  availability: ProAvailability;
  onChange: Change;
  onAdded: (next: ProAvailability) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const add = useAction();
  const remove = useAction();
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState('');
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState('');
  const today = dayKey(new Date().toISOString(), timezone);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!day) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const result = await add.run(() => api.post<{ availability: ProAvailability }>('/pro/days-off', { day }));
    if (result) {
      onAdded(result.availability);
      setDay('');
      setAdding(false);
      setNotice(t('availability.dayOffAdded'));
    }
  }

  return (
    <section aria-labelledby="days-off-heading">
      <h2 id="days-off-heading" className="h-sm">
        {t('availability.daysOffTitle')}
      </h2>
      <div className="lgroup">
        {availability.daysOff.length === 0 && <p className="lrow small muted">{t('availability.noDaysOff')}</p>}
        {availability.daysOff.map((entry) => (
          <div key={entry.id} className="lrow">
            <span className="li" aria-hidden="true">
              <Icon name="calendar" />
            </span>
            <span className="grow">{dayLabel(entry.day)}</span>
            <button
              type="button"
              className="mini-btn"
              aria-label={t('availability.removeDayOff', { date: dayLabel(entry.day) })}
              disabled={remove.busy}
              onClick={() =>
                void remove
                  .run(() => api.delete<{ availability: ProAvailability }>(`/pro/days-off/${encodeURIComponent(entry.id)}`))
                  .then((result) => result && onChange(result.availability))
              }
            >
              {t('availability.remove')}
            </button>
          </div>
        ))}
        {!adding && (
          <button type="button" className="lrow" onClick={() => setAdding(true)}>
            <span className="li" aria-hidden="true">
              <Icon name="plus" />
            </span>
            <span className="grow">{t('availability.addDayOff')}</span>
          </button>
        )}
      </div>
      {adding && (
        <form className="card stack" onSubmit={submit} noValidate aria-label={t('availability.addDayOff')}>
          <div className="field">
            <label htmlFor="day-off">{t('availability.dayOffDate')}</label>
            <input
              id="day-off"
              type="date"
              min={today}
              value={day}
              aria-invalid={missing && !day}
              aria-describedby={missing ? 'day-off-missing-error' : undefined}
              onChange={(event) => setDay(event.target.value)}
            />
          </div>
          <FieldError id="day-off-missing" message={missing ? t('availability.dayOffMissing') : null} />
          <ErrorText error={add.error} />
          <div className="row gap8">
            <button type="submit" className="mini-btn pro-btn" disabled={add.busy}>
              {t('availability.add')}
            </button>
            <button type="button" className="mini-btn" onClick={() => setAdding(false)}>
              {t('availability.cancel')}
            </button>
          </div>
        </form>
      )}
      <ErrorText error={remove.error} />
      <p className="tiny muted" role="status">
        {notice}
      </p>
    </section>
  );
}

/** "I'm going on holiday" (D99): on, choose a first and last day; off, every coming holiday ends. */
function Holiday({
  availability,
  onChange,
  onAdded,
}: {
  availability: ProAvailability;
  onChange: Change;
  onAdded: (next: ProAvailability) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const save = useAction();
  const remove = useAction();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Both days are needed, and the last cannot come before the first (the server refuses it too).
  const [problem, setProblem] = useState<'missing' | 'order' | null>(null);
  const [notice, setNotice] = useState('');
  const today = dayKey(new Date().toISOString(), timezone);
  const planned = availability.holidays.length > 0;
  const on = planned || open;
  const range = (entry: { startsOn: string; endsOn: string }) => ({
    from: longDate(entry.startsOn, 'UTC'),
    to: longDate(entry.endsOn, 'UTC'),
  });

  async function toggle() {
    setNotice('');
    if (planned) {
      const result = await remove.run(() => api.delete<{ availability: ProAvailability }>('/pro/holidays'));
      if (result) {
        onChange(result.availability);
        setOpen(false);
        setNotice(t('availability.holidayEnded'));
      }
      return;
    }
    setOpen(!open);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!from || !to) {
      setProblem('missing');
      return;
    }
    // "YYYY-MM-DD" text orders like the dates.
    if (to < from) {
      setProblem('order');
      return;
    }
    setProblem(null);
    const result = await save.run(() => api.post<{ availability: ProAvailability }>('/pro/holidays', { startsOn: from, endsOn: to }));
    if (result) {
      onAdded(result.availability);
      setFrom('');
      setTo('');
      setOpen(false);
      setNotice(t('availability.holidaySaved'));
    }
  }

  return (
    <section aria-labelledby="holiday-heading">
      <h2 id="holiday-heading" className="h-sm">
        {t('availability.holidays')}
      </h2>
      <div className="lgroup">
        <button type="button" role="switch" aria-checked={on} className="lrow" disabled={remove.busy} onClick={() => void toggle()}>
          <span className="grow">
            <span className="block">{t('availability.holidaySwitch')}</span>
            <span className="tiny muted">
              {planned
                ? availability.holidays.map((entry) => t('availability.holidayRange', range(entry))).join(', ')
                : t('availability.holidayOff')}
            </span>
          </span>
          <span className={`toggle ${on ? 'on' : ''}`} aria-hidden="true" />
        </button>
        {availability.holidays.length > 1 &&
          availability.holidays.map((entry) => (
            <div key={entry.id} className="lrow">
              <span className="li" aria-hidden="true">
                <Icon name="sun" />
              </span>
              <span className="grow small">{t('availability.holidayRange', range(entry))}</span>
              <button
                type="button"
                className="mini-btn"
                aria-label={t('availability.removeHoliday', range(entry))}
                disabled={remove.busy}
                onClick={() =>
                  void remove
                    .run(() => api.delete<{ availability: ProAvailability }>(`/pro/holidays/${encodeURIComponent(entry.id)}`))
                    .then((result) => result && onChange(result.availability))
                }
              >
                {t('availability.remove')}
              </button>
            </div>
          ))}
      </div>
      {open && (
        <form className="card stack" onSubmit={submit} noValidate aria-label={t('availability.holidaySwitch')}>
          <div className="row gap8 wrap">
            <div className="field">
              <label htmlFor="holiday-from">{t('availability.from')}</label>
              <input
                id="holiday-from"
                type="date"
                min={today}
                value={from}
                aria-invalid={problem === 'missing' && !from}
                aria-describedby={problem ? 'holiday-problem-error' : undefined}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="holiday-to">{t('availability.to')}</label>
              <input
                id="holiday-to"
                type="date"
                min={from || today}
                value={to}
                aria-invalid={(problem === 'missing' && !to) || problem === 'order'}
                aria-describedby={problem ? 'holiday-problem-error' : undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
          </div>
          <FieldError
            id="holiday-problem"
            message={problem === 'missing' ? t('availability.holidayMissing') : problem === 'order' ? t('availability.holidayOrder') : null}
          />
          <ErrorText error={save.error} />
          <div>
            <button type="submit" className="mini-btn pro-btn" disabled={save.busy}>
              {t('availability.saveHoliday')}
            </button>
          </div>
        </form>
      )}
      {on && (
        <div className="info amber">
          <Icon name="sun" />
          <p>{t('availability.holidayInfo')}</p>
        </div>
      )}
      <ErrorText error={remove.error} />
      <p className="tiny muted" role="status">
        {notice}
      </p>
    </section>
  );
}

/** One plan visit on a day off: "Move it" to another free day of its week, or "Give to another pro" (D99). */
function DayOffVisit({ visit, onChange, onNotice }: { visit: VisitOnDayOff; onChange: Change; onNotice: (text: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const action = useAction();
  const [days, setDays] = useState<{ startsAt: string }[] | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const customer = visit.customerName ?? t('availability.theCustomer');
  const base = `/pro/visits/${encodeURIComponent(visit.id)}`;

  async function openMove() {
    const result = await action.run(() => api.get<{ days: { startsAt: string }[] }>(`${base}/move-days`));
    if (result) {
      setDays(result.days);
      setChoice(result.days.length === 1 ? (result.days[0]?.startsAt ?? null) : null);
    }
  }

  async function move() {
    if (!choice) return;
    const result = await action.run(() => api.post<{ availability: ProAvailability }>(`${base}/move`, { startsAt: choice }));
    if (result) {
      onNotice(t('availability.moved', { when: dateTime(choice, timezone), customer }));
      onChange(result.availability);
    }
  }

  async function give() {
    const result = await action.run(() => api.post<HandOverResult>(`${base}/hand-over`));
    if (result) {
      onNotice(
        result.outcome === 'reassigned'
          ? t('availability.givenTo', { name: result.standInName ?? '', customer })
          : t('availability.teamAsked'),
      );
      onChange(result.availability);
    }
  }

  return (
    <li className="card stack" aria-labelledby={`visit-${visit.id}`}>
      <div className="job rec">
        <span className="grow min0">
          <span id={`visit-${visit.id}`} className="b small block">
            {t('availability.visitLine', { plan: visit.planName, customer })}
          </span>
          <span className="tiny muted">
            {dateTime(visit.startsAt, timezone)} · {visit.address}
          </span>
        </span>
        {visit.teamAsked && <span className="badge b">{t('availability.teamAskedBadge')}</span>}
      </div>
      {days !== null && (
        <fieldset className="stack">
          <legend className="small b">{t('availability.moveTo')}</legend>
          {days.length === 0 ? (
            <p className="small muted">{t('availability.noMoveDays')}</p>
          ) : (
            <div className="chips">
              {days.map((day) => (
                <label key={day.startsAt} className={`chip ${choice === day.startsAt ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name={`move-${visit.id}`}
                    className="visually-hidden"
                    checked={choice === day.startsAt}
                    onChange={() => setChoice(day.startsAt)}
                  />
                  {dateTime(day.startsAt, timezone)}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <ErrorText error={action.error} />
      <div className="row gap8 wrap">
        {days !== null && days.length > 0 ? (
          <button type="button" className="mini-btn pro-btn" disabled={action.busy || !choice} onClick={() => void move()}>
            {t('availability.moveHere')}
          </button>
        ) : (
          <button type="button" className="mini-btn pro-btn" disabled={action.busy || days !== null} onClick={() => void openMove()}>
            {t('availability.moveIt')}
          </button>
        )}
        <button type="button" className="mini-btn" disabled={action.busy} onClick={() => void give()}>
          {t('availability.giveAway')}
        </button>
      </div>
    </li>
  );
}

/** Plan visits and accepted jobs on the pro's days off and holidays (D99). */
function OnDaysOff({ availability, onChange, prompt }: { availability: ProAvailability; onChange: Change; prompt: boolean }) {
  const { t } = useTranslation();
  const { timezone } = useMarket();
  const [notice, setNotice] = useState('');
  const visits = availability.visitsOnDaysOff;
  const jobs = availability.jobsOnDaysOff;
  return (
    <>
      <p className="small" role="status">
        {notice}
      </p>
      {visits.length > 0 && (
        <section className="stack" aria-labelledby="visits-off-heading">
          <h2 id="visits-off-heading" className="h-sm">
            {t('availability.visitsTitle')}
          </h2>
          <p className="info amber" role={prompt ? 'alert' : undefined}>
            <Icon name="alert" /> <span>{t('availability.visitsIntro')}</span>
          </p>
          <ul className="stack">
            {visits.map((visit) => (
              <DayOffVisit key={visit.id} visit={visit} onChange={onChange} onNotice={setNotice} />
            ))}
          </ul>
        </section>
      )}
      {jobs.length > 0 && (
        <section className="stack" aria-labelledby="jobs-off-heading">
          <h2 id="jobs-off-heading" className="h-sm">
            {t('availability.jobsTitle')}
          </h2>
          <ul className="lgroup">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link to={`/pro/jobs/${encodeURIComponent(job.id)}`} className="lrow link-card">
                  <span className="li" aria-hidden="true">
                    <Icon name="calendar" />
                  </span>
                  <span className="grow">
                    {job.serviceName} · {dateTime(job.startsAt, timezone)}
                  </span>
                  <Icon name="chevR" />
                </Link>
              </li>
            ))}
          </ul>
          <p className="tiny muted">{t('availability.jobsHint')}</p>
        </section>
      )}
    </>
  );
}

/** The Availability page (D99): working days, hours, days off and holidays, and what falls on days off. */
export function AvailabilityPage() {
  const { t } = useTranslation();
  const api = useApi();
  const location = useLocation();
  const load = useCallback(() => api.get<{ availability: ProAvailability }>('/pro/availability'), [api]);
  const { state, reload, update } = useResource(load);
  const [prompt, setPrompt] = useState(false);
  const onChange = useCallback((next: ProAvailability) => update(() => ({ availability: next })), [update]);
  // A new day off or holiday covering plan visits: the pro is asked what to do with each one.
  const onAdded = useCallback(
    (next: ProAvailability) => {
      setPrompt(next.visitsOnDaysOff.length > 0);
      onChange(next);
    },
    [onChange],
  );

  return (
    <>
      <AppHeader title={t('availability.title')} back={backPath(location.state)} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ availability }) => (
            <div className="stack">
              <OnDaysOff availability={availability} onChange={onChange} prompt={prompt} />
              <WorkingDays availability={availability} onChange={onChange} />
              <WorkingHours availability={availability} onChange={onChange} />
              <DaysOff availability={availability} onChange={onChange} onAdded={onAdded} />
              <Holiday availability={availability} onChange={onChange} onAdded={onAdded} />
            </div>
          )}
        </ResourceState>
      </div>
    </>
  );
}
