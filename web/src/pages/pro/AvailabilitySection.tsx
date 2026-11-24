import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { ProAvailability } from '../../api/types';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { longDate } from '../../lib/format';
import { useAction } from '../../lib/useAction';

/** Working hours run on the hour; a day can end at midnight (24:00). */
const START_OPTIONS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
const END_OPTIONS = Array.from({ length: 24 }, (_, hour) => `${String(hour + 1).padStart(2, '0')}:00`);

/** Today in the pro's browser, YYYY-MM-DD, as the earliest day a holiday can start. */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * The pro's availability in their Profile (D94): working hours, which make them offline automatically outside
 * them, and holidays. Days off are the days that are not working days, chosen with the working days.
 */
export function AvailabilitySection({ availability, onChange }: { availability: ProAvailability; onChange: (next: ProAvailability) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const hours = useAction();
  const holiday = useAction();
  const remove = useAction();
  const [start, setStart] = useState(availability.workStart);
  const [end, setEnd] = useState(availability.workEnd);
  const [savedAt, setSavedAt] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [missing, setMissing] = useState(false);
  const startOptions = START_OPTIONS.includes(start) ? START_OPTIONS : [start, ...START_OPTIONS];
  const endOptions = END_OPTIONS.includes(end) ? END_OPTIONS : [...END_OPTIONS, end];

  async function saveHours(event: FormEvent) {
    event.preventDefault();
    setSavedAt(false);
    const result = await hours.run(() => api.put<{ availability: ProAvailability }>('/pro/working-hours', { workStart: start, workEnd: end }));
    if (result) {
      onChange(result.availability);
      setSavedAt(true);
    }
  }

  async function addHoliday(event: FormEvent) {
    event.preventDefault();
    if (!from || !to) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const result = await holiday.run(() => api.post<{ availability: ProAvailability }>('/pro/holidays', { startsOn: from, endsOn: to }));
    if (result) {
      onChange(result.availability);
      setFrom('');
      setTo('');
    }
  }

  return (
    <section className="card stack" aria-labelledby="availability-heading">
      <h2 id="availability-heading" className="b">
        {t('availability.title')}
      </h2>

      <form className="stack-tight" onSubmit={saveHours} noValidate aria-labelledby="hours-heading">
        <h3 id="hours-heading" className="h-sm">
          {t('availability.hours')}
        </h3>
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
        <p className="tiny muted">{t('availability.daysOff')}</p>
        <ErrorText error={hours.error} />
        <div className="row gap8">
          <button type="submit" className="mini-btn pro-btn" disabled={hours.busy}>
            {t('availability.save')}
          </button>
          {savedAt && (
            <span className="tiny muted" role="status">
              <Icon name="check" /> {t('availability.saved')}
            </span>
          )}
        </div>
      </form>

      <div className="stack-tight">
        <h3 className="h-sm">{t('availability.holidays')}</h3>
        {availability.holidays.length === 0 ? (
          <p className="small muted">{t('availability.noHolidays')}</p>
        ) : (
          <ul className="stack-tight" aria-label={t('availability.holidays')}>
            {availability.holidays.map((entry) => {
              const range = { from: longDate(entry.startsOn, 'UTC'), to: longDate(entry.endsOn, 'UTC') };
              return (
                <li key={entry.id} className="row between">
                  <span className="small">
                    <Icon name="calendar" /> {t('availability.holidayRange', range)}
                  </span>
                  <button
                    type="button"
                    className="mini-btn"
                    aria-label={t('availability.removeHoliday', range)}
                    disabled={remove.busy}
                    onClick={() =>
                      void remove
                        .run(() => api.delete<{ availability: ProAvailability }>(`/pro/holidays/${encodeURIComponent(entry.id)}`))
                        .then((result) => result && onChange(result.availability))
                    }
                  >
                    {t('availability.remove')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <ErrorText error={remove.error} />
        <form className="stack-tight" onSubmit={addHoliday} noValidate>
          <div className="row gap8 wrap">
            <div className="field">
              <label htmlFor="holiday-from">{t('availability.from')}</label>
              <input
                id="holiday-from"
                type="date"
                min={todayKey()}
                value={from}
                aria-invalid={missing && !from}
                aria-describedby={missing ? 'holiday-missing-error' : undefined}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="holiday-to">{t('availability.to')}</label>
              <input
                id="holiday-to"
                type="date"
                min={from || todayKey()}
                value={to}
                aria-invalid={missing && !to}
                aria-describedby={missing ? 'holiday-missing-error' : undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
          </div>
          <FieldError id="holiday-missing" message={missing ? t('availability.holidayMissing') : null} />
          <p className="tiny muted">{t('availability.holidayHint')}</p>
          <ErrorText error={holiday.error} />
          <div>
            <button type="submit" className="mini-btn" disabled={holiday.busy}>
              <Icon name="plus" /> {t('availability.addHoliday')}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
