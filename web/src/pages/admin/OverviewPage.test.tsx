import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Overview, OverviewApplication, OverviewLive } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

const user = () => userEvent.setup();
const READY_ID = '44444444-4444-4444-8444-444444444444';
const OPEN_ID = '55555555-5555-4555-8555-555555555555';
const BOOKING_ID = '66666666-6666-4666-8666-666666666666';
const VISIT_ID = '77777777-7777-4777-8777-777777777777';

function overview(days: number): Overview {
  const today = days === 1;
  const weeks = days === 1 ? 4 : days === 7 ? 8 : 13;
  return {
    days,
    city: 'Berlin',
    timezone: 'Europe/Berlin',
    kpis: {
      bookings: today ? 3 : 42,
      previousBookings: today ? 0 : 35,
      bookingsChangePct: today ? null : 20,
      completed: 30,
      activeSubscriptions: 18,
      newSubscriptions: today ? 0 : 4,
      grossCents: today ? 12000 : 284000,
      previousGrossCents: 0,
      grossChangePct: null,
      payoutCents: 0,
      miskShareCents: today ? 2160 : 51120,
      ratingAverage: 4.8,
      ratingCount: 21,
      onTimePct: 94,
    },
    weekly: Array.from({ length: weeks }, (_, i) => ({
      week: `2026-${String(8 + Math.floor(i / 4)).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}`,
      oneOff: i + 1,
      visits: 2,
      bookings: i + 3,
    })),
    attention: { pendingApplications: 2, unassigned: 0, unreleasedHolds: 0, failedPayouts: 0 },
  };
}

function application(overrides: Partial<OverviewApplication> = {}): OverviewApplication {
  return {
    id: READY_ID,
    firstName: 'Erion',
    lastName: 'Krasniqi',
    trades: ['Gardening'],
    documentsUploaded: 4,
    documentsTotal: 4,
    ready: true,
    ...overrides,
  };
}

function live(overrides: Partial<OverviewLive> = {}): OverviewLive {
  return {
    applications: {
      waiting: 2,
      pros: [
        application(),
        application({ id: OPEN_ID, firstName: 'Luan', lastName: 'Berisha', trades: ['Cleaning'], documentsUploaded: 2, ready: false }),
      ],
    },
    bookings: [
      {
        kind: 'booking',
        id: BOOKING_ID,
        number: 'B-1042',
        startsAt: '2026-11-11T09:00:00.000Z',
        endsAt: '2026-11-11T11:00:00.000Z',
        service: 'Lawn mowing',
        customer: 'Anna',
        address: 'Invalidenstraße 1',
        postcode: '10115',
        pro: 'Daniel',
        status: 'working',
        valueCents: 6090,
        problem: false,
        tab: 'live',
      },
      {
        kind: 'visit',
        id: VISIT_ID,
        number: 'V-77',
        startsAt: '2026-11-11T13:00:00.000Z',
        endsAt: '2026-11-11T15:00:00.000Z',
        service: 'Garden care plan',
        customer: null,
        address: 'Torstraße 9',
        postcode: '10119',
        pro: 'Ina',
        status: 'planned',
        valueCents: 4500,
        problem: false,
        tab: 'upcoming',
      },
    ],
    ...overrides,
  };
}

function setUp(liveReply: OverviewLive = live()) {
  const api = fakeApi(users.admin);
  api.on('GET /admin/overview', ({ url }) => ({ body: overview(Number(url.searchParams.get('days') ?? 7)) }));
  api.on('GET /admin/overview/live', { body: liveReply });
  api.on('GET /admin/badges', { body: { applications: 2 } });
  return api;
}

describe('Overview', () => {
  it('is the first page after signing in', async () => {
    setUp();
    renderAt('/admin');
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByText('Berlin · Last 7 days')).toBeInTheDocument();
  });

  it('shows the four numbers with their comparison, share, new plans and on-time share', async () => {
    setUp();
    renderAt('/admin');
    await screen.findByText('Bookings', { selector: '.kl' });
    const box = (label: string) => screen.getByText(label, { selector: '.kl' }).closest('.kpi') as HTMLElement;
    expect(box('Bookings')).toHaveTextContent('42+20% vs previous period');
    expect(box('Active subscriptions')).toHaveTextContent('18+4 new');
    expect(box('Revenue (gross)')).toHaveTextContent(/€2,840.*€511\.20 MISK share/);
    expect(box('Avg. rating')).toHaveTextContent('4.894% of jobs on time');
  });

  it('updates the numbers and the chart when the period changes, and says which period they cover', async () => {
    const api = setUp();
    renderAt('/admin');
    await screen.findByText('Berlin · Last 7 days');
    expect(screen.getByRole('img', { name: /last 8 weeks/ })).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText('Berlin · Today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('None in the previous period')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /last 4 weeks/ })).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: '30 days' }));
    expect(await screen.findByText('Berlin · Last 30 days')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /last 13 weeks/ })).toBeInTheDocument();
    expect(api.calls).toEqual(expect.arrayContaining(['GET /admin/overview']));
  });

  it('counts one-off jobs and plan visits together per week and highlights this week', async () => {
    setUp();
    renderAt('/admin');
    const current = await screen.findByTestId('current-week');
    expect(current).toHaveTextContent('10This week');
    expect(current).toHaveAttribute('title', '8 one-off, 2 plan visits');
    expect(current.querySelector('.bar')).toHaveClass('hl');
    expect(screen.getByText('One-off jobs and plan visits')).toBeInTheDocument();
  });

  it('lists waiting applications with trade and documents, Approve for complete ones and Review for the rest', async () => {
    const api = setUp();
    renderAt('/admin');
    const panel = (await screen.findByRole('heading', { name: 'Pro applications' })).closest('section') as HTMLElement;
    expect(within(panel).getByText('2 waiting')).toBeInTheDocument();
    expect(within(panel).getByText(/Gardening · 4\/4 documents/)).toBeInTheDocument();
    expect(within(panel).getByText(/Cleaning · 2\/4 documents/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Review the application of Luan Berisha' })).toHaveAttribute(
      'href',
      `/admin/providers?tab=applications&open=${OPEN_ID}`,
    );
    expect(within(panel).queryByRole('button', { name: 'Approve Luan Berisha' })).not.toBeInTheDocument();

    api.on(`POST /admin/pros/${READY_ID}/approve`, { body: { pro: { id: READY_ID, status: 'approved' } } });
    api.on('GET /admin/overview/live', {
      body: live({
        applications: { waiting: 1, pros: [application({ id: OPEN_ID, firstName: 'Luan', lastName: 'Berisha', ready: false })] },
      }),
    });
    await user().click(within(panel).getByRole('button', { name: 'Approve Erion Krasniqi' }));
    expect(await within(panel).findByText('Approved')).toBeInTheDocument();
    expect(api.calls).toContain(`POST /admin/pros/${READY_ID}/approve`);
    await waitFor(() => expect(within(panel).getByText('1 waiting')).toBeInTheDocument());
    expect(within(panel).getByText('Erion Krasniqi')).toBeInTheDocument();
  });

  it('shows why an approval failed', async () => {
    const api = setUp();
    renderAt('/admin');
    api.on(`POST /admin/pros/${READY_ID}/approve`, { status: 409, body: { error: 'checks_open' } });
    await user().click(await screen.findByRole('button', { name: 'Approve Erion Krasniqi' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
  });

  it('hides applications from team members who may not open Providers', async () => {
    const api = fakeApi({ ...users.admin, adminRole: 'finance', areas: ['overview', 'bookings', 'fees'] });
    api.on('GET /admin/overview', { body: overview(7) });
    api.on('GET /admin/overview/live', { body: live({ applications: null }) });
    renderAt('/admin');
    await screen.findByRole('heading', { name: 'Live bookings' });
    expect(screen.queryByRole('heading', { name: 'Pro applications' })).not.toBeInTheDocument();
  });

  it('lists live bookings with Plan instead of a price for plan visits, and opens one under Bookings', async () => {
    const api = setUp();
    api.on('GET /admin/bookings', {
      body: { bookings: [], counts: { all: 0, needs_action: 0, live: 0, upcoming: 0, done: 0 }, truncated: false },
    });
    api.on(`GET /admin/bookings/${BOOKING_ID}`, { status: 404, body: { error: 'not_found' } });
    renderAt('/admin');
    const table = await screen.findByRole('table');
    const [, booking, visit] = within(table).getAllByRole('row');
    expect(booking).toHaveTextContent(/Lawn mowing.*Anna.*Invalidenstraße 1.*Daniel.*Working.*60\.90/);
    expect(visit).toHaveTextContent(/Garden care plan.*Torstraße 9.*Ina.*Planned.*Plan$/);

    await user().click(within(table).getByRole('button', { name: 'Open B-1042' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Bookings' })).toBeInTheDocument();
    expect(api.calls).toContain('GET /admin/bookings');
  });

  it('updates statuses by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = setUp();
      renderAt('/admin');
      expect(await screen.findByText('Working')).toBeInTheDocument();
      const done = live();
      done.bookings = done.bookings.map((b) => (b.id === BOOKING_ID ? { ...b, status: 'completed', tab: 'done' } : b));
      api.on('GET /admin/overview/live', { body: done });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await screen.findByText('Done')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
