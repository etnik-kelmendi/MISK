import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomerBooking, Offer, ProAvailability, ProJob, ProProfile } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

/** D94: the pro Jobs area keeps its promises. */

const user = () => userEvent.setup();

const availability: ProAvailability = {
  workStart: '08:00',
  workEnd: '18:00',
  workingDays: [1, 2, 3, 4, 5],
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
  workingDays: [1, 2, 3, 4, 5],
  reviewNote: null,
  payoutsEnabled: false,
  hasPayoutAccount: false,
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

const offer: Offer = {
  id: 'o1',
  bookingId: 'b9',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  serviceName: 'Hedge trimming',
  size: 'M',
  startsAt: '2026-11-06T13:00:00.000Z',
  endsAt: '2026-11-06T14:30:00.000Z',
  address: '3 Oak Avenue',
  postcode: '10115',
  notes: 'Side gate is open',
  customerName: 'Mia',
  customerRating: 5,
  distanceKm: 2.3,
  photoIds: [],
  earningsCents: 4797,
  durationMinutes: 90,
};

function job(overrides: Partial<ProJob> = {}): ProJob {
  return {
    id: 'b1',
    number: 'B-1001',
    categoryName: 'Gardening',
    problemReportedAt: null,
    problemNote: null,
    problemResolvedAt: null,
    chargeAt: null,
    status: 'on_the_way',
    serviceName: 'Lawn mowing',
    categoryId: 'cat-garden',
    size: 'M',
    address: '12 Linden Street',
    postcode: '10115',
    notes: '',
    startsAt: '2026-11-06T09:00:00.000Z',
    endsAt: '2026-11-06T10:00:00.000Z',
    createdAt: '2026-11-04T09:00:00.000Z',
    completedAt: null,
    events: [],
    photos: [],
    extras: [],
    rating: null,
    tasks: [{ key: 't0', label: 'Mow the lawn', done: false }],
    customer: { firstName: 'Sara', ratingAverage: 5, ratingCount: 3 },
    earningsCents: 3731,
    proSharePct: 82,
    unreadMessages: 0,
    openIssue: null,
    canCancel: true,
    cancelIsLate: false,
    customerRating: null,
    canRateCustomer: false,
    stopped: false,
    leaveAt: null,
    noShowWaitMinutes: 15,
    callOutFeeCents: 1500,
    payoutOn: null,
    ...overrides,
  };
}

function jobsApi(current: ProProfile) {
  const api = fakeApi(users.pro);
  api.on('GET /pro/profile', { body: { profile: current } });
  api.on('GET /pro/offers', { body: { offers: [offer] } });
  api.on('GET /pro/jobs', { body: { jobs: [] } });
  api.on('GET /pro/visits', { body: { visits: [] } });
  return api;
}

describe('Jobs page: offline automatically (D94)', () => {
  it('says the pro is offline outside their working hours, and "Go online" overrides it for today', async () => {
    const api = jobsApi({ ...profile, availability: { ...availability, onlineNow: false, autoOffline: { reason: 'outside_hours', until: null } } });
    api.on('PUT /pro/online', {
      body: { online: true, availability: { ...availability, onlineNow: true, overrideUntil: '2026-11-24T23:00:00.000Z' } },
    });
    renderAt('/pro');
    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Online for new job offers' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveTextContent('Offline');
    expect(screen.getByText('Outside your working hours · Your hours are 08:00–18:00.')).toBeInTheDocument();
    expect(screen.getByText('No new job offers come in. Accepted jobs and plan visits stay in your schedule.')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'New job request' })).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Go online' }));
    await waitFor(() => expect(api.bodies['PUT /pro/online']).toEqual({ online: true }));
    expect(await screen.findByRole('article', { name: 'New job request' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('You chose to be online until midnight, outside your usual hours.')).toBeInTheDocument();
  });

  it('names a day off and a holiday as the reason', async () => {
    jobsApi({ ...profile, availability: { ...availability, onlineNow: false, autoOffline: { reason: 'holiday', until: '2026-12-02' } } });
    const { unmount } = renderAt('/pro');
    expect(await screen.findByText('On holiday until 2 Dec 2026')).toBeInTheDocument();
    unmount();
    jobsApi({ ...profile, availability: { ...availability, onlineNow: false, autoOffline: { reason: 'day_off', until: null } } });
    renderAt('/pro');
    expect(await screen.findByText('Day off')).toBeInTheDocument();
  });

  it("shows how long an offered job takes with the rest of the offer", async () => {
    jobsApi(profile);
    renderAt('/pro');
    const card = await screen.findByRole('article', { name: 'New job request' });
    expect(within(card).getByText('Medium · 1 h 30 min')).toBeInTheDocument();
    expect(within(card).getByText('€47.97')).toBeInTheDocument();
    expect(within(card).getByText(/3 Oak Avenue, 10115 · 2.3 km from home/)).toBeInTheDocument();
    expect(within(card).getByText('Mia · ★ 5.0 customer')).toBeInTheDocument();
    expect(within(card).getByText('“Side gate is open”')).toBeInTheDocument();
    expect(within(card).getByRole('timer')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Accept job' })).toBeInTheDocument();
  });

  it('shows "You cancelled this job" while another pro is found, and closes it', async () => {
    const api = jobsApi(profile);
    api.on('GET /pro/cancellations', {
      body: {
        cancellations: [
          {
            id: 'c1',
            bookingId: 'b1',
            reason: 'vehicle',
            note: null,
            late: false,
            createdAt: '2026-11-05T09:00:00.000Z',
            serviceName: 'Lawn mowing',
            startsAt: '2026-11-06T09:00:00.000Z',
            nextProName: null,
          },
        ],
      },
    });
    api.on('POST /pro/cancellations/c1/dismiss', { status: 204 });
    renderAt('/pro');
    expect(await screen.findByRole('heading', { name: 'You cancelled this job' })).toBeInTheDocument();
    expect(screen.getByText('Reason: Vehicle problem')).toBeInTheDocument();
    expect(screen.getByText('Finding another pro. The customer was told automatically.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Close this notice' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'You cancelled this job' })).not.toBeInTheDocument());
    expect(api.calls).toContain('POST /pro/cancellations/c1/dismiss');
  });
});

describe('Job page: what happens after a report (D94)', () => {
  it('stops the job when it is unsafe: the main button gives way to a note', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/jobs/b1', {
      body: { job: job({ openIssue: { id: 'i1', reason: 'unsafe', createdAt: '2026-11-06T09:05:00.000Z' }, stopped: true }) },
    });
    renderAt('/pro/jobs/b1');
    expect(await screen.findByText('Issue reported. MISK support is on it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "I've arrived, start job" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Work is stopped because you reported it unsafe/).length).toBeGreaterThan(0);
  });

  it('waits 15 minutes after "Customer not home", then lets the pro leave with the call-out fee', async () => {
    const api = fakeApi(users.pro);
    const waiting = job({
      openIssue: { id: 'i1', reason: 'customer_not_home', createdAt: new Date().toISOString() },
      leaveAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    api.on('GET /pro/jobs/b1', { body: { job: waiting } });
    const { unmount } = renderAt('/pro/jobs/b1');
    expect(await screen.findByText(/If nobody lets you in, you can leave with the €15 call-out fee at/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Leave and get/ })).not.toBeInTheDocument();
    unmount();

    const ready = { ...waiting, leaveAt: new Date(Date.now() - 1000).toISOString() };
    api.on('GET /pro/jobs/b1', { body: { job: ready } });
    api.on('POST /pro/jobs/b1/no-show', {
      body: {
        job: job({
          status: 'cancelled',
          canCancel: false,
          earningsCents: 1500,
          noShow: { at: '2026-11-06T09:25:00.000Z', chargeCents: 1500, waitingCents: 0 },
          payoutOn: '2026-11-13',
        }),
      },
    });
    renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Leave and get the €15 call-out fee' }));
    expect(await screen.findByRole('heading', { name: 'Closed as a customer no-show' })).toBeInTheDocument();
    expect(screen.getByText('You get €15 with your payout on 13 Nov 2026. The customer was told why.')).toBeInTheDocument();
  });

  it('offers extra work or a new price for a bigger job', async () => {
    const api = fakeApi(users.pro);
    const current = job({ status: 'working', canCancel: false });
    api.on('GET /pro/jobs/b1', { body: { job: current } });
    api.on('GET /pro/jobs/b1/price-list', { body: { items: [] } });
    api.on('POST /pro/jobs/b1/issue', {
      status: 201,
      body: { job: { ...current, openIssue: { id: 'i1', reason: 'bigger_job', createdAt: '2026-11-06T09:05:00.000Z' } } },
    });
    renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Report an issue' }));
    let sheet = await screen.findByRole('dialog', { name: 'Report an on-site issue' });
    await user().click(within(sheet).getByRole('radio', { name: /Job bigger than described/ }));
    await user().click(within(sheet).getByRole('button', { name: 'Send extra work' }));
    expect(await screen.findByRole('dialog', { name: 'Add extra work' })).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /pro/jobs/b1/issue');

    await user().click(screen.getByRole('button', { name: 'Close' }));
    await user().click(await screen.findByRole('button', { name: 'Report an issue' }));
    sheet = await screen.findByRole('dialog', { name: 'Report an on-site issue' });
    await user().click(within(sheet).getByRole('radio', { name: /Job bigger than described/ }));
    await user().click(within(sheet).getByRole('button', { name: 'Ask MISK to change the price' }));
    await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/issue']).toEqual({ reason: 'bigger_job' }));
    expect(await screen.findByText('Issue reported. MISK support is on it')).toBeInTheDocument();
  });

  it('shows the earnings as Pending with the real payout day, On hold after a report, and the photos', async () => {
    const api = fakeApi(users.pro);
    const done = job({
      status: 'completed',
      canCancel: false,
      completedAt: '2026-11-06T10:00:00.000Z',
      payoutOn: '2026-11-13',
      photos: [{ id: 'p1', kind: 'completion' }],
      extras: [
        { id: 'w1', description: 'Waiting time at the door (12 min)', priceCents: 910, status: 'approved', createdAt: '2026-11-06T09:00:00.000Z', kind: 'waiting', fundedBy: 'customer' },
      ],
    });
    api.on('GET /pro/jobs/b1', { body: { job: done } });
    const { unmount } = renderAt('/pro/jobs/b1');
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(
      screen.getByText("Released 24 hours after the job if the customer doesn't report a problem, then paid out on 13 Nov 2026"),
    ).toBeInTheDocument();
    expect(screen.getByText('Waiting time at the door: +€7.46 is added to your earnings.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your photos' })).toBeInTheDocument();
    unmount();

    api.on('GET /pro/jobs/b1', { body: { job: { ...done, problemReportedAt: '2026-11-06T12:00:00.000Z' } } });
    renderAt('/pro/jobs/b1');
    expect(await screen.findByText('On hold')).toBeInTheDocument();
  });
});

// The Availability part of the Profile became its own page in D99: see ProWeekEarnings.test.tsx.
describe('Profile: availability (D94, D99)', () => {
  it('links to the Availability and Earnings pages', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', { body: { profile } });
    api.on('GET /pro/profile/overview', { body: { overview: { jobsDone: 0, documents: { expiring: 0, expired: 0, checking: 0 }, bankLast4: null, topPercent: null } } });
    renderAt('/pro/profile');
    // Availability is a row in the Profile's Work group (D100); Earnings is a tab in the pro menu (D99).
    const work = await screen.findByRole('list', { name: 'Work' });
    expect(within(work).getByRole('link', { name: /^Availability/ })).toHaveAttribute('href', '/pro/availability');
    const menu = screen.getByRole('navigation', { name: 'Pro menu' });
    expect(within(menu).getByRole('link', { name: 'Earnings' })).toHaveAttribute('href', '/pro/earnings');
  });
});

describe("the customer's Booking page (D94)", () => {
  function booking(overrides: Partial<CustomerBooking> = {}): CustomerBooking {
    return {
      id: 'b1',
      number: 'B-1001',
      categoryName: 'Gardening',
      problemReportedAt: null,
      problemNote: null,
      problemResolvedAt: null,
      chargeAt: null,
      status: 'accepted',
      serviceName: 'Lawn mowing',
      categoryId: 'cat-garden',
      size: 'M',
      address: '12 Linden Street',
      postcode: '10115',
      notes: '',
      startsAt: '2026-11-06T09:00:00.000Z',
      endsAt: '2026-11-06T10:00:00.000Z',
      createdAt: '2026-11-04T09:00:00.000Z',
      completedAt: null,
      events: [],
      photos: [],
      extras: [],
      rating: null,
      priceCents: 4550,
      feeCents: 290,
      extrasCents: 0,
      totalCents: 4840,
      paymentStatus: 'held',
      pro: { id: 'u-pro', firstName: 'Daniel', ratingAverage: 4.9, ratingCount: 12 },
      canCancel: false,
      canRate: false,
      canReportProblem: false,
      lateCancelCents: null,
      lateCancel: false,
      services: [{ id: 'svc-mow', name: 'Lawn mowing', priceCents: 4550, durationMinutes: 60 }],
      canReschedule: false,
      tip: null,
      canTip: false,
      callOutFeeCents: 1500,
      ...overrides,
    };
  }

  it('explains the call-out fee and lists paid waiting time on its own line', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: {
        booking: booking({
          status: 'working',
          extrasCents: 910,
          totalCents: 5750,
          extras: [{ id: 'w1', description: 'Waiting time at the door (12 min)', priceCents: 910, status: 'approved', createdAt: '2026-11-06T09:00:00.000Z', kind: 'waiting' }],
        }),
      },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByText(/After 15 minutes the pro can leave and a €15 call-out fee is charged/)).toBeInTheDocument();
    const price = screen.getByRole('region', { name: 'Price' });
    expect(within(price).getByText('Waiting time at the door')).toBeInTheDocument();
    expect(within(price).getByText('€9.10')).toBeInTheDocument();
    // Nothing to approve: it is not an extra work request.
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });

  it('tells the customer why the job was cancelled after a no-show', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: {
        booking: booking({
          status: 'cancelled',
          totalCents: 1500,
          paymentStatus: 'captured',
          noShow: { at: '2026-11-06T09:25:00.000Z', chargeCents: 1500, waitingCents: 0 },
        }),
      },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByRole('heading', { name: 'Your pro could not get in' })).toBeInTheDocument();
    expect(screen.getByText(/A call-out fee of €15 was charged and the rest of the held money released/)).toBeInTheDocument();
  });
});
