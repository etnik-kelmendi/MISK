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
    customerProfile: {
      id: 'u-customer',
      firstName: 'Sara',
      lastName: 'Meier',
      phone: '+4915100000001',
      email: 'sara@example.com',
      signIn: 'email',
      emailConfirmed: true,
      memberSince: '2026-09-01T10:00:00.000Z',
      disabled: false,
      bookings: { total: 7, completed: 5, cancelled: 1, upcoming: 1 },
      spentCents: 24200,
      tipsCents: 500,
      activePlans: ['Lawn care'],
      ratingsGiven: 4,
      averageStarsGiven: 4.5,
      problemsReported: 1,
      lateCancellations: 0,
      lastBookingAt: '2026-11-05T09:00:00.000Z',
    },
    offers: [],
    payouts: [],
    actions: [],
    split: { proCents: 3731, miskCents: 1109 },
    assignmentLocked: false,
    assignmentLockedAt: null,
    assignmentLockedBy: null,
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
    await user().click(screen.getByRole('menuitem', { name: 'Export as CSV' }));
    expect(click).toHaveBeenCalled();
    const file = saved[0];
    if (!file) throw new Error('No file saved');
    // Starts with a UTF-8 byte order mark, so Excel reads names with accents right.
    expect([...new Uint8Array(await file.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = (await file.text()).replace(String.fromCharCode(0xfeff), '').trim().split('\r\n');
    // First what was exported: the tab, search and filters on screen.
    expect(lines.slice(0, 4)).toEqual(['Tab,All', 'Search,None', 'Trade filter,All trades', 'Type filter,All types']);
    expect(lines[4]).toMatch(/^Exported,\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(lines[5]).toBe('Bookings in this file,2');
    expect(lines[6]).toBe('');
    expect(lines[7]).toBe('Booking number,Date,Time,Service,Trade,Type,Customer,Address,Pro,Status,Value (EUR),Payment status');
    expect(lines[8]).toBe(
      'B-1042,2026-11-09,10:00,Lawn mowing,Gardening,One-off,Sara,"12 Linden Street, 10115",Unassigned,No pro yet,48.40,The amount is held on your card.',
    );
    expect(lines).toHaveLength(10);
    click.mockRestore();
  });

  it('names the tab, search and filters in the exported file', async () => {
    setUp([row()]);
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      saved.push(blob);
      return 'blob:bookings';
    });
    URL.revokeObjectURL = vi.fn();
    let fileName = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      fileName = this.download;
    });
    renderAt('/admin/bookings?tab=needs_action&q=b-10&trade=cat-garden&type=booking');
    await screen.findByRole('table');
    await waitFor(() => expect(screen.getByLabelText('Trade')).toHaveValue('cat-garden'));
    await user().click(screen.getByRole('button', { name: 'Export' }));
    await user().click(screen.getByRole('menuitem', { name: 'Export as CSV' }));
    expect(fileName).toMatch(/^misk-bookings-needs-action-gardening-booking-search-b-10-\d{4}-\d{2}-\d{2}\.csv$/);
    const file = saved[0];
    if (!file) throw new Error('No file saved');
    const lines = (await file.text()).replace(String.fromCharCode(0xfeff), '').split('\r\n');
    expect(lines.slice(0, 4)).toEqual(['Tab,Needs action', 'Search,b-10', 'Trade filter,Gardening', 'Type filter,One-off']);
    // The rows are the ones the server sent for exactly that tab, search and filters.
    expect(lastListQuery()?.toString()).toBe('tab=needs_action&q=b-10&trade=cat-garden&type=booking');
    click.mockRestore();
  });

  it('shows Export as a bordered secondary button with a download icon', async () => {
    setUp();
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button).toHaveClass('abtn', 'secondary');
    expect(button).not.toHaveClass('ghost');
    expect(button.querySelector('svg.i')).not.toBeNull();
    expect(button).toHaveTextContent('Export');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a menu with both formats and closes it with Escape, focus back on the button', async () => {
    setUp();
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    const button = screen.getByRole('button', { name: 'Export' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user().click(button);
    const menu = screen.getByRole('menu', { name: 'Export format' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', menu.id);
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Export as CSV', 'Export as Excel']);
    expect(items[0]).toHaveFocus();
    const u = user();
    await u.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await u.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();
    await u.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await u.keyboard('{End}');
    expect(items[1]).toHaveFocus();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes the menu on Tab and on a click outside', async () => {
    setUp();
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    await user().click(screen.getByRole('button', { name: 'Export' }));
    await user().tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('exports an Excel file with the right type and name, then closes the menu', async () => {
    setUp();
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      saved.push(blob);
      return 'blob:bookings';
    });
    URL.revokeObjectURL = vi.fn();
    let fileName = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      fileName = this.download;
    });
    renderAt('/admin/bookings');
    await screen.findByRole('table');
    await user().click(screen.getByRole('button', { name: 'Export' }));
    await user().click(screen.getByRole('menuitem', { name: 'Export as Excel' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(fileName).toMatch(/^misk-bookings-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const file = saved[0];
    if (!file) throw new Error('No file saved');
    expect(file.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('B-1042');
    // The value is a real number in the sheet.
    expect(text).toContain('<v>48.4</v>');
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
    const profile = within(dialog).getByRole('region', { name: 'Customer profile' });
    expect(within(profile).getByText('Sara Meier')).toBeInTheDocument();
    // The customer line at the top names them in full and jumps to the profile.
    const customerLine = within(dialog).getByText('Customer', { selector: 'dt' }).nextElementSibling as HTMLElement;
    expect(customerLine).toHaveTextContent('Sara Meier · View profile');
    await user().click(within(customerLine).getByRole('button', { name: 'View profile' }));
    expect(profile).toHaveFocus();
    expect(within(profile).getByRole('link', { name: '+4915100000001' })).toHaveAttribute('href', 'tel:+4915100000001');
    expect(within(profile).getByRole('link', { name: 'sara@example.com' })).toHaveAttribute('href', 'mailto:sara@example.com');
    expect(profile).toHaveTextContent('7 in total · 5 done · 1 coming up · 1 cancelled');
    expect(profile).toHaveTextContent('€242 + €5 in tips');
    expect(profile).toHaveTextContent('Lawn care');
    expect(profile).toHaveTextContent('4 ratings, 4.5 stars on average');
    expect(profile).toHaveTextContent('Email and password');
    expect(within(dialog).getByText('Pro gets (82%)')).toBeInTheDocument();
    expect(within(dialog).getByText('€37.31')).toBeInTheDocument();
    expect(within(dialog).getByText('€11.09')).toBeInTheDocument();
    expect(within(dialog).getByText('The customer is charged 24 hours after the job is done, if they report no problem.')).toBeInTheDocument();
  });

  it('says which pro the customer asked for on Home (D89)', async () => {
    const api = setUp();
    api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: detail({ preferredPro: { id: 'u-daniel', firstName: 'Daniel' } }) } });
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    expect(within(dialog).getByText('Customer asked for Daniel')).toBeInTheDocument();
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
    await within(dialog).findByRole('button', { name: 'Assign Jonas' });
    // Only the pros to assign: no button to send the job out to every pro again.
    expect(within(dialog).queryByRole('button', { name: /Offer it to pros again/ })).not.toBeInTheDocument();
    // Assign only asks: nothing is sent until the admin confirms.
    await user().click(within(dialog).getByRole('button', { name: 'Assign Jonas' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Assign this job to Jonas?' });
    expect(confirm).toHaveAttribute('aria-modal', 'true');
    expect(api.calls).not.toContain(`POST /admin/bookings/${BOOKING_ID}/reassign`);
    expect(confirm).toHaveTextContent('Lawn mowing');
    expect(confirm).toHaveTextContent('2.4 km away · rating 4.8');
    expect(confirm).toHaveTextContent('Mon 9 Nov, 10:00');
    expect(within(confirm).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Confirm Assignment']);
    await user().click(within(confirm).getByRole('button', { name: 'Confirm Assignment' }));
    expect(api.calls.filter((c) => c === `POST /admin/bookings/${BOOKING_ID}/reassign`)).toHaveLength(1);
    expect(api.bodies[`POST /admin/bookings/${BOOKING_ID}/reassign`]).toEqual({ proId: 'u-jonas' });
    expect(await within(dialog).findByText('Gave the job to Jonas')).toBeInTheDocument();
  });

  describe('confirming an assignment (D88)', () => {
    const lockedAt = '2026-11-06T09:00:00.000Z';
    const assigned = () =>
      detail({
        status: 'accepted',
        pro: { id: 'u-jonas', firstName: 'Jonas', ratingAverage: 4.8, ratingCount: 3, phone: '+4915100000009' },
        assignmentLocked: true,
        assignmentLockedAt: lockedAt,
        assignmentLockedBy: 'admin',
      });

    it('cancels without sending anything, keeps the drawer open on Esc, and gives the focus back', async () => {
      const api = setUp();
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      const drawer = await screen.findByRole('dialog', { name: 'B-1042' });
      const assign = await within(drawer).findByRole('button', { name: 'Assign Jonas' });
      await user().click(assign);
      const confirm = await screen.findByRole('alertdialog');
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();

      // Tab stays inside the pop-up.
      await user().tab();
      expect(within(confirm).getByRole('button', { name: 'Confirm Assignment' })).toHaveFocus();
      await user().tab();
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();

      await user().click(within(confirm).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(assign).toHaveFocus();

      // Esc closes only the pop-up, not the drawer behind it.
      await user().click(assign);
      await screen.findByRole('alertdialog');
      await user().keyboard('{Escape}');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'B-1042' })).toBeInTheDocument();
      expect(assign).toHaveFocus();
      expect(api.calls).not.toContain(`POST /admin/bookings/${BOOKING_ID}/reassign`);
    });

    it('removes the assign section after the confirmation and says the assignment is final', async () => {
      const api = setUp();
      let answer: (value: { body: unknown }) => void = () => undefined;
      api.on(`POST /admin/bookings/${BOOKING_ID}/reassign`, () => new Promise((resolve) => (answer = resolve)));
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      const drawer = await screen.findByRole('dialog', { name: 'B-1042' });
      await user().click(await within(drawer).findByRole('button', { name: 'Assign Jonas' }));
      const confirm = await screen.findByRole('alertdialog');
      await user().click(within(confirm).getByRole('button', { name: 'Confirm Assignment' }));
      // Disabled while sending, so a second click cannot send it twice.
      expect(within(confirm).getByRole('button', { name: 'Confirm Assignment' })).toBeDisabled();
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      answer({ body: { booking: assigned() } });

      expect(await within(drawer).findByText(/Assigned by admin on .*This assignment is final\./)).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(drawer).queryByRole('button', { name: /^Assign/ })).not.toBeInTheDocument();
      expect(within(drawer).queryByRole('heading', { name: 'Change the pro' })).not.toBeInTheDocument();
      expect(api.calls.filter((c) => c === `POST /admin/bookings/${BOOKING_ID}/reassign`)).toHaveLength(1);
    });

    it('shows no assign section for a booking whose pro the team already confirmed', async () => {
      const api = setUp();
      api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: assigned() } });
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      const drawer = await screen.findByRole('dialog', { name: 'B-1042' });
      expect(await within(drawer).findByText(/Assigned by admin on .*This assignment is final\./)).toBeInTheDocument();
      expect(within(drawer).queryByRole('button', { name: /^Assign/ })).not.toBeInTheDocument();
      expect(api.calls).not.toContain(`GET /admin/bookings/${BOOKING_ID}/candidates`);
    });

    it('asks first when changing a pro who accepted by themselves, and then locks it', async () => {
      const api = setUp();
      api.on(`GET /admin/bookings/${BOOKING_ID}`, {
        body: {
          booking: detail({
            status: 'accepted',
            pro: { id: 'u-daniel', firstName: 'Daniel', ratingAverage: 4.9, ratingCount: 8, phone: null },
          }),
        },
      });
      api.on(`POST /admin/bookings/${BOOKING_ID}/reassign`, { body: { booking: assigned() } });
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      const drawer = await screen.findByRole('dialog', { name: 'B-1042' });
      expect(await within(drawer).findByRole('heading', { name: 'Change the pro' })).toBeInTheDocument();
      await user().click(within(drawer).getByRole('button', { name: 'Assign Jonas' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Assign this job to Jonas?' });
      expect(confirm).toHaveTextContent('Daniel has the job now and will be told it is no longer theirs.');
      expect(api.calls).not.toContain(`POST /admin/bookings/${BOOKING_ID}/reassign`);
      await user().click(within(confirm).getByRole('button', { name: 'Confirm Assignment' }));
      expect(await within(drawer).findByText(/This assignment is final\./)).toBeInTheDocument();
    });

    it("explains a refusal from the server in the pop-up and drops the assign section when it is closed", async () => {
      const api = setUp();
      api.on(`POST /admin/bookings/${BOOKING_ID}/reassign`, { status: 409, body: { error: 'assignment_locked' } });
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      const drawer = await screen.findByRole('dialog', { name: 'B-1042' });
      await user().click(await within(drawer).findByRole('button', { name: 'Assign Jonas' }));
      const confirm = await screen.findByRole('alertdialog');
      await user().click(within(confirm).getByRole('button', { name: 'Confirm Assignment' }));
      expect(await within(confirm).findByRole('alert')).toHaveTextContent("This booking's pro was confirmed by the team and can't be changed.");
      expect(within(confirm).getByRole('button', { name: 'Confirm Assignment' })).toBeEnabled();

      // Another admin got there first: closing the pop-up shows the booking as it is now.
      api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: assigned() } });
      await user().click(within(confirm).getByRole('button', { name: 'Cancel' }));
      expect(await within(drawer).findByText(/This assignment is final\./)).toBeInTheDocument();
      expect(within(drawer).queryByRole('button', { name: /^Assign/ })).not.toBeInTheDocument();
    });
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

  describe('a note when cancelling (D63)', () => {
    function openCancel() {
      const api = setUp();
      api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: detail({ status: 'accepted' }) } });
      api.on(`POST /admin/bookings/${BOOKING_ID}/cancel`, { body: { booking: detail({ status: 'cancelled', cancelledBy: 'admin' }) } });
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      return api;
    }

    it('opens a confirmation with an optional note and a tick to send it to the customer', async () => {
      const api = openCancel();
      const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
      await user().click(within(dialog).getByRole('button', { name: 'Cancel booking' }));
      const confirm = within(dialog).getByRole('alertdialog');
      const note = within(confirm).getByLabelText('Note (optional): why is the booking cancelled?');
      const send = within(confirm).getByRole('checkbox', { name: 'Send this note to the customer' });
      expect(note).toHaveValue('');
      expect(send).not.toBeChecked();
      expect(confirm).toHaveTextContent('The pro never sees it.');

      // Sending needs a note: the field says so, and nothing is sent.
      await user().click(send);
      await user().click(within(confirm).getByRole('button', { name: 'Cancel booking' }));
      expect(note).toHaveFocus();
      expect(note).toHaveAccessibleDescription(/Write the note to send it to the customer/);
      expect(api.calls).not.toContain(`POST /admin/bookings/${BOOKING_ID}/cancel`);

      await user().type(note, 'Storm warning for that day.');
      await user().click(within(confirm).getByRole('button', { name: 'Cancel booking' }));
      await waitFor(() =>
        expect(api.bodies[`POST /admin/bookings/${BOOKING_ID}/cancel`]).toEqual({ note: 'Storm warning for that day.', sendToCustomer: true }),
      );
    });

    it('cancels without a note, which stays optional', async () => {
      const api = openCancel();
      const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
      await user().click(within(dialog).getByRole('button', { name: 'Cancel booking' }));
      await user().click(within(within(dialog).getByRole('alertdialog')).getByRole('button', { name: 'Cancel booking' }));
      await waitFor(() => expect(api.bodies[`POST /admin/bookings/${BOOKING_ID}/cancel`]).toEqual({ sendToCustomer: false }));
    });

    it('shows the note in the activity log with who cancelled and when, and whether the customer got it', async () => {
      const api = setUp();
      const cancelled = detail({
        status: 'cancelled',
        cancelledBy: 'admin',
        actions: [
          {
            id: 'a1',
            action: 'cancelled',
            details: { note: 'Pro is ill.', sentToCustomer: false },
            createdAt: '2026-11-16T09:30:00.000Z',
            adminName: 'Fiona Weiss',
          },
        ],
      });
      api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: cancelled } });
      renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
      const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
      const line = within(dialog).getByText('Note: Pro is ill.', { exact: false }).closest('li') as HTMLElement;
      expect(line).toHaveTextContent('(only the team sees this)');
      expect(line).toHaveTextContent('Fiona Weiss');
      expect(line).toHaveTextContent('16 Nov');
    });
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

  it("shows the pro's on-site issue, cancellations and customer rating, and resolves the issue (D86)", async () => {
    const api = setUp([row({ status: 'accepted', pro: 'Daniel', proIssue: true })]);
    const issue = {
      id: '22222222-2222-4222-8222-222222222222',
      proId: 'u-pro',
      proName: 'Daniel',
      reason: 'customer_not_home' as const,
      details: 'Rang twice',
      createdAt: '2026-11-09T09:10:00.000Z',
      resolvedAt: null,
    };
    const reported = detail({
      status: 'accepted',
      pro: { id: 'u-pro', firstName: 'Daniel', ratingAverage: 4.9, ratingCount: 12 },
      issues: [issue],
      proCancellations: [{ proName: 'Leon', reason: 'vehicle', note: null, late: true, createdAt: '2026-11-08T09:00:00.000Z' }],
      customerProfile: { ...(detail().customerProfile as NonNullable<AdminBooking['customerProfile']>), proRatingAverage: 4.5, proRatingCount: 2 },
      actions: [
        { id: '1', action: 'issue_reported', details: { proName: 'Daniel', reason: 'customer_not_home', note: 'Rang twice' }, createdAt: issue.createdAt, adminName: null },
      ],
    });
    api.on(`GET /admin/bookings/${BOOKING_ID}`, { body: { booking: reported } });
    api.on(`POST /admin/bookings/${BOOKING_ID}/issues/${issue.id}/resolve`, {
      body: { booking: { ...reported, issues: [{ ...issue, resolvedAt: '2026-11-09T09:30:00.000Z' }] } },
    });
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    expect(await screen.findByText('Pro reported an issue')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'B-1042' });
    const reports = within(dialog).getByRole('region', { name: 'Reported by the pro' });
    expect(within(reports).getByText('Daniel reported: Customer not home')).toBeInTheDocument();
    expect(within(reports).getByText('Rang twice')).toBeInTheDocument();
    expect(within(reports).getByText(/Leon gave the job back on .*less than 24 hours before the start: Vehicle problem/)).toBeInTheDocument();
    expect(within(dialog).getByText('Daniel reported an issue: Customer not home')).toBeInTheDocument();
    expect(within(dialog).getByText('2 ratings, 4.5 stars on average')).toBeInTheDocument();

    await user().click(within(reports).getByRole('button', { name: 'Mark as resolved' }));
    expect(api.calls).toContain(`POST /admin/bookings/${BOOKING_ID}/issues/${issue.id}/resolve`);
    expect(await within(reports).findByText(/Resolved on/)).toBeInTheDocument();
  });
});

describe('admin bookings board (Kanban view)', () => {
  const PROBLEM = row({ id: '33333333-3333-4333-8333-333333333333', number: 'B-1044', status: 'completed', paymentStatus: 'captured', pro: 'Daniel', problem: true });
  const WORKING = row({ id: '44444444-4444-4444-8444-444444444444', number: 'B-1045', status: 'working', pro: 'Daniel', tab: 'live', trade: 'Cleaning' });
  const PAID = row({ id: '55555555-5555-4555-8555-555555555555', number: 'B-1046', status: 'completed', paymentStatus: 'captured', pro: 'Daniel', tab: 'done' });
  const HELD = row({ id: '66666666-6666-4666-8666-666666666666', number: 'B-1047', status: 'completed', paymentStatus: 'held', pro: 'Daniel', tab: 'done' });
  const VISIT = row({ kind: 'visit', id: '77777777-7777-4777-8777-777777777777', number: 'V-9', status: 'planned', paymentStatus: 'active', pro: 'Daniel', tab: 'upcoming' });
  const ALL = [row(), SECOND, WORKING, HELD, PAID, PROBLEM, VISIT];

  function column(name: string) {
    return screen.getByRole('region', { name: new RegExp(`^${name}`) });
  }

  it('shows both view buttons, List selected, and switches to the four columns and back', async () => {
    setUp(ALL);
    renderAt('/admin/bookings');
    const group = await screen.findByRole('group', { name: 'Bookings view' });
    const list = within(group).getByRole('button', { name: 'List View' });
    const board = within(group).getByRole('button', { name: 'Kanban View' });
    expect(list).toHaveAttribute('aria-pressed', 'true');
    expect(board).toHaveAttribute('aria-pressed', 'false');
    expect(list).toHaveClass('on');
    await screen.findByRole('table');

    await user().click(board);
    expect(board).toHaveAttribute('aria-pressed', 'true');
    expect(board).toHaveClass('on');
    expect(list).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('region').map((r) => r.querySelector('h2')?.textContent)).toEqual(['To Do 3', 'In Progress 1', 'In Review 2', 'Done 1']);
    expect(within(column('To Do')).getByText('Waiting for a pro or the start')).toBeInTheDocument();
    expect(within(column('In Review')).getByText('Being charged or a problem to check')).toBeInTheDocument();
    for (const number of ['B-1042', 'B-1043', 'V-9']) {
      expect(within(column('To Do')).getByText(number)).toBeInTheDocument();
    }
    expect(within(column('In Progress')).getByText('B-1045')).toBeInTheDocument();
    expect(within(column('In Review')).getByText('B-1044')).toBeInTheDocument();
    expect(within(column('In Review')).getByText('B-1047')).toBeInTheDocument();
    expect(within(column('Done')).getByText('B-1046')).toBeInTheDocument();

    await user().click(list);
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(list).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('starts on the board when the address says layout=kanban', async () => {
    setUp(ALL);
    renderAt('/admin/bookings?layout=kanban');
    expect(await screen.findByRole('button', { name: /^B-1042, Lawn mowing/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kanban View' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the key facts on each card, and says "Nothing here" for an empty column', async () => {
    setUp([row(), PROBLEM]);
    renderAt('/admin/bookings?layout=kanban');
    const card = await screen.findByRole('button', { name: 'B-1042, Lawn mowing, Mon 9 Nov, 10:00' });
    expect(card).toHaveTextContent('B-1042');
    expect(card).toHaveTextContent('One-off');
    expect(card).toHaveTextContent('Gardening · Mon 9 Nov, 10:00');
    expect(card).toHaveTextContent('Sara');
    expect(within(card).getByText('Unassigned')).toHaveClass('unassigned');
    expect(card).toHaveTextContent('€48.40');
    expect(card).toHaveTextContent('No pro yet');
    expect(within(card).queryByText('Problem reported')).not.toBeInTheDocument();
    const problem = screen.getByRole('button', { name: /^B-1044/ });
    expect(within(problem).getByText('Problem reported')).toHaveClass('unassigned');
    expect(within(problem).getByText('Daniel')).toBeInTheDocument();
    expect(within(column('In Progress')).getByText('Nothing here')).toBeInTheDocument();
  });

  it('opens the same panel from a card and Escape returns focus to the card', async () => {
    setUp();
    renderAt('/admin/bookings?layout=kanban');
    const card = await screen.findByRole('button', { name: /^B-1042/ });
    await user().click(card);
    await screen.findByRole('dialog', { name: 'B-1042' });
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(card).toHaveFocus();
    // The board is still there, and the card opens with the keyboard too.
    await user().keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'B-1042' });
  });

  it('keeps the open panel when switching view', async () => {
    setUp();
    renderAt(`/admin/bookings?open=b:${BOOKING_ID}`);
    await screen.findByRole('dialog', { name: 'B-1042' });
    await user().click(screen.getByRole('button', { name: 'Kanban View' }));
    expect(screen.getByRole('dialog', { name: 'B-1042' })).toBeInTheDocument();
  });

  it('applies search, trade and type to the board like the list, and sends the same request', async () => {
    setUp(ALL);
    renderAt('/admin/bookings?layout=kanban&tab=live&q=b-10&trade=cat-garden&type=booking');
    await screen.findByRole('button', { name: /^B-1042/ });
    expect(lastListQuery()?.toString()).toBe('tab=live&q=b-10&trade=cat-garden&type=booking');
    expect(screen.getByLabelText('Search')).toHaveValue('b-10');
    await user().selectOptions(screen.getByLabelText('Type'), 'Plan visit');
    await waitFor(() => expect(lastListQuery()?.get('type')).toBe('visit'));
    expect(screen.getByRole('button', { name: 'Kanban View' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows only the 10 most recent on the board, with "View all"', async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      row({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, number: `B-${2000 + i}`, tab: 'upcoming', status: 'accepted' }),
    );
    setUp(many);
    renderAt('/admin/bookings?layout=kanban');
    await screen.findByRole('button', { name: /^B-2009/ });
    expect(screen.queryByRole('button', { name: /^B-2010/ })).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'View all (14)' }));
    expect(screen.getByRole('button', { name: /^B-2013/ })).toBeInTheDocument();
  });

  it('says so when nothing matches, in the board too', async () => {
    setUp([]);
    renderAt('/admin/bookings?layout=kanban');
    expect(await screen.findByText('No bookings match these filters')).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
