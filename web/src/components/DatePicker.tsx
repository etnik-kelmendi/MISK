import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookingRange, ServiceDay } from '../api/types';
import { addDays, addMonths, formatDay, isoWeekday, longDayName, monthName, monthOf, monthWeeks, WEEKDAYS } from '../lib/calendar';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/** Days a customer may pick: from today to the last bookable day of the booking horizon (D101). */
export type DayRange = Pick<BookingRange, 'today' | 'lastDay'>;

/** Loads which days of a month ("YYYY-MM") have a pro working, for greying out the others. */
export type MonthLoader = (month: string) => Promise<ServiceDay[]>;

type MonthState = { month: string; status: 'loading' } | { month: string; status: 'ready'; open: Map<string, boolean> } | { month: string; status: 'error' };

/**
 * The month calendar of the date picker (D101), in a sheet: weekday headers, a button per day, and the previous
 * and next month within today to the last bookable day. Days outside that range, and days without a pro
 * working (from `loadMonth`), cannot be chosen. Arrow keys move a day or a week, Home and End to the start and
 * end of the week, Page Up and Page Down a month, Enter chooses, Esc closes; the focus then goes back to the
 * button that opened it.
 */
export function CalendarSheet({
  selected,
  range,
  loadMonth,
  onSelect,
  onClose,
}: {
  selected: string;
  range: DayRange;
  loadMonth?: MonthLoader;
  onSelect: (day: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const clamp = (day: string) => (day < range.today ? range.today : day > range.lastDay ? range.lastDay : day);
  const [focused, setFocused] = useState(() => clamp(selected));
  const month = monthOf(focused);
  const [loaded, setLoaded] = useState<MonthState | null>(null);
  const focusedButton = useRef<HTMLButtonElement>(null);
  // Set when the keyboard moved the focus, so it follows to the new day once that day is drawn.
  const moved = useRef(false);

  useEffect(() => {
    if (!loadMonth) return;
    let current = true;
    loadMonth(month).then(
      (days) => {
        if (current) setLoaded({ month, status: 'ready', open: new Map(days.map((d) => [d.day, d.open])) });
      },
      (error: unknown) => {
        // The calendar still works without it: every day in range can be chosen.
        console.error('Could not load the days with pros', error);
        if (current) setLoaded({ month, status: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [loadMonth, month]);

  useEffect(() => {
    if (moved.current) {
      moved.current = false;
      focusedButton.current?.focus();
    }
  }, [focused]);

  const monthState = loaded?.month === month ? loaded : null;
  const status = !loadMonth ? 'none' : (monthState?.status ?? 'loading');
  const inRange = (day: string) => day >= range.today && day <= range.lastDay;
  /** A day can be chosen when it is in range and not known to be without pros. */
  const choosable = (day: string) => inRange(day) && !(monthState?.status === 'ready' && monthState.open.get(day) === false);

  function moveTo(day: string) {
    moved.current = true;
    setFocused(clamp(day));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const steps: Record<string, () => string> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      Home: () => addDays(day, 1 - isoWeekday(day)),
      End: () => addDays(day, 7 - isoWeekday(day)),
      PageUp: () => addMonthsKeepingDay(day, -1),
      PageDown: () => addMonthsKeepingDay(day, 1),
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    moveTo(step());
  }

  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);
  const headingId = `calendar-month-${month}`;

  return (
    <Sheet title={t('datePicker.title')} closeLabel={t('datePicker.close')} onClose={onClose} initialFocus={focusedButton}>
      <div className="cal-head">
        <button
          type="button"
          className="iconbtn"
          aria-label={t('datePicker.previousMonth')}
          disabled={previous < monthOf(range.today)}
          onClick={() => setFocused(clamp(`${previous}-01`))}
        >
          <Icon name="chevL" />
        </button>
        <h3 id={headingId} className="cal-month grow" aria-live="polite">
          {monthName(month)}
        </h3>
        <button
          type="button"
          className="iconbtn"
          aria-label={t('datePicker.nextMonth')}
          disabled={next > monthOf(range.lastDay)}
          onClick={() => setFocused(clamp(`${next}-01`))}
        >
          <Icon name="chevR" />
        </button>
      </div>
      <table className="cal" role="grid" aria-labelledby={headingId}>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday.long} scope="col" abbr={weekday.long}>
                {weekday.short.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(month).map((week) => (
            <tr key={week.find(Boolean) ?? month}>
              {week.map((day, index) => {
                if (!day) return <td key={`empty-${index}`} />;
                const canChoose = choosable(day);
                const reason = !inRange(day) ? t('datePicker.outOfRange') : !canChoose ? t('datePicker.noPros') : '';
                const name = `${formatDay(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${reason ? `, ${reason}` : ''}`;
                const isSelected = day === selected;
                return (
                  <td key={day}>
                    <button
                      ref={day === focused ? focusedButton : undefined}
                      type="button"
                      className={`cal-day ${isSelected ? 'on' : ''} ${day === range.today ? 'today' : ''}`}
                      tabIndex={day === focused ? 0 : -1}
                      aria-label={name}
                      aria-pressed={isSelected}
                      aria-current={day === range.today ? 'date' : undefined}
                      aria-disabled={!canChoose}
                      onFocus={() => setFocused(day)}
                      onKeyDown={(event) => onKeyDown(event, day)}
                      onClick={() => {
                        if (canChoose) onSelect(day);
                      }}
                    >
                      {Number(day.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny muted cal-note" role="status">
        {status === 'loading' ? t('datePicker.checking') : status === 'error' ? t('datePicker.checkFailed') : t('datePicker.hint', { day: longDayName(range.lastDay) })}
      </p>
    </Sheet>
  );
}

/** The same day of the month `count` months on, or that month's last day when it is shorter. */
function addMonthsKeepingDay(day: string, count: number): string {
  const month = addMonths(monthOf(day), count);
  const wanted = Number(day.slice(8));
  const last = Number(addDays(`${addMonths(month, 1)}-01`, -1).slice(8));
  return `${month}-${String(Math.min(wanted, last)).padStart(2, '0')}`;
}

/**
 * The days above the times (D74, D101): the month, earlier and later week buttons, a "Pick a date" button that
 * opens the month calendar, the week's day buttons with the chosen one highlighted, and the chosen day in full.
 */
export function DateBar({
  days,
  selected,
  range,
  weekFrom,
  pending = false,
  loadMonth,
  onSelect,
  onWeek,
}: {
  /** The days of the loaded week that have times, "YYYY-MM-DD". */
  days: string[];
  selected: string;
  range: DayRange;
  /** The first day of the loaded week. */
  weekFrom: string;
  /** A week is loading: its day buttons are not drawn yet. */
  pending?: boolean;
  loadMonth?: MonthLoader;
  onSelect: (day: string) => void;
  onWeek: (from: string) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const earlier = weekFrom <= range.today ? null : addDays(weekFrom, -7) < range.today ? range.today : addDays(weekFrom, -7);
  const later = addDays(weekFrom, 7) > range.lastDay ? null : addDays(weekFrom, 7);

  return (
    <>
      <div className="datebar-head">
        <h2 className="h-sm grow">{monthName(monthOf(selected))}</h2>
        <button type="button" className="iconbtn small-icon" aria-label={t('datePicker.earlierWeek')} disabled={!earlier} onClick={() => earlier && onWeek(earlier)}>
          <Icon name="chevL" />
        </button>
        <button type="button" className="iconbtn small-icon" aria-label={t('datePicker.laterWeek')} disabled={!later} onClick={() => later && onWeek(later)}>
          <Icon name="chevR" />
        </button>
        <button type="button" className="mini-btn" aria-haspopup="dialog" onClick={() => setPicking(true)}>
          <Icon name="calendar" /> {t('datePicker.pick')}
        </button>
      </div>
      {pending ? (
        <p className="muted center" role="status">
          {t('common.loading')}
        </p>
      ) : (
        <div className="days days-fit" role="group" aria-label={t('book.day')}>
          {days.map((d) => (
            <button key={d} type="button" className={`day ${d === selected ? 'on' : ''}`} aria-pressed={d === selected} onClick={() => onSelect(d)}>
              <span className="dn">{formatDay(d, { weekday: 'short' })}</span>
              <span className="dd">{Number(d.slice(8))}</span>
            </button>
          ))}
        </div>
      )}
      <p className="chosen-day" aria-live="polite">
        {longDayName(selected)}
      </p>
      {picking && (
        <CalendarSheet
          selected={selected}
          range={range}
          {...(loadMonth ? { loadMonth } : {})}
          onClose={() => setPicking(false)}
          onSelect={(day) => {
            setPicking(false);
            onSelect(day);
          }}
        />
      )}
    </>
  );
}
