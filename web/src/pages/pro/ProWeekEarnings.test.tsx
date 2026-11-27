import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EarningItem, EarningsPage, EarningsSummary, ProAvailability, ProProfile, ProVisit, JobListItem } from '../../api/types';
import { BASE, fakeApi, renderAt, users } from '../../test/harness';
import { nextSevenDays } from './ProWeekPage';

/** D99: the pro Week, Availability and Earnings pages. */

const user = () => userEvent.setup();
const DAY = 24 * 3600 * 1000;
const TZ = 'Europe/Berlin';
/** The market's calendar day of an instant, "YYYY-MM-DD". */
const dayKeyOf = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const dayNameOf = (at: Date) => {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...options }).format(at);
  return `${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })}`;
};

const availability: ProAvailability = {
  workStart: '08:00',
  workEnd: '18:00',
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  daysOff: [],
  visitsOnDaysOff: [],
  jobsOnDaysOff: [],
  onlineNow: true,
  autoOffline: null,
  overrideUntil: null,
};

const profile: ProProfile = {
  status: 'approved',
  homePostcode: '10115',
  radiusKm: 12,
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  reviewNote: null,
  payoutsEnabled: true,
  hasPayoutAccount: true,
  jobsPaused: false,
  suspendedReason: null,
  ratingAverage: 4.9,
  ratingCount: 12,
  trades: ['cat-garden'],
  tradeNames: ['Gardening'],
  online: true,
  offersPausedUntil: null,
  documents: { id: null, certificate: null, insurance: null, background: null },
  availability,
};

const summary: EarningsSummary = {
  readyCents: 12000,
  pendingCents: 4550,
  paidThisMonthCents: 61200,
  nextPayoutOn: '2026-11-27',
  interval: 'weekly',
  bankLast4: '3000',
};

function jobAt(id: string, at: Date, earningsCents: number): JobListItem {
  return {
    id,
    status: 'accepted',
    serviceName: 'Hedge trimming',
    startsAt: at.toISOString(),
    endsAt: new Date(at.getTime() + 3600 * 1000).toISOString(),
    address: '3 Oak Avenue',
    postcode: '10115',
    earningsCents,
  };
}

function visitAt(id: string, at: Date, earningsCents: number): ProVisit {
  return {
    id,
    subscriptionId: 'sub-1',
    startsAt: at.toISOString(),
    endsAt: new Date(at.getTime() + 3600 * 1000).toISOString(),
    status: 'planned',
    tasksDone: [],
    tasks: ['Mow'],
    planName: 'Lawn care plan',
    address: '8 Elm Court',
    postcode: '10115',
    notes: '',
    customerName: 'Lena',
    earningsCents,
  };
}

describe('My week (D99)', () => {
  function weekApi(current: ProProfile = profile) {
    const now = new Date();
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', { body: { profile: current } });
    api.on('GET /pro/jobs', { body: { jobs: [jobAt('j1', now, 4797)] } });
    api.on('GET /pro/visits', { body: { visits: [visitAt('v1', now, 3500), visitAt('v2', new Date(now.getTime() + 2 * DAY), 3500)] } });
    api.on('GET /pro/plans', { body: { plans: [] } });
    api.on('GET /pro/earnings/summary', { body: { summary } });
    api.on('GET /pro/availability', { body: { availability: current.availability } });
    api.on('PUT /pro/online', { body: { online: false, availability: { ...availability, onlineNow: false } } });
    return { api, now };
  }

  it('shows the online switch, the week totals and a bar per day, and lists the chosen day with plan and one-off edges', async () => {
    const { api, now } = weekApi();
    renderAt('/pro/week');
    const header = await screen.findByRole('banner');
    expect(within(header).getByRole('heading', { name: 'My week' })).toBeInTheDocument();
    expect(await within(header).findByText('€117.97')).toBeInTheDocument();
    expect(within(header).getByText('This week')).toBeInTheDocument();
    expect(within(header).getByText('Recurring visits').nextElementSibling).toHaveTextContent('2');

    // The same switch as on Jobs.
    const toggle = within(header).getByRole('switch', { name: 'Online for new job offers' });
    await user().click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(api.bodies['PUT /pro/online']).toEqual({ online: false });

    const today = screen.getByRole('button', { name: '€82.97 Today' });
    expect(today).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { pressed: false }).filter((b) => b.classList.contains('bcol'))).toHaveLength(6);
    // The heading names the date, also for today.
    expect(screen.getByRole('heading', { name: `Today, ${dayNameOf(now)} · 2 jobs` })).toBeInTheDocument();
    const oneOff = screen.getByRole('link', { name: /Hedge trimming/ });
    expect(oneOff).toHaveClass('one');
    expect(within(oneOff).getByText('One-off')).toBeInTheDocument();
    expect(within(oneOff).getByText('3 Oak Avenue')).toBeInTheDocument();
    expect(within(oneOff).getByText('€47.97')).toBeInTheDocument();
    const plan = screen.getByRole('link', { name: /Lawn care plan/ });
    expect(plan).toHaveClass('rec');
    expect(within(plan).getByText('Plan')).toBeInTheDocument();

    const later = new Date(now.getTime() + 2 * DAY);
    await user().click(screen.getByRole('button', { name: `€35 ${dayNameOf(later)}` }));
    expect(screen.getByRole('button', { name: `€35 ${dayNameOf(later)}` })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: `${dayNameOf(later)} · 1 job` })).toBeInTheDocument();

    const empty = new Date(now.getTime() + DAY);
    await user().click(screen.getByRole('button', { name: dayNameOf(empty) }));
    expect(screen.getByRole('heading', { name: `${dayNameOf(empty)} · 0 jobs` })).toBeInTheDocument();
    expect(screen.getByText('Day off')).toBeInTheDocument();
  });

  it('marks a day off set in Availability, shows the holiday banner, and links the Availability and payout cards', async () => {
    const now = new Date();
    const off = new Date(now.getTime() + 3 * DAY);
    weekApi({
      ...profile,
      availability: {
        ...availability,
        workingDays: [1, 2, 3, 4, 5],
        daysOff: [{ id: 'd1', day: dayKeyOf(off) }],
        holidays: [{ id: 'h1', startsOn: '2026-12-20', endsOn: '2026-12-24' }],
      },
    });
    renderAt('/pro/week');
    expect(await screen.findByText('Holiday: 20 Dec 2026 – 24 Dec 2026.')).toBeInTheDocument();
    expect(screen.getByText(/No new offers then\./)).toBeInTheDocument();

    const card = screen.getByRole('link', { name: /Availability/ });
    expect(card).toHaveAttribute('href', '/pro/availability');
    expect(card).toHaveTextContent('Mon, Tue, Wed, Thu, Fri · 08:00–18:00 · 1 day off');

    const payout = await screen.findByRole('link', { name: /Next payout/ });
    expect(payout).toHaveAttribute('href', '/pro/earnings');
    expect(payout).toHaveTextContent('Next payout: 27 Nov 2026');
    expect(payout).toHaveTextContent('€120 ready · €45.50 pending · to •••• 3000');

    await user().click(await screen.findByRole('button', { name: dayNameOf(off) }));
    const heading = screen.getByRole('heading', { name: new RegExp(`^${dayNameOf(off)} · 0 jobs`) });
    expect(within(heading).getByText('Day off')).toBeInTheDocument();

    // The Availability page opened from the card goes back to My week.
    await user().click(card);
    const back = await screen.findByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/pro/week');
  });

  it('counts the 7 days on the calendar, so a clock change neither skips nor repeats a day', () => {
    // Saturday 27 March 2027, 23:30 in Berlin; the clocks go forward that night.
    const keys = nextSevenDays(new Date('2027-03-27T22:30:00.000Z'), TZ).map((iso) => dayKeyOf(new Date(iso)));
    expect(keys).toEqual(['2027-03-27', '2027-03-28', '2027-03-29', '2027-03-30', '2027-03-31', '2027-04-01', '2027-04-02']);
  });
});

describe('Availability (D99)', () => {
  const visit = {
    id: 'v9',
    startsAt: '2026-12-16T09:00:00.000Z',
    planName: 'Lawn care',
    customerName: 'Sara',
    address: '12 Linden Street',
    teamAsked: false,
  };

  function availabilityApi(current: ProAvailability = availability) {
    const api = fakeApi(users.pro);
    api.on('GET /pro/availability', { body: { availability: current } });
    return api;
  }

  it('switches working days on and off, keeps at least one, and saves the hours', async () => {
    const api = availabilityApi({ ...availability, workingDays: [1, 2, 3, 4, 5] });
    api.on('PUT /pro/working-days', { body: { availability: { ...availability, workingDays: [1, 2, 3, 4, 5, 6] } } });
    api.on('PUT /pro/working-hours', { body: { availability: { ...availability, workStart: '07:00', workEnd: '20:00' } } });
    renderAt('/pro/availability');
    const days = await screen.findByRole('group', { name: 'Working days' });
    expect(within(days).getAllByRole('button')).toHaveLength(7);
    expect(within(days).getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    const saturday = within(days).getByRole('button', { name: 'Saturday' });
    expect(saturday).toHaveAttribute('aria-pressed', 'false');
    await user().click(saturday);
    await waitFor(() => expect(saturday).toHaveAttribute('aria-pressed', 'true'));
    expect(api.bodies['PUT /pro/working-days']).toEqual({ workingDays: [1, 2, 3, 4, 5, 6] });

    await user().selectOptions(screen.getByLabelText('Start'), '07:00');
    await user().selectOptions(screen.getByLabelText('Finish'), '20:00');
    await user().click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() => expect(api.bodies['PUT /pro/working-hours']).toEqual({ workStart: '07:00', workEnd: '20:00' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Changes only affect new offers. Jobs and plan visits you already have stay.')).toBeInTheDocument();
  });

  it('never saves a week without working days', async () => {
    const api = availabilityApi({ ...availability, workingDays: [1] });
    renderAt('/pro/availability');
    await user().click(await screen.findByRole('button', { name: 'Monday' }));
    expect(await screen.findByText('Keep at least one working day.')).toBeInTheDocument();
    expect(api.calls).not.toContain('PUT /pro/working-days');
  });

  it('adds and removes days off, then asks what to do with a plan visit on it: move it or give it away', async () => {
    const api = availabilityApi({ ...availability, daysOff: [{ id: 'd1', day: '2026-12-03' }] });
    api.on('DELETE /pro/days-off/d1', { body: { availability } });
    const withVisit = { ...availability, daysOff: [{ id: 'd2', day: '2026-12-16' }], visitsOnDaysOff: [visit] };
    api.on('POST /pro/days-off', { status: 201, body: { availability: withVisit } });
    api.on('GET /pro/visits/v9/move-days', {
      body: { days: [{ startsAt: '2026-12-17T09:00:00.000Z', endsAt: '2026-12-17T10:00:00.000Z' }] },
    });
    api.on('POST /pro/visits/v9/move', { body: { availability: { ...withVisit, visitsOnDaysOff: [] } } });
    renderAt('/pro/availability');

    await user().click(await screen.findByRole('button', { name: 'Remove the day off Thu 3 Dec 2026' }));
    await waitFor(() => expect(api.calls).toContain('DELETE /pro/days-off/d1'));
    expect(await screen.findByText('No days off planned.')).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Add a day off' }));
    await user().click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Choose a day.')).toBeInTheDocument();
    await user().type(screen.getByLabelText('Day off'), '2026-12-16');
    await user().click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.bodies['POST /pro/days-off']).toEqual({ day: '2026-12-16' }));

    const prompt = await screen.findByRole('region', { name: 'Plan visits on your days off' });
    expect(within(prompt).getByRole('alert')).toHaveTextContent('Move each visit to another day this week, or give it to another pro.');
    const item = within(prompt).getByRole('listitem', { name: 'Lawn care · Sara' });
    await user().click(within(item).getByRole('button', { name: 'Move it' }));
    await user().click(await within(item).findByRole('radio', { name: 'Thu 17 Dec, 10:00' }));
    await user().click(within(item).getByRole('button', { name: 'Move here' }));
    await waitFor(() => expect(api.bodies['POST /pro/visits/v9/move']).toEqual({ startsAt: '2026-12-17T09:00:00.000Z' }));
    expect(await screen.findByText('Moved to Thu 17 Dec, 10:00. Sara is told.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Plan visits on your days off' })).not.toBeInTheDocument();
  });

  it('gives a visit to a stand-in, or tells the pro the team is on it, and lists accepted jobs that stay', async () => {
    const api = availabilityApi({
      ...availability,
      visitsOnDaysOff: [visit, { ...visit, id: 'v10', startsAt: '2026-12-16T13:00:00.000Z' }],
      jobsOnDaysOff: [{ id: 'b7', startsAt: '2026-12-16T15:00:00.000Z', serviceName: 'Hedge trimming' }],
    });
    api.on('POST /pro/visits/v9/hand-over', {
      body: { outcome: 'reassigned', standInName: 'Leon', availability: { ...availability, visitsOnDaysOff: [{ ...visit, id: 'v10' }] } },
    });
    api.on('POST /pro/visits/v10/hand-over', {
      body: { outcome: 'team_asked', availability: { ...availability, visitsOnDaysOff: [{ ...visit, id: 'v10', teamAsked: true }] } },
    });
    renderAt('/pro/availability');

    const jobs = await screen.findByRole('region', { name: 'You still have these jobs on your days off' });
    expect(within(jobs).getByRole('link', { name: /Hedge trimming/ })).toHaveAttribute('href', '/pro/jobs/b7');

    const items = screen.getAllByRole('listitem', { name: 'Lawn care · Sara' });
    await user().click(within(items[0] as HTMLElement).getByRole('button', { name: 'Give to another pro' }));
    expect(await screen.findByText('Leon does this visit. Sara is told.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('listitem', { name: 'Lawn care · Sara' })).toHaveLength(1));
    await user().click(screen.getByRole('button', { name: 'Give to another pro' }));
    expect(await screen.findByText('No other pro is free then. The MISK team is finding someone and will tell you.')).toBeInTheDocument();
    expect(await screen.findByText('MISK is finding a stand-in')).toBeInTheDocument();
  });

  it('goes back to the Profile when not opened from My week', async () => {
    availabilityApi();
    renderAt('/pro/availability');
    expect(await screen.findByRole('link', { name: 'Back' })).toHaveAttribute('href', '/pro/profile');
  });

  it('refuses a holiday whose last day is before its first day', async () => {
    const api = availabilityApi();
    renderAt('/pro/availability');
    await user().click(await screen.findByRole('switch', { name: /I'm going on holiday/ }));
    await user().type(screen.getByLabelText('First day'), '2026-12-10');
    await user().type(screen.getByLabelText('Last day'), '2026-12-05');
    await user().click(screen.getByRole('button', { name: 'Save holiday' }));
    expect(screen.getByText("The last day can't be before the first day.")).toBeInTheDocument();
    expect(screen.getByLabelText('Last day')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).not.toContain('POST /pro/holidays');
  });

  it('turns "I\'m going on holiday" on with a first and last day, and off again', async () => {
    const api = availabilityApi();
    const holiday = { id: 'h1', startsOn: '2026-12-01', endsOn: '2026-12-05' };
    api.on('POST /pro/holidays', { status: 201, body: { availability: { ...availability, holidays: [holiday] } } });
    api.on('DELETE /pro/holidays', { body: { availability } });
    renderAt('/pro/availability');

    const toggle = await screen.findByRole('switch', { name: /I'm going on holiday/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveTextContent('Block a whole period');
    await user().click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user().click(screen.getByRole('button', { name: 'Save holiday' }));
    expect(screen.getByText('Choose the first and the last day.')).toBeInTheDocument();
    await user().type(screen.getByLabelText('First day'), '2026-12-01');
    await user().type(screen.getByLabelText('Last day'), '2026-12-05');
    await user().click(screen.getByRole('button', { name: 'Save holiday' }));
    await waitFor(() => expect(api.bodies['POST /pro/holidays']).toEqual({ startsOn: '2026-12-01', endsOn: '2026-12-05' }));
    await waitFor(() => expect(toggle).toHaveTextContent('1 Dec 2026 – 5 Dec 2026'));
    expect(screen.getByText(/No offers during your holiday\./)).toBeInTheDocument();

    await user().click(toggle);
    await waitFor(() => expect(api.calls).toContain('DELETE /pro/holidays'));
    expect(await screen.findByText('Holiday removed. Offers come in again.')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

describe('Earnings (D99)', () => {
  const oneOff: EarningItem = {
    kind: 'job',
    id: 'b1',
    date: '2026-11-24T09:00:00.000Z',
    title: 'Hedge trimming',
    customerName: 'Teuta',
    status: 'pending',
    youGetCents: 4100,
    breakdown: {
      type: 'job',
      lines: [
        { kind: 'job', label: 'Hedge trimming', cents: 4500 },
        { kind: 'extra', label: 'Extra 30 minutes of work', cents: 500 },
      ],
      commissionPct: 18,
      commissionCents: 900,
      tipCents: 410,
    },
  };
  const planVisit: EarningItem = {
    kind: 'visit',
    id: 'v1',
    date: '2026-11-23T09:00:00.000Z',
    title: 'Lawn care plan',
    customerName: 'Lena',
    status: 'ready',
    youGetCents: 3500,
    breakdown: null,
  };
  const page = (items: EarningItem[], hasMore = false): EarningsPage => ({
    items,
    hasMore,
    summary,
    payouts: [{ id: 'p1', paidOn: '2026-11-21', amountCents: 61200, bankLast4: '1183' }],
  });

  it('shows Ready, Pending and Paid, the statement, each job with its breakdown and status, and past payouts', async () => {
    const api = fakeApi(users.pro);
    const held: EarningItem = {
      ...oneOff,
      id: 'b2',
      title: 'Garden clean-up',
      status: 'on_hold',
      breakdown: oneOff.breakdown && { ...oneOff.breakdown, tipCents: 0 },
    };
    const paid: EarningItem = { ...planVisit, id: 'v2', status: 'paid' };
    api.on('GET /pro/earnings', ({ url }) => ({
      body: url.searchParams.get('offset') ? page([paid]) : page([oneOff, planVisit, held], true),
    }));
    renderAt('/pro/earnings');

    const header = await screen.findByRole('banner');
    expect(within(header).getByRole('heading', { name: 'Earnings' })).toBeInTheDocument();
    expect(await within(header).findByText('€120')).toBeInTheDocument();
    expect(within(header).getByText('paid 27 Nov 2026')).toBeInTheDocument();
    expect(within(header).getByText('€45.50')).toBeInTheDocument();
    expect(within(header).getByText('24 h review')).toBeInTheDocument();
    expect(within(header).getByText('€612')).toBeInTheDocument();
    expect(within(header).getByText('this month')).toBeInTheDocument();
    const statement = within(header).getByRole('link', { name: "Download this month's statement (PDF)" });
    expect(statement).toHaveAttribute('href', `${BASE}/pro/earnings/statement`);
    expect(statement).toHaveAttribute('download');
    expect(statement).toHaveTextContent('Statement');

    const list = screen.getByRole('list', { name: 'Your earnings' });
    const job = within(list).getByRole('listitem', { name: 'Hedge trimming' }) as HTMLElement;
    expect(job).toHaveTextContent('24 Nov 2026 · Teuta');
    expect(job).toHaveTextContent('Pending');
    for (const text of ['Job €45', 'Extra 30 minutes of work €5', 'MISK 18% −€9', 'Tip +€4.10', 'You get €41']) {
      expect(within(job).getByText(text)).toBeInTheDocument();
    }
    const visit = within(list).getByRole('listitem', { name: 'Lawn care plan' });
    expect(within(visit).getByText('Plan visit · fixed payout per visit')).toBeInTheDocument();
    expect(within(visit).getByText('Ready')).toBeInTheDocument();
    expect(within(list).getByText('On hold')).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Show more' }));
    expect(await within(list).findByText('Paid')).toBeInTheDocument();

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent ===
            'Pending: the customer has 24 hours to check the work. Ready: goes out in the next payout. Paid: sent to your bank',
      ),
    ).toBeInTheDocument();
    const payouts = screen.getByRole('region', { name: 'Payouts' });
    expect(within(payouts).getByText('€612')).toBeInTheDocument();
    expect(within(payouts).getByText('21 Nov 2026 · to •••• 1183')).toBeInTheDocument();
    expect(within(payouts).getByText('Paid')).toBeInTheDocument();
  });

  it('filters by All, Pending, Ready and Paid', async () => {
    const api = fakeApi(users.pro);
    const asked: string[] = [];
    api.on('GET /pro/earnings', ({ url }) => {
      const status = url.searchParams.get('status') ?? 'all';
      asked.push(status);
      return { body: page(status === 'ready' ? [planVisit] : [oneOff, planVisit]) };
    });
    renderAt('/pro/earnings');
    const filters = await screen.findByRole('group', { name: 'Show earnings' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'Pending', 'Ready', 'Paid']);
    expect(within(filters).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await screen.findByRole('listitem', { name: 'Hedge trimming' });

    await user().click(within(filters).getByRole('button', { name: 'Ready' }));
    expect(within(filters).getByRole('button', { name: 'Ready' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Hedge trimming' })).not.toBeInTheDocument());
    expect(screen.getByRole('listitem', { name: 'Lawn care plan' })).toBeInTheDocument();
    expect(asked).toEqual(['all', 'ready']);
  });

  it('shows a visit a stand-in did as "Done by a stand-in · not paid to you", without an amount', async () => {
    const api = fakeApi(users.pro);
    const standIn: EarningItem = { ...planVisit, id: 'v7', kind: 'stand_in', status: 'stand_in', youGetCents: 0 };
    api.on('GET /pro/earnings', { body: page([standIn]) });
    renderAt('/pro/earnings');
    const item = await screen.findByRole('listitem', { name: 'Lawn care plan' });
    expect(within(item).getByText('Done by a stand-in · not paid to you')).toBeInTheDocument();
    expect(within(item).getByText('Stand-in')).toBeInTheDocument();
    expect(item).not.toHaveTextContent('€');
  });

  it('is a tab of the pro app, between Week and Messages', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/earnings', { body: page([]) });
    renderAt('/pro/earnings');
    const menu = await screen.findByRole('navigation', { name: 'Pro menu' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Jobs', 'Week', 'Earnings', 'Messages', 'Profile']);
    expect(await screen.findByText('Nothing here right now.')).toBeInTheDocument();
  });
});
