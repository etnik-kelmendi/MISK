import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BookingBase, CustomerBooking, Offer, ProJob, ProProfile } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

/** D86: the Jobs area of the pro app. */

const user = () => userEvent.setup();

const profile: ProProfile = {
  status: 'approved',
  homePostcode: '10115',
  radiusKm: 12,
  workingDays: [1, 2, 3, 4, 5],
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
    status: 'accepted',
    serviceName: 'Lawn mowing',
    categoryId: 'cat-garden',
    size: 'M',
    address: '12 Linden Street',
    postcode: '10115',
    notes: 'Gate code 4411',
    startsAt: '2026-11-06T09:00:00.000Z',
    endsAt: '2026-11-06T10:00:00.000Z',
    createdAt: '2026-11-04T09:00:00.000Z',
    completedAt: null,
    events: [{ status: 'accepted', at: '2026-11-04T09:03:00.000Z' }],
    photos: [],
    extras: [],
    rating: null,
    tasks: [
      { key: 't0', label: 'Mow the lawn', done: false },
      { key: 't1', label: 'Edge the borders', done: false },
      { key: 't2', label: 'Clear the clippings', done: false },
    ],
    customer: { firstName: 'Sara', ratingAverage: 5, ratingCount: 3 },
    earningsCents: 3731,
    proSharePct: 82,
    unreadMessages: 0,
    openIssue: null,
    canCancel: true,
    cancelIsLate: false,
    customerRating: null,
    canRateCustomer: false,
    ...overrides,
  };
}

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
  notes: '',
  customerName: 'Mia',
  customerRating: 5,
  distanceKm: 2.3,
  photoIds: [],
  earningsCents: 4797,
};

describe('Jobs page (D86)', () => {
  function jobsApi(current: ProProfile = profile) {
    const api = fakeApi(users.pro);
    let online = current.online !== false;
    api.on('GET /pro/profile', () => ({ body: { profile: { ...current, online } } }));
    api.on('PUT /pro/online', ({ body }) => {
      online = (body as { online: boolean }).online;
      return { body: { online } };
    });
    api.on('GET /pro/offers', { body: { offers: [offer] } });
    const now = new Date().toISOString();
    api.on('GET /pro/jobs', {
      body: {
        jobs: [
          { id: 'b2', status: 'accepted', serviceName: 'Garden clean-up', startsAt: now, endsAt: now, address: '2 Pine Street', postcode: '10115', earningsCents: 6400 },
          {
            id: 'b3',
            status: 'accepted',
            serviceName: 'Planting',
            startsAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
            endsAt: now,
            address: '5 Ash Road',
            postcode: '10115',
            earningsCents: 4500,
          },
        ],
      },
    });
    api.on('GET /pro/visits', { body: { visits: [] } });
    return api;
  }

  it("shows the pro's name, trade and rating with an online switch saved on the server", async () => {
    const api = jobsApi();
    renderAt('/pro');
    const header = await screen.findByRole('banner');
    await within(header).findByText(/Daniel · Gardening/);
    expect(within(header).getByRole('img', { name: 'Rated 4.9 out of 5 from 12 jobs' })).toBeInTheDocument();
    const toggle = within(header).getByRole('switch', { name: 'Online for new job offers' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveTextContent('Online');

    await user().click(toggle);
    expect(api.bodies['PUT /pro/online']).toEqual({ online: false });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(toggle).toHaveTextContent('Offline');
    expect(screen.getByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    expect(screen.getByText('No new job offers come in. Accepted jobs and plan visits stay in your schedule.')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'New job request' })).not.toBeInTheDocument();
    expect(screen.getByText("You're offline, no new job offers.")).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Go online' }));
    expect(api.bodies['PUT /pro/online']).toEqual({ online: true });
    expect(await screen.findByRole('article', { name: 'New job request' })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it("lists new offers with the customer's stars, then the rest of today linking to each job", async () => {
    jobsApi();
    renderAt('/pro');
    const card = await screen.findByRole('article', { name: 'New job request' });
    expect(within(card).getByText('Mia · ★ 5.0 customer')).toBeInTheDocument();
    expect(within(card).getByText('€47.97')).toBeInTheDocument();
    const today = await screen.findByRole('list', { name: 'Later today' });
    expect(within(today).getByRole('link', { name: /Garden clean-up/ })).toHaveAttribute('href', '/pro/jobs/b2');
    // A job on another day is in My week, not here.
    expect(within(today).queryByText('Planting')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See my week' })).toHaveAttribute('href', '/pro/week');
  });

  it('starts offline when the pro left it offline, and says when offers are paused after late cancellations', async () => {
    jobsApi({ ...profile, online: false, offersPausedUntil: '2026-11-27T10:00:00.000Z' });
    renderAt('/pro');
    expect(await screen.findByRole('heading', { name: "You're offline" })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Online for new job offers' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/New job offers are paused until .*because you cancelled 3 jobs late within 30 days/)).toBeInTheDocument();
  });
});

describe('Job page (D86)', () => {
  it('shows the job, the customer and the checklist, with one button for the next step each time', async () => {
    const api = fakeApi(users.pro);
    let current = job();
    api.on('GET /pro/jobs/b1', () => ({ body: { job: current } }));
    api.on('POST /pro/jobs/b1/status', ({ body }) => {
      current = { ...current, status: (body as { status: 'on_the_way' | 'working' }).status, canCancel: (body as { status: string }).status !== 'working' };
      return { body: { job: current } };
    });
    api.on('POST /pro/jobs/b1/tasks', ({ body }) => {
      const { key, done } = body as { key: string; done: boolean };
      current = { ...current, tasks: current.tasks?.map((task) => (task.key === key ? { ...task, done } : task)) };
      return { body: { job: current } };
    });
    api.on('POST /pro/jobs/b1/photos', () => {
      current = { ...current, photos: [{ id: 'p1', kind: 'completion' }] };
      return { status: 201, body: { job: current } };
    });
    api.on('POST /pro/jobs/b1/complete', () => {
      current = { ...current, status: 'completed', completedAt: '2026-11-06T10:00:00.000Z', canRateCustomer: true };
      return { body: { job: current } };
    });
    renderAt('/pro/jobs/b1');

    expect(await screen.findByRole('heading', { name: 'Lawn mowing' })).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Customer · ★ 5.0 · 12 Linden Street')).toBeInTheDocument();
    expect(screen.getByText('“Gate code 4411”')).toBeInTheDocument();
    // Tasks can only be ticked off once work has started.
    expect(screen.getByRole('checkbox', { name: 'Mow the lawn' })).toBeDisabled();
    expect(screen.getByText('You can tick off the tasks once you start the job.')).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Start driving' }));
    expect(api.bodies['POST /pro/jobs/b1/status']).toEqual({ status: 'on_the_way' });
    await user().click(await screen.findByRole('button', { name: "I've arrived, start job" }));
    expect(api.bodies['POST /pro/jobs/b1/status']).toEqual({ status: 'working' });

    const mow = await screen.findByRole('checkbox', { name: 'Mow the lawn' });
    await waitFor(() => expect(mow).toBeEnabled());
    await user().click(mow);
    expect(api.bodies['POST /pro/jobs/b1/tasks']).toEqual({ key: 't0', done: true });
    expect(await screen.findByText('1 of 3 done')).toBeInTheDocument();
    // Cancelling is no longer offered once work has started.
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Add photos & complete' })).toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>('.cta-bar input[type="file"]');
    if (!input) throw new Error('No photo input');
    await user().upload(input, new File(['png'], 'lawn.png', { type: 'image/png' }));
    await user().click(await screen.findByRole('button', { name: 'Complete with 1 of 3 tasks done' }));
    expect(api.calls).toContain('POST /pro/jobs/b1/complete');

    expect(await screen.findByText("You'll earn")).toBeInTheDocument();
    expect(screen.getByText('€37.31')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /See my week/ })).toHaveAttribute('href', '/pro/week');
  });

  it('lets the pro rate the customer after the job, which only MISK sees', async () => {
    const api = fakeApi(users.pro);
    const done = job({ status: 'completed', completedAt: '2026-11-06T10:00:00.000Z', canCancel: false, canRateCustomer: true });
    api.on('GET /pro/jobs/b1', { body: { job: done } });
    api.on('POST /pro/jobs/b1/customer-rating', {
      status: 201,
      body: { job: { ...done, canRateCustomer: false, customerRating: { stars: 4, tags: ['friendly'] } } },
    });
    renderAt('/pro/jobs/b1');
    const form = await screen.findByRole('form', { name: 'How was Sara as a customer?' });
    expect(within(form).getByText('Only MISK sees this. It helps match customers and pros.')).toBeInTheDocument();
    // The tags are exactly the design's, and "Send rating" does not work without stars.
    for (const tag of ['Easy access', 'Clear instructions', 'Friendly', 'Was home on time']) {
      expect(within(form).getByRole('checkbox', { name: tag })).toBeInTheDocument();
    }
    expect(within(form).getByRole('button', { name: 'Send rating' })).toBeDisabled();
    expect(api.calls).not.toContain('POST /pro/jobs/b1/customer-rating');

    await user().click(within(form).getByRole('radio', { name: '4 stars' }));
    await user().click(within(form).getByRole('checkbox', { name: 'Friendly' }));
    // The comment field is shown straight away under its one label, and is optional.
    expect(within(form).queryByText('Add comment')).not.toBeInTheDocument();
    expect(within(form).getByLabelText('Comment (optional)')).not.toBeRequired();
    await user().type(within(form).getByLabelText('Comment (optional)'), 'Lovely dog');
    await user().click(within(form).getByRole('button', { name: 'Send rating' }));
    await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/customer-rating']).toEqual({ stars: 4, tags: ['friendly'], comment: 'Lovely dog' }));
    expect(await screen.findByText('You rated Sara 4 stars. Thanks, this helps match good customers with pros.')).toBeInTheDocument();
  });

  it('sends a customer rating without a comment, and keeps "See my week" in the page below it', async () => {
    const api = fakeApi(users.pro);
    const done = job({ status: 'completed', completedAt: '2026-11-06T10:00:00.000Z', canCancel: false, canRateCustomer: true });
    api.on('GET /pro/jobs/b1', { body: { job: done } });
    api.on('POST /pro/jobs/b1/customer-rating', {
      status: 201,
      body: { job: { ...done, canRateCustomer: false, customerRating: { stars: 5, tags: [] } } },
    });
    renderAt('/pro/jobs/b1');
    const form = await screen.findByRole('form', { name: 'How was Sara as a customer?' });
    // The bottom button no longer floats over the rating once the job is done.
    expect(screen.getByRole('link', { name: /See my week/ }).closest('.cta-bar')).toHaveClass('in-flow');
    await user().click(within(form).getByRole('radio', { name: '5 stars' }));
    await user().click(within(form).getByRole('button', { name: 'Send rating' }));
    await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/customer-rating']).toEqual({ stars: 5, tags: [] }));
  });
});

describe('Job page pop-ups (D86)', () => {
  it('opens the chat with the customer in a pop-up, also from the old chat address', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/jobs/b1', { body: { job: job({ unreadMessages: 1 }) } });
    api.on('GET /pro/jobs/b1/messages', {
      body: { messages: [{ id: '1', from: 'customer', body: 'The gate is open', createdAt: '2026-11-06T08:50:00.000Z', readAt: null }], canWrite: true },
    });
    api.on('POST /pro/jobs/b1/messages', {
      status: 201,
      body: { message: { id: '2', from: 'pro', body: 'On my way', createdAt: '2026-11-06T08:55:00.000Z', readAt: null } },
    });
    const { unmount } = renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Chat with Sara, 1 new' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sara' });
    expect(await within(sheet).findByText('The gate is open')).toBeInTheDocument();
    // The quick replies are exactly the design's.
    for (const reply of ["I've arrived", 'Running 10 minutes late', 'All done!']) {
      expect(within(sheet).getByRole('button', { name: reply })).toBeInTheDocument();
    }
    await user().click(within(sheet).getByRole('button', { name: 'On my way' }));
    await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/messages']).toEqual({ body: 'On my way' }));
    await user().click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    unmount();

    renderAt('/pro/jobs/b1/chat');
    expect(await screen.findByRole('dialog', { name: 'Sara' })).toBeInTheDocument();
  });

  it('adds extra work from the MISK price list and sends it to the customer for approval', async () => {
    const api = fakeApi(users.pro);
    const working = job({ status: 'working', canCancel: false });
    api.on('GET /pro/jobs/b1', { body: { job: working } });
    api.on('GET /pro/jobs/b1/price-list', {
      body: {
        items: [
          { id: 'service:svc-hedge', name: 'Hedge trimming', priceCents: 5850, durationMinutes: 90 },
          { id: 'time:30', name: 'Extra 30 minutes of work', priceCents: 2275, durationMinutes: 30 },
        ],
      },
    });
    api.on('POST /pro/jobs/b1/extras', {
      status: 201,
      body: {
        job: {
          ...working,
          extras: [{ id: 'x1', description: 'Hedge trimming', priceCents: 5850, durationMinutes: 90, status: 'pending', createdAt: '2026-11-06T09:30:00.000Z' }],
        },
      },
    });
    renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Add extra work' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add extra work' });
    expect(within(sheet).getByText('Pick from the MISK price list. The customer approves it in their app before you start')).toBeInTheDocument();
    expect(await within(sheet).findByText('+€58.50')).toBeInTheDocument();
    expect(within(sheet).getByText('About 1 h 30 min')).toBeInTheDocument();
    expect(within(sheet).getByText('You earn 82% of extra work, the same as the job')).toBeInTheDocument();
    expect(within(sheet).getByPlaceholderText('e.g. The front hedge is overgrown')).toBeInTheDocument();

    // The button stays off until an item is chosen.
    expect(within(sheet).getByRole('button', { name: 'Send to customer for approval' })).toBeDisabled();
    expect(api.calls).not.toContain('POST /pro/jobs/b1/extras');

    await user().click(within(sheet).getByRole('radio', { name: /Hedge trimming/ }));
    await user().type(within(sheet).getByLabelText('Note for Sara (optional)'), 'The front hedge is overgrown');
    await user().click(within(sheet).getByRole('button', { name: 'Send to customer for approval' }));
    // The request is sent after the click resolves, so wait for it rather than checking at once.
    await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/extras']).toEqual({ itemId: 'service:svc-hedge', note: 'The front hedge is overgrown' }));
    expect(await screen.findByText('Waiting for the customer to approve Hedge trimming +€58.50')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reports an issue on site to MISK support', async () => {
    const api = fakeApi(users.pro);
    const current = job({ status: 'on_the_way', callOutFeeCents: 1500 });
    api.on('GET /pro/jobs/b1', { body: { job: current } });
    api.on('POST /pro/jobs/b1/issue', {
      status: 201,
      body: { job: { ...current, openIssue: { id: 'i1', reason: 'other', createdAt: '2026-11-06T09:05:00.000Z' } } },
    });
    renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Report an issue' }));
    const sheet = await screen.findByRole('dialog', { name: 'Report an on-site issue' });
    // Five reasons, each with what happens next.
    expect(within(sheet).getByRole('radio', { name: /Customer not home.*MISK calls the customer\. After 15 minutes you can leave and get a €15 call-out fee\./ })).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: /Can't get in.*MISK contacts the customer straight away\. Your waiting time is paid\./ })).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: /Job bigger than described.*Send extra work, or ask MISK to change the price\./ })).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: /Unsafe to work.*Stop working\. MISK support calls you within 5 minutes\./ })).toBeInTheDocument();
    expect(within(sheet).getByRole('radio', { name: /Something else.*Describe the problem\./ })).toBeInTheDocument();
    // "Send to MISK support" stays off until a reason is chosen.
    expect(within(sheet).getByRole('button', { name: 'Send to MISK support' })).toBeDisabled();

    await user().click(within(sheet).getByRole('radio', { name: /Something else/ }));
    await user().click(within(sheet).getByRole('button', { name: 'Send to MISK support' }));
    expect(await within(sheet).findByText("Describe what's wrong.")).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /pro/jobs/b1/issue');

    await user().type(within(sheet).getByLabelText('Details'), 'Dog in the garden');
    await user().click(within(sheet).getByRole('button', { name: 'Send to MISK support' }));
    expect(api.bodies['POST /pro/jobs/b1/issue']).toEqual({ reason: 'other', details: 'Dog in the garden' });
    expect(await screen.findByText('Issue reported. MISK support is on it')).toBeInTheDocument();
    expect(screen.getByText('You reported: Something else.')).toBeInTheDocument();
  });

  it('shows the rules before cancelling and needs a reason; the job then goes back to other pros', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/jobs/b1', { body: { job: job({ cancelIsLate: true }) } });
    api.on('POST /pro/jobs/b1/cancel', { body: { cancelled: { reason: 'ill', late: true } } });
    renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Cancel job' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cancel this job?' });
    expect(within(sheet).getByText('The job goes straight back to other pros, and the customer is told automatically')).toBeInTheDocument();
    expect(within(sheet).getByText('More than 24 hours before: no penalty, but it counts in your acceptance rate')).toBeInTheDocument();
    expect(within(sheet).getByText('Less than 24 hours before: a late cancellation. 3 in 30 days pauses new jobs for a week')).toBeInTheDocument();
    expect(within(sheet).getByText('This job starts in less than 24 hours, so cancelling now is a late cancellation.')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Keep job' })).toBeInTheDocument();

    // The red "Cancel job" stays off until a reason is chosen.
    expect(within(sheet).getByRole('button', { name: 'Cancel job' })).toBeDisabled();
    expect(api.calls).not.toContain('POST /pro/jobs/b1/cancel');

    // Afterwards the Jobs page says what happened (D94).
    api.on('GET /pro/profile', { body: { profile } });
    api.on('GET /pro/offers', { body: { offers: [] } });
    api.on('GET /pro/jobs', { body: { jobs: [] } });
    api.on('GET /pro/visits', { body: { visits: [] } });
    api.on('GET /pro/cancellations', {
      body: {
        cancellations: [
          {
            id: 'c1',
            bookingId: 'b1',
            reason: 'ill',
            note: null,
            late: true,
            createdAt: '2026-11-05T09:00:00.000Z',
            serviceName: 'Lawn mowing',
            startsAt: '2026-11-06T09:00:00.000Z',
            nextProName: 'Leon',
          },
        ],
      },
    });
    await user().click(within(sheet).getByRole('radio', { name: "I'm ill" }));
    await user().click(within(sheet).getByRole('button', { name: 'Cancel job' }));
    await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/cancel']).toEqual({ reason: 'ill' }));
    expect(await screen.findByRole('heading', { name: 'You cancelled this job' })).toBeInTheDocument();
    expect(screen.getByText("Reason: I'm ill")).toBeInTheDocument();
    expect(screen.getByText('It was offered to Leon, and the customer was told automatically.')).toBeInTheDocument();
  });

  it('closes the pop-up and keeps the job with Keep job', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/jobs/b1', { body: { job: job() } });
    renderAt('/pro/jobs/b1');
    await user().click(await screen.findByRole('button', { name: 'Cancel job' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cancel this job?' });
    expect(within(sheet).queryByText(/cancelling now is a late cancellation/)).not.toBeInTheDocument();
    await user().click(within(sheet).getByRole('button', { name: 'Keep job' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls).not.toContain('POST /pro/jobs/b1/cancel');
  });
});

describe("the customer's Booking page follows the job (D86)", () => {
  function booking(overrides: Partial<CustomerBooking> = {}): CustomerBooking {
    // The same booking as the pro's job, without what only the pro sees.
    const proOnly = new Set(['customer', 'earningsCents', 'proSharePct', 'unreadMessages', 'openIssue', 'canCancel', 'cancelIsLate', 'customerRating', 'canRateCustomer']);
    const base = Object.fromEntries(Object.entries(job()).filter(([key]) => !proOnly.has(key))) as unknown as BookingBase;
    return {
      ...base,
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
      ...overrides,
    };
  }

  it("shows the checklist progress and that the pro asked support for help", async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: {
        booking: booking({
          status: 'working',
          proIssueOpen: true,
          tasks: [
            { key: 't0', label: 'Mow the lawn', done: true },
            { key: 't1', label: 'Edge the borders', done: true },
            { key: 't2', label: 'Clear the clippings', done: false },
          ],
        }),
      },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByText('2 of 3 tasks done')).toBeInTheDocument();
    expect(screen.getByText('Daniel asked MISK support for help with this job. Support may contact you.')).toBeInTheDocument();
  });

  it('starts the steps again when the pro gave the job back and the search restarted', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: {
        booking: booking({
          status: 'searching',
          pro: null,
          events: [
            { status: 'searching', at: '2026-11-04T09:00:00.000Z' },
            { status: 'accepted', at: '2026-11-04T09:03:00.000Z' },
            { status: 'searching', at: '2026-11-05T15:00:00.000Z' },
          ],
        }),
      },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByText(/Finding your pro/)).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'Progress' });
    const accepted = within(steps).getByText('Pro accepted').closest('li') as HTMLElement;
    expect(accepted).not.toHaveClass('done');
    expect(accepted).toHaveTextContent('The best-rated free pro nearby');
  });
});
