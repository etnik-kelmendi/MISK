import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActivityEntry, NotificationSettings, PlatformSettings, TeamMember, Zone } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

const user = () => userEvent.setup();

const settings: PlatformSettings = {
  serviceFeeCents: 290,
  commissionPct: 18,
  proSharePct: 82,
  payoutInterval: 'weekly',
  nextPayoutOn: '2026-11-13',
  freeCancelHours: 24,
  chargeDelayHours: 24,
};

function adminApi() {
  const api = fakeApi(users.admin);
  api.on('GET /admin/badges', { body: { applications: 0 } });
  api.on('GET /admin/settings', { body: { settings } });
  return api;
}

describe('settings: fees and payments', () => {
  it('saves the service fee when the field is left and says all changes are saved', async () => {
    const api = adminApi();
    api.on('PATCH /admin/settings', ({ body }) => ({ body: { settings: { ...settings, ...(body as object) } } }));
    renderAt('/admin/settings');
    const fee = await screen.findByLabelText('Customer service fee');
    expect(screen.getByText('All changes saved', { exact: false })).toBeInTheDocument();
    await user().clear(fee);
    await user().type(fee, '3,50');
    fireEvent.blur(fee);
    await waitFor(() => expect(api.bodies['PATCH /admin/settings']).toEqual({ serviceFeeCents: 350 }));
    expect(await screen.findByText('All changes saved', { exact: false })).toBeInTheDocument();
    // The field starts afresh with the saved price.
    const saved = await screen.findByDisplayValue('3.50');
    await user().clear(saved);
    await user().type(saved, 'lots{Enter}');
    expect(await screen.findByText(/Enter an amount from €0 to €100/)).toBeInTheDocument();
  });

  it('shows the MISK and pro share on the commission slider and saves it', async () => {
    const api = adminApi();
    api.on('PATCH /admin/settings', ({ body }) => ({ body: { settings: { ...settings, commissionPct: 25, proSharePct: 75, ...(body as object) } } }));
    renderAt('/admin/settings');
    const slider = await screen.findByRole('slider', { name: 'MISK commission: 18%' });
    expect(slider).toHaveAttribute('min', '10');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('aria-valuetext', 'MISK 18% · Pro 82%');
    expect(screen.getByText('Pro 82%')).toBeInTheDocument();
    expect(screen.getByText('Pro 82% · MISK 18%', { selector: '.badge' })).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '25' } });
    expect(screen.getByText('Pro 75%')).toBeInTheDocument();
    // The cancellation and tip splits follow the slider straight away.
    expect(screen.getByText('Pro 75% · MISK 25%', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText(/the pro earns €34.12 and MISK keeps €11.38/)).toBeInTheDocument();
    await waitFor(() => expect(api.bodies['PATCH /admin/settings']).toEqual({ commissionPct: 25 }));
  });

  it('chooses how often pros are paid and explains charging, cancellations and tips', async () => {
    const api = adminApi();
    api.on('PATCH /admin/settings', { body: { settings: { ...settings, payoutInterval: 'biweekly', nextPayoutOn: '2026-11-20' } } });
    renderAt('/admin/settings');
    await user().click(await screen.findByRole('radio', { name: /Every 2 weeks/ }));
    expect(api.bodies['PATCH /admin/settings']).toEqual({ payoutInterval: 'biweekly' });
    expect(await screen.findByText(/Next payout: 20 Nov 2026/)).toBeInTheDocument();
    const flow = screen.getByRole('list', { name: 'When customers are charged' });
    expect(within(flow).getAllByRole('listitem').map((step) => step.querySelector('b')?.textContent)).toEqual([
      'Job marked done',
      '24 hours to review',
      'Payment goes through',
    ]);
    expect(screen.getByText(/the payment is put on hold/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bookings → Needs action' })).toHaveAttribute('href', '/admin/bookings?tab=needs_action');
    expect(screen.getByText(/Up to 24 hours before the visit. After that the customer pays the full price/)).toBeInTheDocument();
    expect(screen.getByText(/Paid to the bank account the pro added in the app/)).toBeInTheDocument();
    expect(screen.getByText(/of a €5 tip the pro gets €4.10 and MISK €0.90/)).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Plans' })).toHaveAttribute('href', '/admin/plans');
  });
});

describe('settings: service area', () => {
  const zones: Zone[] = [
    { code: '10115', name: 'Mitte', lat: 52.53, lng: 13.38, live: true, pros: 4, bookingsPerWeek: 12.5, waiting: 0 },
    { code: '10178', name: 'Alexanderplatz', lat: 52.52, lng: 13.41, live: false, pros: 2, bookingsPerWeek: 0, waiting: 7 },
  ];

  it('draws live zones green and waitlist zones yellow, with their numbers', async () => {
    const api = adminApi();
    api.on('GET /admin/zones', { body: { zones, elsewhere: [{ postcode: '99999', waiting: 3 }] } });
    const { container } = renderAt('/admin/settings/area');
    expect(await screen.findByRole('img', { name: 'Map of service zones' })).toBeInTheDocument();
    expect(container.querySelectorAll('.zone.live')).toHaveLength(1);
    expect(container.querySelectorAll('.zone.waiting')).toHaveLength(1);
    expect(screen.getByText('4 pros · 12.5 bookings a week')).toBeInTheDocument();
    expect(screen.getByText('7 waiting · 2 pros nearby')).toBeInTheDocument();
    expect(screen.getByText('99999: 3 waiting')).toBeInTheDocument();
  });

  it('goes live and tells how many were notified; pausing asks first', async () => {
    const api = adminApi();
    api.on('GET /admin/zones', { body: { zones, elsewhere: [] } });
    api.on('POST /admin/zones/10178/go-live', { body: { notified: 7 } });
    api.on('POST /admin/zones/10115/pause', { body: { paused: true } });
    renderAt('/admin/settings/area');
    await user().click(await screen.findByRole('button', { name: 'Go live in 10178' }));
    expect(await screen.findByText('10178 is live. 7 people waiting were told.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Pause 10115' }));
    expect(api.calls).not.toContain('POST /admin/zones/10115/pause');
    await user().click(screen.getByRole('button', { name: 'Pause zone' }));
    expect(await screen.findByText(/10115 is paused/)).toBeInTheDocument();
  });

  it('says under the field what is wrong when latitude and longitude are the same, and sends nothing', async () => {
    const api = adminApi();
    api.on('GET /admin/zones', { body: { zones, elsewhere: [] } });
    renderAt('/admin/settings/area');
    await user().type(await screen.findByLabelText('Postcode'), '10179');
    await user().type(screen.getByLabelText('Area name'), 'Mitte East');
    await user().type(screen.getByLabelText('Latitude'), '52.5115');
    await user().type(screen.getByLabelText('Longitude'), '52.5115');
    await user().click(screen.getByRole('button', { name: 'Add zone' }));

    const longitude = screen.getByLabelText('Longitude');
    expect(longitude).toHaveAttribute('aria-invalid', 'true');
    expect(longitude).toHaveAccessibleDescription('Longitude cannot be the same as latitude. Copy both numbers from the map again.');
    expect(longitude).toHaveFocus();
    expect(screen.getByLabelText('Latitude')).toHaveAttribute('aria-invalid', 'false');
    expect(api.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
  });

  it('warns that swapped coordinates are far from the other zones', async () => {
    const api = adminApi();
    api.on('GET /admin/zones', { body: { zones, elsewhere: [] } });
    renderAt('/admin/settings/area');
    await user().type(await screen.findByLabelText('Postcode'), '10179');
    await user().type(screen.getByLabelText('Area name'), 'Mitte East');
    await user().type(screen.getByLabelText('Latitude'), '13.4167');
    await user().type(screen.getByLabelText('Longitude'), '52.5115');
    await user().click(screen.getByRole('button', { name: 'Add zone' }));
    expect(await screen.findByText(/km from your nearest zone \(10178\)\. Check that latitude and longitude are not swapped\./)).toBeInTheDocument();
    expect(api.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
  });

  it('fills both fields from coordinates pasted from a map, then saves the zone', async () => {
    const api = adminApi();
    api.on('GET /admin/zones', { body: { zones, elsewhere: [] } });
    api.on('PUT /admin/zones/10179', ({ body }) => ({
      body: { zone: { code: '10179', ...(body as object), live: false, pros: 0, bookingsPerWeek: 0, waiting: 0 } },
    }));
    renderAt('/admin/settings/area');
    await user().type(await screen.findByLabelText('Postcode'), '10179');
    await user().type(screen.getByLabelText('Area name'), 'Mitte East');
    await user().click(screen.getByLabelText('Latitude'));
    await user().paste('52.5115, 13.4167');
    expect(screen.getByLabelText('Latitude')).toHaveValue('52.5115');
    expect(screen.getByLabelText('Longitude')).toHaveValue('13.4167');
    await user().click(screen.getByRole('button', { name: 'Add zone' }));
    expect(await screen.findByText('Zone 10179 added to the waitlist.')).toBeInTheDocument();
    expect(api.bodies['PUT /admin/zones/10179']).toEqual({ name: 'Mitte East', lat: 52.5115, lng: 13.4167 });
  });
});

describe('settings: notifications', () => {
  const data: NotificationSettings = {
    messages: [
      { kind: 'booking_confirmed', audience: 'customer', push: true, sms: true, email: true },
      { kind: 'booking_reminder', audience: 'customer', push: true, sms: true, email: false },
      { kind: 'pro_on_the_way', audience: 'customer', push: true, sms: true, email: false },
      { kind: 'extra_requested', audience: 'customer', push: true, sms: true, email: false },
      { kind: 'job_completed', audience: 'customer', push: true, sms: true, email: true },
      { kind: 'rating_request', audience: 'customer', push: true, sms: true, email: true },
      { kind: 'job_offer', audience: 'pro', push: true, sms: true, email: false },
      { kind: 'payout_sent', audience: 'pro', push: true, sms: true, email: true },
    ],
    ready: { push: true, sms: true, email: true },
    me: { phone: null, email: 'me@misk.app', push: false },
  };

  it('lists the eight messages with who receives them and a checkbox per channel', async () => {
    const api = adminApi();
    api.on('GET /admin/notifications', { body: data });
    api.on('GET /push/key', { body: { publicKey: null } });
    api.on('PATCH /admin/notifications/job_offer', {
      body: { ...data, messages: data.messages.map((m) => (m.kind === 'job_offer' ? { ...m, email: true } : m)) },
    });
    renderAt('/admin/settings/notifications');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Booking confirmed',
      'Reminder the evening before',
      'Pro is on the way',
      'Extra work needs approval',
      'Job done with photos',
      'Ask for a rating',
      'New job offer',
      'Payout sent',
    ]);
    expect(rows[6]).toHaveTextContent('Pro');
    expect(rows[0]).toHaveTextContent('Customer');
    const email = screen.getByRole('checkbox', { name: 'Email for New job offer' });
    expect(email).not.toBeChecked();
    await user().click(email);
    expect(api.bodies['PATCH /admin/notifications/job_offer']).toEqual({ email: true });
    expect(await screen.findByRole('checkbox', { name: 'Email for New job offer' })).toBeChecked();
  });

  it('sends a test to the admin and says what is missing', async () => {
    const api = adminApi();
    api.on('GET /admin/notifications', { body: data });
    api.on('GET /push/key', { body: { publicKey: null } });
    api.on('POST /admin/notifications/booking_confirmed/test', { body: { sent: { sms: false, email: true, push: 0 }, missing: ['phone', 'push'] } });
    api.on('PATCH /admin/me/phone', { body: { phone: '+4915123456789' } });
    renderAt('/admin/settings/notifications');
    await user().click(await screen.findByRole('button', { name: 'Send me a test of Booking confirmed' }));
    expect(await screen.findByText(/Test sent: email\. Add your phone number below for SMS tests\./)).toBeInTheDocument();
    const phone = screen.getByLabelText('Your phone for test messages');
    await user().type(phone, '+49 151 23456789');
    fireEvent.blur(phone);
    await waitFor(() => expect(api.bodies['PATCH /admin/me/phone']).toEqual({ phone: '+49 151 23456789' }));
  });
});

describe('settings: team and access', () => {
  const member = (overrides: Partial<TeamMember>): TeamMember => ({
    id: 'u-admin',
    username: 'admin',
    email: 'admin@misk.app',
    firstName: 'Elion',
    lastName: 'Thaqi',
    role: 'admin',
    createdAt: '2026-11-01T00:00:00.000Z',
    invitedAt: null,
    disabled: false,
    pending: false,
    lastActive: '2026-11-09T09:00:00.000Z',
    ...overrides,
  });
  const access = {
    admin: [],
    operations: ['overview', 'bookings', 'providers', 'plans', 'catalogue', 'zones', 'notifications'],
    support: ['overview', 'bookings', 'providers'],
    finance: ['overview', 'bookings', 'fees'],
  };
  const activity: ActivityEntry[] = [
    {
      id: 'settings-2',
      area: 'fees',
      action: 'commission',
      details: { from: 18, to: 20 },
      createdAt: '2026-11-09T10:00:00.000Z',
      subject: null,
      adminName: 'admin@misk.app',
      adminFullName: 'Elion Thaqi',
    },
    {
      id: 'catalogue-1',
      area: 'catalogue',
      action: 'price_changed',
      details: { from: 3500, to: 3900 },
      createdAt: '2026-11-09T09:00:00.000Z',
      subject: 'Lawn mowing',
      adminName: 'sam@misk.app',
      adminFullName: 'Sam',
    },
  ];

  function teamApi() {
    const api = adminApi();
    api.on('GET /admin/team', { body: { admins: [] } });
    api.on('GET /admin/team/members', {
      body: {
        members: [member({}), member({ id: 'u-sam', username: 'sam@misk.app', email: 'sam@misk.app', firstName: 'Sam', lastName: null, role: 'support', lastActive: null })],
        access,
      },
    });
    api.on('GET /admin/activity', { body: { activity } });
    return api;
  }

  it('shows name, role, access and last active, and changes a role', async () => {
    const api = teamApi();
    api.on('PATCH /admin/team/u-sam/role', { body: { member: member({ id: 'u-sam', role: 'finance' }) } });
    renderAt('/admin/settings/team');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(0, 4)).toEqual(['Name', 'Role', 'Can access', 'Last active']);
    const sam = within(table).getByText('Sam').closest('tr') as HTMLElement;
    expect(sam).toHaveTextContent('Overview, Bookings, Providers');
    expect(sam).toHaveTextContent('Never');
    const role = within(sam).getByRole('combobox', { name: 'Role of Sam' });
    expect([...(role as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Admin', 'Operations', 'Support', 'Finance']);
    await user().selectOptions(role, 'Finance');
    expect(api.bodies['PATCH /admin/team/u-sam/role']).toEqual({ role: 'finance' });
  });

  it('creates a shareable invitation link for a role, copies it, and lists it until it is used or withdrawn', async () => {
    const api = teamApi();
    const open = { id: 'inv-1', role: 'operations', createdAt: '2026-11-12T10:00:00.000Z', expiresAt: '2026-11-19T10:00:00.000Z', createdBy: 'Elion Thaqi' };
    let invites: (typeof open)[] = [];
    api.on('GET /admin/team/invites', () => ({ body: { invites } }));
    api.on('POST /admin/team/invites', () => {
      invites = [open];
      return { status: 201, body: { invite: open, link: 'http://localhost:5174/admin/join#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' } };
    });
    api.on('DELETE /admin/team/invites/inv-1', () => {
      invites = [];
      return { status: 204 };
    });
    renderAt('/admin/settings/team');
    await user().click(await screen.findByRole('button', { name: 'Invite teammate' }));
    const form = screen.getByRole('form', { name: 'Invite a teammate' });
    expect(within(form).queryByLabelText(/email/i)).not.toBeInTheDocument();
    await user().selectOptions(within(form).getByLabelText('Role'), 'Operations');
    await user().click(within(form).getByRole('button', { name: 'Create invitation link' }));
    expect(api.bodies['POST /admin/team/invites']).toEqual({ role: 'operations' });

    const link = await screen.findByRole('textbox', { name: 'Invitation link' });
    expect(link).toHaveValue('http://localhost:5174/admin/join#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    expect(screen.getByText(/works once, for 7 days/)).toBeInTheDocument();
    // user-event gives the page a clipboard to write to; read back what was copied.
    const clipboardUser = user();
    await clipboardUser.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await navigator.clipboard.readText()).toBe('http://localhost:5174/admin/join#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
    expect(await screen.findByText(/Link copied/)).toBeInTheDocument();

    const list = await screen.findByRole('region', { name: 'Open invitation links' });
    expect(list).toHaveTextContent('Operations · created by Elion Thaqi');
    await user().click(within(list).getByRole('button', { name: 'Withdraw the Operations invitation link' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Open invitation links' })).not.toBeInTheDocument());
    expect(api.calls).toContain('DELETE /admin/team/invites/inv-1');
  });

  it('shows who did what and when, newest first', async () => {
    teamApi();
    renderAt('/admin/settings/team');
    const log = await screen.findByRole('region', { name: 'Activity log' });
    const items = await within(log).findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Changed the commission from 18% to 20%');
    expect(items[0]).toHaveTextContent('Elion Thaqi');
    expect(items[1]).toHaveTextContent('Lawn mowing: price changed');
    expect(items[1]).toHaveTextContent('Sam');
  });

  it('names the teammate in account changes', async () => {
    const api = teamApi();
    const line = (id: string, action: string, name: string): ActivityEntry => ({
      id,
      area: 'team',
      action,
      details: { name },
      createdAt: '2026-11-12T10:00:00.000Z',
      subject: null,
      adminName: 'admin@misk.app',
      adminFullName: 'Elion Thaqi',
    });
    api.on('GET /admin/activity', {
      body: {
        activity: [
          line('settings-6', 'request_declined', 'Arta Berisha'),
          line('settings-5', 'request_approved', 'Lina Hoxha'),
          line('settings-4', 'request_approved_by_link', 'Ina Krasniqi'),
          line('settings-3', 'account_created', 'drita'),
          line('settings-2', 'password_reset', 'drita'),
          line('settings-1', 'email_changed', 'drita@misk.app'),
        ],
      },
    });
    renderAt('/admin/settings/team');
    const log = await screen.findByRole('region', { name: 'Activity log' });
    const items = await within(log).findAllByRole('listitem');
    [
      'Declined the account request from Arta Berisha',
      'Approved the account request from Lina Hoxha',
      'Approved the account request from Ina Krasniqi with the email link',
      'Created an admin account for drita',
      'Set a new password for drita',
      'Changed the email of drita@misk.app',
    ].forEach((text, index) => expect(items[index]).toHaveTextContent(text));
  });
});
