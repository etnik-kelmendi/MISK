import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomerBooking } from '../../api/types';
import { addDays, formatDay, longDayName, monthName, monthOf, weekStart } from '../../lib/calendar';
import { fakeApi, renderAt, users } from '../../test/harness';

/**
 * Choose time with the date picker (D101). Every date is counted from the real today in Berlin, so the tests
 * do not depend on the day they run.
 */

const user = () => userEvent.setup();
const TZ = 'Europe/Berlin';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const ahead = (days: number) => addDays(today, days);
const LAST_DAY = ahead(59);

/** The moment it is `hour`:00 in Berlin on `day`. */
function at(day: string, hour: number): string {
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8)), hour);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess))
      .map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (wall - guess)).toISOString();
}

interface FakeSlot {
  startsAt: string;
  endsAt: string;
  freePros: number;
  available: boolean;
}
const slot = (day: string, hour: number, available = true): FakeSlot => ({
  startsAt: at(day, hour),
  endsAt: at(day, hour + 1),
  freePros: available ? 2 : 0,
  available,
});

/** A week of times like the API's: 08:00 is full on `fullDay`, the other times free. */
function week(from: string, fullDay?: string): FakeSlot[] {
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index)).filter((d) => d <= LAST_DAY);
  return days.flatMap((d) => [slot(d, 8, d !== fullDay), slot(d, 10), slot(d, 14)]);
}

/** Wednesday 14 January 2026, as a calendar day button names it. */
const calendarName = (day: string) => formatDay(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function setUp(options: { waitlist?: object[]; held?: object[]; fullDay?: string; closed?: string[] } = {}) {
  const api = fakeApi(users.customer);
  const weeks: (string | null)[] = [];
  const months: string[] = [];
  const bookingIds: (string | null)[] = [];
  api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
  api.on('GET /bookings', { body: { bookings: [] } });
  api.on('GET /availability', ({ url }) => {
    const from = url.searchParams.get('from');
    weeks.push(from);
    bookingIds.push(url.searchParams.get('bookingId'));
    expect(url.searchParams.get('days')).toBe(from ? '7' : null);
    const start = from ?? today;
    return {
      body: {
        slots: week(start, options.fullDay),
        waitlist: options.waitlist ?? [],
        held: options.held ?? [],
        range: { today, lastDay: LAST_DAY, horizonDays: 60 },
        window: { from: start, days: 7 },
      },
    };
  });
  api.on('GET /availability/calendar', ({ url }) => {
    const month = url.searchParams.get('month') ?? '';
    months.push(month);
    const days: { day: string; open: boolean }[] = [];
    for (let d = `${month}-01`; monthOf(d) === month; d = addDays(d, 1)) {
      if (d >= today && d <= LAST_DAY) days.push({ day: d, open: !(options.closed ?? []).includes(d) });
    }
    return { body: { range: { today, lastDay: LAST_DAY, horizonDays: 60 }, month, days } };
  });
  return { api, weeks, months, bookingIds };
}

async function toTimeStep() {
  renderAt('/book?services=svc-mow');
  await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
  await user().type(await screen.findByLabelText('Postcode'), '10115');
  await user().click(screen.getByRole('button', { name: /Continue · / }));
  await screen.findByRole('group', { name: 'Day' });
}

/** Opens the calendar and moves to the month of `day` with the next-month button. */
async function openCalendarAt(day: string) {
  await user().click(screen.getByRole('button', { name: 'Pick a date' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pick a date' });
  while (!within(dialog).queryByRole('heading', { name: monthName(monthOf(day)) })) {
    await user().click(within(dialog).getByRole('button', { name: 'Next month' }));
  }
  return dialog;
}

const stripDays = () => within(screen.getByRole('group', { name: 'Day' })).getAllByRole('button');

describe('Choose time: the date picker (D101)', () => {
  it('keeps a week of day buttons and opens a month calendar limited to the bookable days', async () => {
    setUp();
    await toTimeStep();
    expect(stripDays()).toHaveLength(7);
    expect(stripDays()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(longDayName(today))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Earlier days' })).toBeDisabled();

    const opener = screen.getByRole('button', { name: 'Pick a date' });
    await user().click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Pick a date' });
    expect(within(dialog).getByRole('heading', { name: monthName(monthOf(today)) })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    // The chosen day has the focus, and is marked as chosen and as today.
    const chosen = within(dialog).getByRole('button', { name: calendarName(today) });
    expect(chosen).toHaveFocus();
    expect(chosen).toHaveAttribute('aria-pressed', 'true');
    expect(chosen).toHaveAttribute('aria-current', 'date');
    if (monthOf(ahead(-1)) === monthOf(today)) {
      expect(within(dialog).getByRole('button', { name: `${calendarName(ahead(-1))}, can't be booked` })).toHaveAttribute('aria-disabled', 'true');
    }
    expect(within(dialog).getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(await within(dialog).findByText(/You can book up to/)).toBeInTheDocument();

    // The next month button stops at the month of the last bookable day.
    let months = 0;
    while (within(dialog).getByRole('button', { name: 'Next month' }).hasAttribute('disabled') === false) {
      await user().click(within(dialog).getByRole('button', { name: 'Next month' }));
      months += 1;
    }
    expect(within(dialog).getByRole('heading', { name: monthName(monthOf(LAST_DAY)) })).toBeInTheDocument();
    expect(months).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByRole('button', { name: calendarName(LAST_DAY) })).toHaveAttribute('aria-disabled', 'false');
    if (monthOf(ahead(60)) === monthOf(LAST_DAY)) {
      expect(within(dialog).getByRole('button', { name: `${calendarName(ahead(60))}, can't be booked` })).toHaveAttribute('aria-disabled', 'true');
    }

    // Esc closes it, and the focus goes back to the button that opened it.
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('moves between days with the arrow keys and chooses one with Enter', async () => {
    const { weeks } = setUp();
    await toTimeStep();
    await user().click(screen.getByRole('button', { name: 'Pick a date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick a date' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: calendarName(today) })).toHaveFocus());
    await user().keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('button', { name: calendarName(ahead(1)) })).toHaveFocus();
    await user().keyboard('{ArrowDown}{ArrowDown}');
    expect(within(dialog).getByRole('button', { name: calendarName(ahead(15)) })).toHaveFocus();
    await user().keyboard('{ArrowUp}{ArrowLeft}');
    expect(within(dialog).getByRole('button', { name: calendarName(ahead(7)) })).toHaveFocus();
    // Before today the focus stops at today.
    await user().keyboard('{ArrowUp}{ArrowUp}');
    expect(within(dialog).getByRole('button', { name: calendarName(today) })).toHaveFocus();
    await user().keyboard('{ArrowDown}{ArrowDown}{Enter}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The week with that day is loaded: weeks are counted from today.
    await waitFor(() => expect(weeks).toEqual([null, ahead(14)]));
    expect(await screen.findByText(longDayName(ahead(14)))).toBeInTheDocument();
    expect(stripDays()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Earlier days' })).toBeEnabled();
  });

  it('loads the times of a far date chosen in the calendar, and keeps Continue off until a time is chosen', async () => {
    const far = ahead(20);
    const { weeks, months } = setUp();
    await toTimeStep();
    const dialog = await openCalendarAt(far);
    await waitFor(() => expect(months).toContain(monthOf(far)));
    await user().click(within(dialog).getByRole('button', { name: calendarName(far) }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(weeks.at(-1)).toBe(weekStart(far, today)));

    expect(await screen.findByText(longDayName(far))).toBeInTheDocument();
    const pressed = stripDays().find((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveTextContent(new RegExp(`^${formatDay(far, { weekday: 'short' })}\\s*${Number(far.slice(8))}$`));
    expect(screen.getByRole('heading', { name: monthName(monthOf(far)) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select a time' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: /^10:00/ }));
    const label = `${formatDay(far, { weekday: 'short', day: 'numeric', month: 'short' })}, 10:00`;
    await user().click(screen.getByRole('button', { name: `Continue · ${label}` }));
    expect(await screen.findByRole('heading', { name: 'Review & pay' })).toBeInTheDocument();
  });

  it('books a flexible window on a far date', async () => {
    const far = ahead(30);
    setUp();
    await toTimeStep();
    const dialog = await openCalendarAt(far);
    await user().click(within(dialog).getByRole('button', { name: calendarName(far) }));
    expect(await screen.findByText(longDayName(far))).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: "I'm flexible" }));
    await user().click(screen.getByRole('button', { name: /^Afternoon/ }));
    expect(screen.getByText(/The exact time is confirmed by 18:00 the day before/)).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Continue · .+, afternoon/ }));
    expect(await screen.findByText(/afternoon · your pro picks the time by 18:00 the evening before/)).toBeInTheDocument();
  });

  it('greys out days without a pro working, which cannot be chosen', async () => {
    const closed = ahead(3);
    const { weeks } = setUp({ closed: [closed] });
    await toTimeStep();
    const dialog = await openCalendarAt(closed);
    const day = await within(dialog).findByRole('button', { name: `${calendarName(closed)}, no pro working` });
    expect(day).toHaveAttribute('aria-disabled', 'true');
    await user().click(day);
    expect(screen.getByRole('dialog', { name: 'Pick a date' })).toBeInTheDocument();
    expect(weeks).toEqual([null]);
  });
});

describe('Choose time: the waiting list on any date (D101)', () => {
  it('joins the waiting list for a full time and a whole day on a far date, and lists them', async () => {
    const far = ahead(25);
    const { api } = setUp({ fullDay: far });
    let entries = 0;
    api.on('POST /time-waitlist', ({ body }) => {
      entries += 1;
      const b = body as { day: string; startsAt?: string };
      return { status: 201, body: { entry: { id: `w${entries}`, day: b.day, startsAt: b.startsAt ?? null, notifiedAt: null } } };
    });
    api.on('DELETE /time-waitlist/w1', { status: 204 });
    await toTimeStep();
    const dialog = await openCalendarAt(far);
    await user().click(within(dialog).getByRole('button', { name: calendarName(far) }));
    expect(await screen.findByText(longDayName(far))).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: /08:00\s*Full · waiting list/ }));
    expect(api.bodies['POST /time-waitlist']).toEqual({ serviceIds: ['svc-mow'], postcode: '10115', day: far, startsAt: at(far, 8) });
    expect(await screen.findByRole('button', { name: /08:00\s*On waiting list/ })).toHaveAttribute('aria-pressed', 'true');

    await user().click(screen.getByRole('button', { name: /Join the waiting list for this day/ }));
    expect(api.bodies['POST /time-waitlist']).toEqual({ serviceIds: ['svc-mow'], postcode: '10115', day: far });
    expect(await screen.findByText('On the waiting list for this day')).toBeInTheDocument();

    const summary = screen.getByRole('region', { name: 'My waiting list' });
    const short = formatDay(far, { weekday: 'short', day: 'numeric', month: 'short' });
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`${short}, whole day`, `${short}, 08:00`]);

    // Leaving from the chip takes the time off the list, and the time shows as full again.
    await user().click(within(summary).getByRole('button', { name: `Leave the waiting list for ${short}, 08:00` }));
    expect(await screen.findByRole('button', { name: /08:00\s*Full · waiting list/ })).toHaveAttribute('aria-pressed', 'false');
    expect(api.calls).toContain('DELETE /time-waitlist/w1');
    expect(within(summary).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Select a time' })).toBeDisabled();
  });

  it('shows waiting list entries on other dates, opens their day and removes them', async () => {
    const far = ahead(30);
    const further = ahead(40);
    const { api, weeks } = setUp({
      fullDay: further,
      waitlist: [
        { id: 'w-far', day: far, startsAt: null, notifiedAt: null },
        { id: 'w-further', day: further, startsAt: at(further, 8), notifiedAt: null },
      ],
    });
    api.on('DELETE /time-waitlist/w-far', { status: 204 });
    await toTimeStep();
    const summary = screen.getByRole('region', { name: 'My waiting list' });
    const short = (day: string) => formatDay(day, { weekday: 'short', day: 'numeric', month: 'short' });
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`${short(far)}, whole day`, `${short(further)}, 08:00`]);

    await user().click(within(summary).getByRole('button', { name: `Leave the waiting list for ${short(far)}, whole day` }));
    await waitFor(() => expect(within(summary).getAllByRole('listitem')).toHaveLength(1));
    expect(api.calls).toContain('DELETE /time-waitlist/w-far');

    await user().click(within(summary).getByRole('button', { name: `Show ${short(further)}, 08:00` }));
    await waitFor(() => expect(weeks.at(-1)).toBe(weekStart(further, today)));
    expect(await screen.findByText(longDayName(further))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /08:00\s*On waiting list/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('points to a time held on a far date and shows it held there for 15 minutes', async () => {
    const far = ahead(20);
    const until = new Date(Date.now() + 15 * 60_000).toISOString();
    setUp({ held: [{ startsAt: at(far, 10), expiresAt: until }] });
    await toTimeStep();
    const summary = screen.getByRole('region', { name: 'My waiting list' });
    const when = `${formatDay(far, { weekday: 'short', day: 'numeric', month: 'short' })}, 10:00`;
    expect(within(summary).getByText(new RegExp(`${when} is free and held for you until \\d\\d:\\d\\d`))).toBeInTheDocument();
    await user().click(within(summary).getByRole('button', { name: `Show ${when}` }));
    expect(await screen.findByRole('button', { name: /^10:00\s*Held for you until \d\d:\d\d/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'My waiting list' })).not.toBeInTheDocument();
  });
});

describe('Reschedule with the date picker (D101)', () => {
  const booking = {
    id: 'b1',
    status: 'accepted',
    serviceName: 'Lawn mowing',
    postcode: '10115',
    startsAt: at(ahead(2), 10),
    endsAt: at(ahead(2), 11),
    flexibleWindow: null,
    timeConfirmed: true,
    canReschedule: true,
    services: [{ id: 'svc-mow', name: 'Lawn mowing', priceCents: 4550, durationMinutes: 60 }],
  } as unknown as CustomerBooking;

  it('moves a booking to a far date chosen in the calendar', async () => {
    const far = ahead(45);
    const { api, weeks, bookingIds } = setUp();
    api.on('GET /bookings/b1', { body: { booking } });
    api.on('POST /bookings/b1/reschedule', { body: { booking: { ...booking, startsAt: at(far, 14) } } });
    renderAt('/bookings/b1/reschedule');
    await screen.findByRole('group', { name: 'Day' });
    const dialog = await openCalendarAt(far);
    await user().click(within(dialog).getByRole('button', { name: calendarName(far) }));
    await waitFor(() => expect(weeks.at(-1)).toBe(weekStart(far, today)));
    expect(await screen.findByText(longDayName(far))).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /^14:00/ }));
    const label = `${formatDay(far, { weekday: 'short', day: 'numeric', month: 'short' })}, 14:00`;
    await user().click(screen.getByRole('button', { name: `Move to ${label}` }));
    await waitFor(() => expect(api.bodies['POST /bookings/b1/reschedule']).toEqual({ startsAt: at(far, 14) }));
    // The booking being moved does not count against its new time (D75), in every week asked for.
    expect(bookingIds.length).toBeGreaterThanOrEqual(2);
    expect(bookingIds.every((id) => id === 'b1')).toBe(true);
  });
});
