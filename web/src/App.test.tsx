import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomerBooking, ProProfile } from './api/types';
import { fakeApi, renderAt, users } from './test/harness';

const user = () => userEvent.setup();

function booking(overrides: Partial<CustomerBooking> = {}): CustomerBooking {
  return {
    id: 'b1',
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
    events: [
      { status: 'awaiting_payment', at: '2026-11-04T09:00:00.000Z' },
      { status: 'searching', at: '2026-11-04T09:00:01.000Z' },
      { status: 'accepted', at: '2026-11-04T09:03:00.000Z' },
    ],
    photos: [],
    extras: [],
    rating: null,
    priceCents: 4550,
    feeCents: 290,
    extrasCents: 0,
    totalCents: 4840,
    paymentStatus: 'held',
    pro: { id: 'u-pro', firstName: 'Daniel', ratingAverage: 4.9, ratingCount: 12 },
    canCancel: true,
    canRate: false,
    ...overrides,
  };
}

describe('sign-in', () => {
  it('signs a new person in by phone code and lets them choose to be a customer', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/phone/start', { status: 202, body: { phone: '+4915112345678' } });
    api.on('POST /auth/phone/verify', { body: { user: users.new } });
    api.on('POST /account/role', { body: { user: { ...users.new, role: 'customer', firstName: 'Sara' } } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/');

    await user().type(await screen.findByLabelText('Mobile number'), '+49 151 12345678');
    await user().click(screen.getByRole('button', { name: /Send me a sign-in code/ }));
    await user().type(await screen.findByLabelText('6-digit code'), '123456');
    await user().click(screen.getByRole('button', { name: 'Sign in' }));
    await user().type(await screen.findByLabelText('Your first name'), 'Sara');
    await user().click(screen.getByRole('button', { name: /Open the customer app/ }));

    expect(await screen.findByRole('heading', { name: 'Sara' })).toBeInTheDocument();
    expect(api.bodies['POST /account/role']).toEqual({ role: 'customer', firstName: 'Sara' });
  });

  it('offers sign-up on the sign-in page and remembers the choice in the address', async () => {
    fakeApi(null);
    renderAt('/signin');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByRole('heading', { name: 'Create your MISK account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Create my account/ })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: 'Sign in', pressed: false }));
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('opens straight into sign-up from a link', async () => {
    fakeApi(null);
    renderAt('/signin?mode=signup');
    expect(await screen.findByRole('heading', { name: 'Create your MISK account' })).toBeInTheDocument();
  });

  it('explains a wrong code', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/phone/start', { status: 202, body: { phone: '+4915112345678' } });
    api.on('POST /auth/phone/verify', { status: 401, body: { error: 'invalid_code' } });
    renderAt('/signin');
    await user().type(await screen.findByLabelText('Mobile number'), '+4915112345678');
    await user().click(screen.getByRole('button', { name: /Send me a sign-in code/ }));
    await user().type(await screen.findByLabelText('6-digit code'), '000000');
    await user().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right');
  });

  it('sends each role to its own app', async () => {
    fakeApi(users.pro);
    renderAt('/bookings');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Bookings' })).not.toBeInTheDocument());
  });
});

describe('booking a job', () => {
  it('walks details, time and payment, then opens the booking', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /availability', {
      body: {
        slots: [
          { startsAt: '2026-11-06T07:00:00.000Z', endsAt: '2026-11-06T08:00:00.000Z', freePros: 0, available: false },
          { startsAt: '2026-11-06T09:00:00.000Z', endsAt: '2026-11-06T10:00:00.000Z', freePros: 2, available: true },
        ],
      },
    });
    api.on('POST /bookings', { status: 201, body: { booking: booking({ status: 'searching', pro: null }), payment: null } });
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'searching', pro: null }) } });
    renderAt('/book/svc-mow');

    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().selectOptions(await screen.findByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('radio', { name: /Large/ }));
    expect(screen.getByRole('button', { name: 'Continue · €59.50' })).toBeEnabled();
    await user().click(screen.getByRole('radio', { name: /Medium/ }));
    await user().click(screen.getByRole('button', { name: 'Continue · €45.50' }));

    expect(await screen.findByRole('button', { name: /08:00/ })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: /Continue · Fri 6 Nov, 10:00/ }));

    expect(screen.getByText('€48.40')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Book and pay €48.40' }));
    expect(await screen.findByText(/Finding your pro/)).toBeInTheDocument();
    expect(api.bodies['POST /bookings']).toMatchObject({
      serviceId: 'svc-mow',
      size: 'M',
      postcode: '10115',
      startsAt: '2026-11-06T09:00:00.000Z',
    });
  });

  it('says so when the slot was just taken', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /availability', {
      body: { slots: [{ startsAt: '2026-11-06T09:00:00.000Z', endsAt: '2026-11-06T10:00:00.000Z', freePros: 1, available: true }] },
    });
    api.on('POST /bookings', { status: 409, body: { error: 'slot_unavailable' } });
    renderAt('/book/svc-mow');
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().selectOptions(await screen.findByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('button', { name: /Continue/ }));
    await user().click(await screen.findByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: /Continue · / }));
    await user().click(screen.getByRole('button', { name: /Book and pay/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That time was just taken');
  });
});

describe('a booking', () => {
  it('lets the customer approve extra work', async () => {
    const api = fakeApi(users.customer);
    const extra = { id: 'x1', description: 'Trim the front hedge', priceCents: 2000, status: 'pending' as const, createdAt: '' };
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'working', extras: [extra] }) } });
    api.on('POST /bookings/b1/extras/x1/approve', {
      body: {
        booking: booking({ status: 'working', extras: [{ ...extra, status: 'approved' }], extrasCents: 2000, totalCents: 6840 }),
        payment: null,
      },
    });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Approve +€20' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('€68.40')).toBeInTheDocument();
  });

  it('asks before cancelling', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking() } });
    api.on('POST /bookings/b1/cancel', { body: { booking: booking({ status: 'cancelled', canCancel: false, paymentStatus: 'released' }) } });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Cancel this booking' }));
    expect(api.calls).not.toContain('POST /bookings/b1/cancel');
    await user().click(screen.getByRole('button', { name: 'Yes, cancel' }));
    expect(await screen.findByText('Nothing was charged; the hold was released.')).toBeInTheDocument();
  });

  it('takes a star rating with tags', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, canRate: true }) } });
    api.on('POST /bookings/b1/rating', {
      status: 201,
      body: { booking: booking({ status: 'completed', canRate: false, rating: { stars: 5, tags: ['tidy'] } }) },
    });
    renderAt('/bookings/b1');
    const send = await screen.findByRole('button', { name: 'Send rating' });
    expect(send).toBeDisabled();
    await user().click(screen.getByRole('radio', { name: '5 stars' }));
    await user().click(screen.getByRole('checkbox', { name: 'Tidy work' }));
    await user().click(send);
    expect(await screen.findByText('You gave 5 stars. Thank you!')).toBeInTheDocument();
    expect(api.bodies['POST /bookings/b1/rating']).toEqual({ stars: 5, tags: ['tidy'] });
  });
});

describe('pro app', () => {
  const draft: ProProfile = {
    status: 'draft',
    homePostcode: null,
    radiusKm: 12,
    workingDays: [1, 2, 3, 4, 5],
    reviewNote: null,
    payoutsEnabled: false,
    hasPayoutAccount: false,
    ratingAverage: null,
    ratingCount: 0,
    trades: [],
    documents: { id: null, certificate: null, insurance: null },
  };

  it('shows a new pro the application and saves trades straight away', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', { body: { profile: draft } });
    api.on('GET /postcodes', { body: { postcodes: [] } });
    api.on('PATCH /pro/profile', ({ body }) => ({ body: { profile: { ...draft, ...(body as object) } } }));
    renderAt('/pro');
    await user().click(await screen.findByRole('checkbox', { name: 'Gardening' }));
    expect(api.bodies['PATCH /pro/profile']).toEqual({ trades: ['cat-garden'] });
    expect(await screen.findByRole('checkbox', { name: 'Gardening' })).toBeChecked();
  });

  it('shows job offers with the earnings and accepts one', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', { body: { profile: { ...draft, status: 'approved', payoutsEnabled: true, trades: ['cat-garden'] } } });
    api.on('GET /pro/jobs', { body: { jobs: [] } });
    api.on('GET /pro/offers', {
      body: {
        offers: [
          {
            id: 'o1',
            bookingId: 'b1',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            serviceName: 'Lawn mowing',
            size: 'M',
            startsAt: '2026-11-06T09:00:00.000Z',
            endsAt: '2026-11-06T10:00:00.000Z',
            address: '12 Linden Street',
            postcode: '10115',
            notes: 'Gate code 4411',
            customerName: 'Sara',
            distanceKm: 2.3,
            photoIds: [],
            earningsCents: 3731,
          },
        ],
      },
    });
    api.on('POST /pro/offers/o1/accept', { body: { job: { id: 'b1' } } });
    api.on('GET /pro/jobs/b1', {
      body: { job: { ...booking(), customer: { firstName: 'Sara' }, earningsCents: 3731 } },
    });
    renderAt('/pro');
    const offer = await screen.findByRole('article', { name: 'New job request' });
    expect(within(offer).getByText('€37.31')).toBeInTheDocument();
    expect(within(offer).getByText('“Gate code 4411”')).toBeInTheDocument();
    await user().click(within(offer).getByRole('button', { name: 'Accept job' }));
    expect(await screen.findByRole('button', { name: /Start driving/ })).toBeInTheDocument();
  });
});

describe('admin', () => {
  it('sends signed-out visitors to the admin sign-in', async () => {
    fakeApi(null);
    renderAt('/admin');
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });

  it('emails a reset link from the forgot-password form', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/forgot', { status: 202, body: {} });
    renderAt('/admin/login');
    const forgot = await screen.findByRole('button', { name: 'Forgot password?' });
    expect(forgot).toHaveAttribute('aria-expanded', 'false');
    await user().click(forgot);
    expect(forgot).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Reset your password' });
    expect(panel).toHaveTextContent('npm run user:reset-password');
    await user().type(within(panel).getByLabelText('Username or email'), 'elion.thaqi@canera.ch');
    await user().click(within(panel).getByRole('button', { name: 'Email me a reset link' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('a link is on its way');
    expect(api.bodies['POST /auth/admin/forgot']).toEqual({ identifier: 'elion.thaqi@canera.ch' });
  });

  it('sets a new password from the emailed link and hides the token', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/reset', { status: 204 });
    window.history.replaceState(null, '', '/admin/reset-password#token=abcdefghijklmnopqrstuvwxyz123456');
    renderAt('/admin/reset-password');
    await user().type(await screen.findByLabelText('Password'), 'my fresh new password');
    await user().type(screen.getByLabelText('Repeat password'), 'my fresh new password');
    await user().click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your password is changed');
    expect(api.bodies['POST /auth/admin/reset']).toEqual({
      token: 'abcdefghijklmnopqrstuvwxyz123456',
      password: 'my fresh new password',
    });
    expect(window.location.hash).toBe('');
  });

  it('explains an expired reset link', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/reset', { status: 400, body: { error: 'invalid_reset_link' } });
    window.history.replaceState(null, '', '/admin/reset-password#token=abcdefghijklmnopqrstuvwxyz123456');
    renderAt('/admin/reset-password');
    await user().type(await screen.findByLabelText('Password'), 'my fresh new password');
    await user().type(screen.getByLabelText('Repeat password'), 'my fresh new password');
    await user().click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used');
  });

  it('lets an admin set a new password for a colleague', async () => {
    const api = fakeApi(users.admin);
    api.on('GET /admin/team', {
      body: {
        admins: [
          { id: 'u-admin', username: 'admin', createdAt: '', disabled: false },
          { id: 'u-elion', username: 'elion', createdAt: '', disabled: false },
        ],
      },
    });
    api.on('POST /admin/team/u-elion/password', { status: 204 });
    renderAt('/admin/team');
    const row = (await screen.findByText('elion')).closest('li') as HTMLElement;
    await user().click(within(row).getByRole('button', { name: 'Set new password' }));
    const form = within(row).getByRole('form', { name: 'New password for elion' });
    const submit = within(form).getByRole('button', { name: 'Set new password' });
    await user().type(within(form).getByLabelText('Password'), 'a brand new long password');
    await user().type(within(form).getByLabelText('Repeat password'), 'a brand new long passwor');
    expect(within(form).getByText('The passwords do not match.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user().type(within(form).getByLabelText('Repeat password'), 'd');
    await user().click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed for elion.');
    expect(api.bodies['POST /admin/team/u-elion/password']).toEqual({ password: 'a brand new long password' });
  });

  it('approves a pro application', async () => {
    const api = fakeApi(users.admin);
    const pro = {
      id: 'u-pro',
      firstName: 'Daniel',
      phone: '+4915100000002',
      status: 'submitted',
      homePostcode: '10115',
      radiusKm: 12,
      workingDays: [1, 2],
      reviewNote: null,
      payoutsEnabled: false,
      hasPayoutAccount: false,
      ratingAverage: null,
      ratingCount: 0,
      trades: ['cat-garden'],
      documents: { id: { uploadId: 'f1', uploadedAt: '' }, certificate: { uploadId: 'f2', uploadedAt: '' }, insurance: null },
    };
    api.on('GET /admin/pros/u-pro', { body: { pro } });
    api.on('POST /admin/pros/u-pro/review', { body: { pro: { ...pro, status: 'approved' } } });
    renderAt('/admin/pros/u-pro');
    expect(await screen.findByText('Missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'Pause account' })).toBeInTheDocument();
    expect(api.bodies['POST /admin/pros/u-pro/review']).toEqual({ decision: 'approve' });
  });
});
