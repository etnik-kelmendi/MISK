import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderAt, users } from '../../test/harness';
import type { Delivery, UserDetail, UserRow } from './UsersPage';

const user = () => userEvent.setup();

const row = (overrides: Partial<UserRow>): UserRow => ({
  id: 'u-sara',
  firstName: 'Sara',
  lastName: 'Meier',
  email: 'sara@example.com',
  phone: '+4915100000001',
  types: ['customer'],
  status: 'active',
  joinedAt: '2026-09-01T10:00:00.000Z',
  lastActive: '2026-11-15T18:00:00.000Z',
  ...overrides,
});
const SARA = row({});
const delivery = (channels: Delivery['channels'], notSetUp: Delivery['channels'] = []): Delivery => ({ inApp: true, channels, notSetUp });
const DANIEL = row({ id: 'u-daniel', firstName: 'Daniel', lastName: null, email: null, phone: '+4915100000101', types: ['customer', 'pro'] });

const detail = (overrides: Partial<UserDetail> = {}): UserDetail => ({
  ...SARA,
  emailConfirmed: true,
  hasPassword: true,
  suspendedAt: null,
  suspendedReason: null,
  suspendedMessage: null,
  deletedAt: null,
  deletedReason: null,
  bookings: { total: 7, upcoming: 1, completed: 5, cancelled: 1 },
  activePlans: [{ id: 's1', name: 'Weekly lawn care', status: 'active' }],
  pro: null,
  actions: [],
  ...overrides,
});

function adminApi() {
  const api = fakeApi(users.admin);
  api.on('GET /admin/badges', { body: { applications: 0 } });
  api.on('GET /admin/users', ({ url }) => {
    const q = url.searchParams.get('q') ?? '';
    const type = url.searchParams.get('type');
    const all = [SARA, DANIEL];
    const found = all.filter(
      (u) => (!q || `${u.firstName} ${u.lastName ?? ''} ${u.email ?? ''}`.toLowerCase().includes(q.toLowerCase())) && (!type || u.types.includes(type as 'pro')),
    );
    return { body: { users: found, matching: found.length, total: 312 } };
  });
  return api;
}

describe('the Users page (D65)', () => {
  it('is in the side menu and lists every user with name, email, phone, type, status, joined and last active', async () => {
    adminApi();
    renderAt('/admin');
    const menu = await screen.findByRole('navigation', { name: 'Control panel' });
    await user().click(within(menu).getByRole('link', { name: 'Users' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Name',
      'Email',
      'Phone number',
      'Type',
      'Status',
      'Joined',
      'Last active',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Sara Meier');
    expect(rows[0]).toHaveTextContent('sara@example.com');
    expect(rows[0]).toHaveTextContent('+4915100000001');
    // A pro who also books is one row with both types.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('CustomerPro');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 312 shown');
  });

  it('searches and filters, and says how many are shown', async () => {
    const api = adminApi();
    renderAt('/admin/users');
    await screen.findByRole('table');
    await user().type(screen.getByLabelText('Search'), 'sara');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 312 shown'));
    expect(api.calls).toContain('GET /admin/users');
    await user().clear(screen.getByLabelText('Search'));
    await user().selectOptions(screen.getByLabelText('Type'), 'Pros');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2));
    expect(within(screen.getByRole('table')).getByText('Daniel')).toBeInTheDocument();
    expect([...(screen.getByLabelText('Status') as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      'All statuses',
      'Active',
      'Suspended',
      'Deleted',
    ]);
  });

  it('opens a user with their details, bookings, plans and, for a pro, rating and documents', async () => {
    const api = adminApi();
    api.on('GET /admin/users/u-daniel', {
      body: {
        user: detail({
          ...DANIEL,
          pro: {
            status: 'approved',
            ratingAverage: 4.7,
            ratingCount: 12,
            jobsDone: 30,
            documents: [
              { kind: 'id', ok: true, state: 'valid', expiresOn: '2030-01-01' },
              { kind: 'insurance', ok: false, state: 'expired', expiresOn: '2026-10-01' },
            ],
          },
        }),
      },
    });
    renderAt('/admin/users');
    await user().click(await screen.findByRole('button', { name: 'Daniel' }));
    const panel = await screen.findByRole('dialog', { name: 'Daniel' });
    expect(panel).toHaveTextContent('7 in total · 1 coming up · 5 done · 1 cancelled');
    expect(panel).toHaveTextContent('Weekly lawn care');
    expect(panel).toHaveTextContent('4.7 from 12 ratings');
    expect(within(panel).getByText('Liability insurance').closest('li')).toHaveTextContent('Open');
  });

  it('sends a message, and suspends only after a confirmation with a reason', async () => {
    const api = adminApi();
    api.on('GET /admin/users/u-sara', { body: { user: detail() } });
    api.on('POST /admin/users/u-sara/message', {
      body: {
        user: detail({
          actions: [{ id: '1', action: 'messaged', details: { text: 'Hi', channels: ['sms', 'email'] }, createdAt: '2026-11-16T10:00:00.000Z', adminName: 'admin' }],
        }),
        delivery: delivery(['sms', 'email']),
      },
    });
    api.on('POST /admin/users/u-sara/suspend', {
      body: {
        user: detail({ status: 'suspended', suspendedAt: '2026-11-16T10:05:00.000Z', suspendedReason: 'Repeated no-shows' }),
        delivery: delivery(['sms', 'email']),
      },
    });
    renderAt('/admin/users?open=u-sara');
    const panel = await screen.findByRole('dialog', { name: 'Sara Meier' });

    await user().click(within(panel).getByRole('button', { name: 'Message' }));
    await user().click(within(panel).getByRole('button', { name: 'Send message' }));
    expect(within(panel).getByText('Write the message first.')).toBeInTheDocument();
    await user().type(within(panel).getByLabelText('Message from the MISK team'), 'Please call us.');
    await user().click(within(panel).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.bodies['POST /admin/users/u-sara/message']).toEqual({ text: 'Please call us.' }));
    // The team sees how it went out (D87).
    expect(await within(panel).findByText('Message sent in the app, by text, and by email.')).toBeInTheDocument();
    expect(within(panel).getByText('Sent a message').closest('li')).toHaveTextContent('Sent in the app, by text, and by email');

    await user().click(within(panel).getByRole('button', { name: 'Suspend' }));
    const confirm = within(panel).getByRole('alertdialog', { name: 'Suspend this account?' });
    await user().click(within(confirm).getByRole('button', { name: 'Suspend account' }));
    expect(within(confirm).getByLabelText(/Reason/)).toHaveFocus();
    expect(api.calls).not.toContain('POST /admin/users/u-sara/suspend');
    await user().type(within(confirm).getByLabelText(/Reason/), 'Repeated no-shows');
    await user().click(within(confirm).getByRole('button', { name: 'Suspend account' }));
    await waitFor(() => expect(api.bodies['POST /admin/users/u-sara/suspend']).toEqual({ reason: 'Repeated no-shows' }));
    expect(await within(panel).findByText(/Suspended on 16 Nov 2026: Repeated no-shows/)).toBeInTheDocument();
    expect(within(panel).getByText('The account is suspended. They were told in the app, by text, and by email.')).toBeInTheDocument();
    expect(within(panel).getByText('No message was shared with them; the reason stays internal.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Reinstate' })).toBeInTheDocument();
  });

  it('deletes an account only after a confirmation with a reason, and then offers nothing more', async () => {
    const api = adminApi();
    api.on('GET /admin/users/u-sara', { body: { user: detail() } });
    api.on('POST /admin/users/u-sara/delete', {
      body: {
        user: detail({
          firstName: null,
          lastName: null,
          email: null,
          phone: null,
          status: 'deleted',
          deletedAt: '2026-11-16T11:00:00.000Z',
          deletedReason: 'Asked to be removed',
        }),
        delivery: delivery(['email']),
      },
    });
    renderAt('/admin/users?open=u-sara');
    const panel = await screen.findByRole('dialog', { name: 'Sara Meier' });
    await user().click(within(panel).getByRole('button', { name: 'Delete user' }));
    const confirm = within(panel).getByRole('alertdialog', { name: 'Delete this account for good?' });
    expect(confirm).toHaveTextContent('This cannot be undone.');
    await user().type(within(confirm).getByLabelText(/Reason/), 'Asked to be removed');
    await user().click(within(confirm).getByRole('button', { name: 'Delete account' }));
    expect(await within(panel).findByText(/Closed on 16 Nov 2026: Asked to be removed/)).toBeInTheDocument();
    // A closed account cannot open the app, so only the email counts.
    expect(within(panel).getByText('The account is closed. They were told by email.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });
});

describe('telling people how they were reached (D87)', () => {
  it('lets the team write what the suspended person is told, separate from the internal reason', async () => {
    const api = adminApi();
    api.on('GET /admin/users/u-sara', { body: { user: detail() } });
    api.on('POST /admin/users/u-sara/suspend', {
      body: {
        user: detail({
          status: 'suspended',
          suspendedAt: '2026-11-16T10:05:00.000Z',
          suspendedReason: 'Chargeback',
          suspendedMessage: 'Please call us about your last payment.',
        }),
        delivery: delivery(['sms', 'email'], ['sms']),
      },
    });
    renderAt('/admin/users?open=u-sara');
    const panel = await screen.findByRole('dialog', { name: 'Sara Meier' });
    await user().click(within(panel).getByRole('button', { name: 'Suspend' }));
    const confirm = within(panel).getByRole('alertdialog', { name: 'Suspend this account?' });
    expect(within(confirm).getByLabelText('Message to the person (optional)')).toHaveAccessibleDescription(
      'Sent to them with the notice and shown when they try to sign in. The reason above stays internal.',
    );
    await user().type(within(confirm).getByLabelText(/Reason/), 'Chargeback');
    await user().type(within(confirm).getByLabelText('Message to the person (optional)'), '  Please call us about your last payment. ');
    await user().click(within(confirm).getByRole('button', { name: 'Suspend account' }));
    await waitFor(() =>
      expect(api.bodies['POST /admin/users/u-sara/suspend']).toEqual({ reason: 'Chargeback', message: 'Please call us about your last payment.' }),
    );
    const status = await within(panel).findByText('The account is suspended. They were told in the app, by text, and by email.');
    // The server has no SMS service yet: the team is told no text went out.
    expect(status.closest('[role="status"]')).toHaveTextContent('Text messages are not set up on the server yet, so no text went out.');
    expect(within(panel).getByText('Told them: Please call us about your last payment.')).toBeInTheDocument();
  });

  it('shows a person\x27s own phone changes in the activity log', async () => {
    const api = adminApi();
    api.on('GET /admin/users/u-sara', {
      body: {
        user: detail({
          actions: [
            { id: '2', action: 'phone_added', details: {}, createdAt: '2026-11-17T09:00:00.000Z', adminName: null },
            {
              id: '1',
              action: 'suspended',
              details: { reason: 'Spam', message: 'Call us', cancelledBookings: 1, endedPlans: 0, channels: ['email'] },
              createdAt: '2026-11-16T09:00:00.000Z',
              adminName: 'admin',
            },
          ],
        }),
      },
    });
    renderAt('/admin/users?open=u-sara');
    const panel = await screen.findByRole('dialog', { name: 'Sara Meier' });
    const added = within(panel).getByText('Added a phone number').closest('li');
    expect(added).toHaveTextContent('By the person themselves');
    const suspended = within(panel).getByText('Suspended the account').closest('li');
    expect(suspended).toHaveTextContent('Told them: Call us');
    expect(suspended).toHaveTextContent('Sent in the app and by email');
  });
});

describe('a pro who also books (D64)', () => {
  it('opens the customer app from the pro profile, with a tab back to the pro app', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', {
      body: {
        profile: {
          status: 'approved',
          payoutsEnabled: true,
          homePostcode: '10115',
          radiusKm: 12,
          workingDays: [1],
          trades: [],
          tradeNames: [],
          pendingTrades: [],
          ratingAverage: null,
          ratingCount: 0,
          documents: { id: null, certificate: null, insurance: null, background: null },
        },
      },
    });
    api.on('GET /pro/profile/overview', { body: { overview: { jobsDone: 0, documents: { expiring: 0, expired: 0, checking: 0 }, bankLast4: null, topPercent: null } } });
    api.on('GET /pro/payouts', { body: { payouts: { sharePct: 82, interval: 'weekly', nextPayoutOn: '2026-11-20', bankLast4: '3000' } } });
    renderAt('/pro/profile');
    const book = await screen.findByRole('link', { name: /Switch to customer app/ });
    expect(book).toHaveAttribute('href', '/');
    await user().click(book);
    const menu = await screen.findByRole('navigation', { name: 'Main menu' });
    expect(within(menu).getByRole('link', { name: 'Pro app' })).toHaveAttribute('href', '/pro');
    expect(within(menu).queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
    // Four buttons, as for every customer (D89), with the pro app in Profile's place.
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Bookings', 'Plans', 'Pro app']);
  });
});
