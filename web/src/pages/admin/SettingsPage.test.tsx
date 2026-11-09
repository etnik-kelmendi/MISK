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
    const fee = await screen.findByLabelText('Service fee per booking (€)');
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
    expect(screen.getByText('MISK 18% · Pro 82%')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '25' } });
    expect(screen.getByText('MISK 25% · Pro 75%')).toBeInTheDocument();
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
    expect(screen.getByText('It is charged automatically 24 hours after the job is marked done.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bookings → Needs action' })).toHaveAttribute('href', '/admin/bookings?tab=needs_action');
    expect(screen.getByText('Free until 24 hours before the visit.')).toBeInTheDocument();
    expect(screen.getByText('Later, the customer pays the full price.')).toBeInTheDocument();
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
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).slice(0, 4)).toEqual(['Name', 'Role', 'Access', 'Last active']);
    const sam = within(table).getByText('Sam').closest('tr') as HTMLElement;
    expect(sam).toHaveTextContent('Overview, Bookings, Providers');
    expect(sam).toHaveTextContent('Never');
    const role = within(sam).getByRole('combobox', { name: 'Role of Sam' });
    expect([...(role as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Admin', 'Operations', 'Support', 'Finance']);
    await user().selectOptions(role, 'Finance');
    expect(api.bodies['PATCH /admin/team/u-sam/role']).toEqual({ role: 'finance' });
  });

  it('invites a teammate by email', async () => {
    const api = teamApi();
    api.on('POST /admin/team/invite', { status: 201, body: { member: member({ id: 'u-new', role: 'operations' }) } });
    renderAt('/admin/settings/team');
    await user().click(await screen.findByRole('button', { name: 'Invite teammate' }));
    const form = screen.getByRole('form', { name: 'Invite a teammate' });
    await user().type(within(form).getByLabelText('Email address'), 'nora@misk.app');
    await user().selectOptions(within(form).getByLabelText('Role'), 'Operations');
    await user().click(within(form).getByRole('button', { name: 'Send invite' }));
    expect(api.bodies['POST /admin/team/invite']).toEqual({ email: 'nora@misk.app', role: 'operations' });
    expect(await screen.findByText('Invite sent to nora@misk.app. The link works for 7 days.')).toBeInTheDocument();
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
});
