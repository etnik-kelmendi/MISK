import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminBooking, AdminBookingListItem } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

const user = () => userEvent.setup();
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const counts = { all: 2, needs_action: 1, live: 0, upcoming: 1, done: 0 };

function row(overrides: Partial<AdminBookingListItem> = {}): AdminBookingListItem {
  return {
    kind: 'booking',
    id: BOOKING_ID,
    number: 'B-1042',
    startsAt: '2026-11-09T09:00:00.000Z',
    endsAt: '2026-11-09T10:00:00.000Z',
    service: 'Lawn mowing',
    categoryId: 'cat-garden',
    trade: 'Gardening',
    customer: 'Sara',
    address: '12 Linden Street',
    postcode: '10115',
    pro: null,
    status: 'unassigned',
    valueCents: 4840,
    paymentStatus: 'held',
    problem: false,
    tab: 'needs_action',
    ...overrides,
  };
}

function detail(overrides: Partial<AdminBooking> = {}): AdminBooking {
  return {
    id: BOOKING_ID,
    number: 'B-1042',
    categoryName: 'Gardening',
    problemReportedAt: null,
    problemNote: null,
    problemResolvedAt: null,
    chargeAt: null,
    status: 'unassigned',
    serviceName: 'Lawn mowing',
    categoryId: 'cat-garden',
    size: 'M',
    address: '12 Linden Street',
    postcode: '10115',
    notes: 'Gate code 4411',
    startsAt: '2026-11-09T09:00:00.000Z',
    endsAt: '2026-11-09T10:00:00.000Z',
    createdAt: '2026-11-05T09:00:00.000Z',
    completedAt: null,
    events: [{ status: 'searching', at: '2026-11-05T09:00:00.000Z' }],
    photos: [],
    extras: [],
    rating: null,
    priceCents: 4550,
    feeCents: 290,
    extrasCents: 0,
    totalCents: 4840,
    paymentStatus: 'held',
    pro: null,
    cancelledBy: null,
    proSharePct: 82,
    customer: { id: 'u-customer', firstName: 'Sara', phone: '+4915100000001' },
    offers: [],
    payouts: [],
    actions: [],
    split: { proCents: 3731, miskCents: 1109 },
    ...overrides,
  };
}

const SECOND = row({ id: '22222222-2222-4222-8222-222222222222', number: 'B-1043', pro: 'Daniel', status: 'accepted', tab: 'upcoming' });

function setUp(bookings: AdminBookingListItem[] = [row(), SECOND]) {
  const api = fakeApi(users.admin);
  api.on('GET /admin/bookings', { body: { bookings, counts, truncated: false } });
  api.on('GET /admin/catalogue', {
    body: { categories: [{ id: 'cat-garden', slug: 'gardening', name: 'Gardening', icon: 'leaf', sortOrder: 1, active: true }], services: [] },
  });
  api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: detail() } });
  api.on(`GET /admin/bookings/${BOOKING_ID}/candidates`, {
    body: { candidates: [{ id: 'u-jonas', firstName: 'Jonas', distanceKm: 2.4, ratingAverage: 4.8 }] },
  });
  return api;
}

/** The query string of the last list request. */
function lastListQuery() {
  const fetchMock = vi.mocked(globalThis.fetch);
  const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === '/admin/bookings');
  return urls.at(-1)?.searchParams;
}

describe('admin bookings list', () => {
  it('shows number, date, service, customer, pro, status and price, with "Unassigned" in red', async () => {
    setUp();
    renderAt('/admin/bookings');
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Number', 'Date', 'Service', 'Customer', 'Pro', 'Status', 'Price']);
    expect(within(table).getByText('Unassigned')).toHaveClass('unassigned');
    expect(within(table).getAllByText('Mon 9 Nov, 10:00')).toHaveLength(2);
    expect(within(table).getAllByText('€48.40')).toHaveLength(2);
  });

  it('shows tabs with counts and asks the server for the chosen tab', async () => {
    setUp();
    renderAt('/admin/bookings');
    const tabs = await screen.findByRole('group', { name: 'Show bookings' });
    await waitFor(() =>
      expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'All (2)',
        'Needs action (1)',
        'Live now (0)',
        'Upcoming (1)',
        'Done (0)',
      ]),
    );
    await user().click(within(tabs).getByRole('button', { name: 'Needs action (1)' }));
    await waitFor(() => expect(lastListQuery()?.get('tab')).toBe('needs_action'));
  });

  it('searches as you type and filters by trade and type', async () => {
    setUp();
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    await user().type(screen.getByLabelText('Search'), 'b-1042');
    await waitFor(() => expect(lastListQuery()?.get('q')).toBe('b-1042'));
    await screen.findByRole('option', { name: 'Gardening' });
    await user().selectOptions(screen.getByLabelText('Trade'), 'Gardening');
    await waitFor(() => expect(lastListQuery()?.get('trade')).toBe('cat-garden'));
    await user().selectOptions(screen.getByLabelText('Type'), 'Plan visit');
    await waitFor(() => expect(lastListQuery()?.get('type')).toBe('visit'));
  });

  it('shows the 10 most recent bookings, with "View all" for the rest, and starts again at ten after a filter change', async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      row({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, number: `B-${2000 + i}`, tab: 'upcoming', status: 'accepted' }),
    );
    setUp(many);
    renderAt('/admin/bookings');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10);
    expect(within(table).getByText('B-2009')).toBeInTheDocument();
    expect(within(table).queryByText('B-2010')).not.toBeInTheDocument();
    expect(screen.getByText('Showing the 10 most recent of 14.')).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'View all (14)' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 14);
    expect(screen.getByText('Showing all 14.')).toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Show the 10 most recent' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 10);

    await user().click(screen.getByRole('button', { name: 'View all (14)' }));
    await user().selectOptions(screen.getByLabelText('Type'), 'booking');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(1 + 10));
  });

  it('shows no "View all" for ten bookings or fewer', async () => {
    setUp();
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    setUp([]);
    renderAt('/admin/bookings');
    expect(await screen.findByText('No bookings match these filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('exports the bookings shown as a CSV file', async () => {
    setUp();
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      saved.push(blob);
      return 'blob:bookings';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    await user().click(screen.getByRole('button', { name: 'Export' }));
    expect(click).toHaveBeenCalled();
    const file = saved[0];
    if (!file) throw new Error('No file saved');
    // Starts with a UTF-8 byte order mark, so Excel reads names with accents right.
    expect([...new Uint8Array(await file.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = (await file.text()).replace(String.fromCharCode(0xfeff), '').trim().split('\r\n');
    expect(lines[0]).toBe('Booking number,Date,Time,Service,Trade,Type,Customer,Address,Pro,Status,Value (EUR),Payment status');
    expect(lines[1]).toBe(
      'B-1042,2026-11-09,10:00,Lawn mowing,Gardening,One-off,Sara,"12 Linden Street, 10115",Unassigned,No pro yet,48.40,The amount is held on your card.',
    );
    expect(lines).toHaveLength(3);
    click.mockRestore();
  });
});

describe('admin booking side panel', () => {
  it('opens on a click and closes with ×, Esc and a click outside', async () => {
    setUp();
    renderAt('/admin/bookings');
    await user().click(await screen.findByRole('button', { name: 'Open B-1042' }));
    let dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    await user().click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user().click(screen.getByRole('button', { name: 'Open B-1042' }));
    await screen.findByRole('dialog', { name: 'B-1042' });
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user().click(screen.getAllByText('Lawn mowing')[0] as HTMLElement);
    dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows progress, the customer, and the money split', async () => {
    setUp();
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    const steps = within(dialog).getByRole('list', { name: 'Progress' });
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent?.replace(/ \(.*\)$/, ''))).toEqual([
      'Booked',
      'Pro confirmed',
      'On the way',
      'Working',
      'Done',
    ]);
    expect(within(dialog).getByText('+4915100000001')).toBeInTheDocument();
    expect(within(dialog).getByText('Pro gets (82%)')).toBeInTheDocument();
    expect(within(dialog).getByText('€37.31')).toBeInTheDocument();
    expect(within(dialog).getByText('€11.09')).toBeInTheDocument();
    expect(within(dialog).getByText('The customer is charged 24 hours after the job is done, if they report no problem.')).toBeInTheDocument();
  });

  it('gives a job nobody took to a pro nearby', async () => {
    const api = setUp();
    const assigned = detail({
      status: 'accepted',
      pro: { id: 'u-jonas', firstName: 'Jonas', ratingAverage: 4.8, ratingCount: 3, phone: '+4915100000009' },
      actions: [{ id: '1', action: 'assigned', details: { proName: 'Jonas' }, createdAt: '2026-11-06T09:00:00.000Z', adminName: 'admin' }],
    });
    api.on(`POST /admin/bookings/${BOOKING_ID}/reassign`, { body: { booking: assigned } });
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    expect(within(dialog).getByRole('heading', { name: 'No pro yet: give the job to a pro nearby' })).toBeInTheDocument();
    await user().click(await within(dialog).findByRole('button', { name: 'Assign Jonas' }));
    expect(api.bodies[`POST /admin/bookings/${BOOKING_ID}/reassign`]).toEqual({ proId: 'u-jonas' });
    expect(await within(dialog).findByText('Gave the job to Jonas')).toBeInTheDocument();
  });

  it('moves the booking to a new time on the market clock', async () => {
    const api = setUp();
    api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: detail({ status: 'accepted' }) } });
    api.on(`POST /admin/bookings/${BOOKING_ID}/reschedule`, {
      body: { booking: detail({ status: 'accepted', startsAt: '2026-11-10T13:00:00.000Z' }) },
    });
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    fireEvent.change(within(dialog).getByLabelText('New date'), { target: { value: '2026-11-10' } });
    fireEvent.change(within(dialog).getByLabelText('New start time'), { target: { value: '14:00' } });
    await user().click(within(dialog).getByRole('button', { name: 'Move booking' }));
    expect(api.bodies[`POST /admin/bookings/${BOOKING_ID}/reschedule`]).toEqual({ startsAt: '2026-11-10T13:00:00.000Z' });
    expect(await within(dialog).findByText('Moved. The customer and the pro were texted.')).toBeInTheDocument();
  });

  it('asks before refunding a finished job', async () => {
    const api = setUp();
    const pro = { id: 'u-pro', firstName: 'Daniel', ratingAverage: null, ratingCount: 0 };
    api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: detail({ status: 'completed', paymentStatus: 'captured', pro }) } });
    api.on(`POST /admin/bookings/${BOOKING_ID}/refund`, { body: { booking: detail({ status: 'completed', paymentStatus: 'refunded', pro }) } });
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    expect(within(dialog).queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: 'Refund in full' }));
    expect(api.calls).not.toContain(`POST /admin/bookings/${BOOKING_ID}/refund`);
    await user().click(within(dialog).getByRole('button', { name: 'Refund in full' }));
    expect(await within(dialog).findByText('Refunded.')).toBeInTheDocument();
  });

  it('shows a reported problem and lets the team charge once it is settled', async () => {
    const api = setUp();
    const withProblem = detail({
      status: 'completed',
      paymentStatus: 'held',
      problemReportedAt: '2026-11-06T09:00:00.000Z',
      problemNote: 'Back lawn not mowed',
      chargeAt: '2026-11-07T08:00:00.000Z',
      photos: [
        { id: 'done-1', kind: 'completion' },
        { id: 'problem-1', kind: 'problem' },
        { id: 'problem-2', kind: 'problem' },
      ],
    });
    api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: withProblem } });
    api.on(`POST /admin/bookings/${BOOKING_ID}/charge`, {
      body: { booking: { ...withProblem, paymentStatus: 'captured', problemResolvedAt: '2026-11-07T09:00:00.000Z' } },
    });
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    expect(within(dialog).getByText('Back lawn not mowed')).toBeInTheDocument();
    const problemPhotos = within(dialog).getByRole('list', { name: "Customer's photo of the problem" });
    expect(within(problemPhotos).getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual([
      expect.stringContaining('/files/problem-1'),
      expect.stringContaining('/files/problem-2'),
    ]);
    expect(within(within(dialog).getByRole('list', { name: 'Photos' })).getAllByRole('img')).toHaveLength(1);
    await user().click(within(dialog).getByRole('button', { name: 'Charge the customer' }));
    await user().click(within(dialog).getByRole('button', { name: 'Charge the customer' }));
    expect(await within(dialog).findByText('Paid.')).toBeInTheDocument();
  });
});
