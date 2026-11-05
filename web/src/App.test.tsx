import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomerBooking, ProProfile } from './api/types';
import { forgetApprovalLink } from './pages/admin/ApproveRequestPage';
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

describe('log in', () => {
  it('logs in with email and password', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/login', { body: { user: { ...users.customer, email: 'sara@example.com' } } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Log in to MISK' })).toBeInTheDocument();
    await user().type(screen.getByLabelText('Email address'), 'sara@example.com');
    await user().type(screen.getByLabelText('Password'), 'garden42');
    await user().click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Sara' })).toBeInTheDocument();
    expect(api.bodies['POST /auth/login']).toEqual({ email: 'sara@example.com', password: 'garden42' });
  });

  it('explains a wrong email or password', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/login', { status: 401, body: { error: 'invalid_login' } });
    renderAt('/signin');
    await user().type(await screen.findByLabelText('Email address'), 'sara@example.com');
    await user().type(screen.getByLabelText('Password'), 'wrong123');
    await user().click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not right.');
  });

  it('signs a new person in by phone code and lets them choose to be a customer', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/phone/start', { status: 202, body: { phone: '+4915112345678' } });
    api.on('POST /auth/phone/verify', { body: { user: users.new } });
    api.on('POST /account/role', { body: { user: { ...users.new, role: 'customer', firstName: 'Sara' } } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/');

    await user().click(await screen.findByRole('button', { name: 'Phone' }));
    await user().type(await screen.findByLabelText('Mobile number'), '+49 151 12345678');
    await user().click(screen.getByRole('button', { name: /Send me a sign-in code/ }));
    await user().type(await screen.findByLabelText('6-digit code'), '123456');
    await user().click(screen.getByRole('button', { name: 'Sign in' }));
    await user().type(await screen.findByLabelText('Your first name'), 'Sara');
    await user().click(screen.getByRole('button', { name: /Open the customer app/ }));

    expect(await screen.findByRole('heading', { name: 'Sara' })).toBeInTheDocument();
    expect(api.bodies['POST /account/role']).toEqual({ role: 'customer', firstName: 'Sara' });
  });

  it('explains a wrong code', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/phone/start', { status: 202, body: { phone: '+4915112345678' } });
    api.on('POST /auth/phone/verify', { status: 401, body: { error: 'invalid_code' } });
    renderAt('/signin?method=phone');
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

  it('goes to sign-up from the log-in page', async () => {
    fakeApi(null);
    renderAt('/signin');
    await user().click(await screen.findByRole('button', { name: 'Sign up' }));
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
  });
});

describe('sign up', () => {
  type Label = 'First name' | 'Last name' | 'Email address' | 'Password' | 'Confirm password';
  const field = (label: Label) => screen.getByLabelText(new RegExp(`^${label}`));
  const fill = async (values: Partial<Record<Label, string>>) => {
    for (const [label, value] of Object.entries(values) as [Label, string][]) {
      await user().type(field(label), value);
    }
  };
  const complete: Record<Label, string> = {
    'First name': 'Sara',
    'Last name': 'Meier',
    'Email address': 'sara@example.com',
    Password: 'garden42',
    'Confirm password': 'garden42',
  };

  it('creates the account and asks how the person will use MISK', async () => {
    const api = fakeApi(null);
    const created = { ...users.new, phone: null, email: 'sara@example.com', firstName: 'Sara', lastName: 'Meier' };
    api.on('POST /auth/register', { status: 201, body: { user: created } });
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(complete);
    await user().click(screen.getByRole('checkbox', { name: /I accept the terms and conditions/ }));
    await user().click(screen.getByRole('button', { name: 'Sign up' }));

    expect(await screen.findByRole('heading', { name: 'Welcome!' })).toBeInTheDocument();
    expect(screen.getByLabelText('Your first name')).toHaveValue('Sara');
    expect(api.bodies['POST /auth/register']).toEqual({
      firstName: 'Sara',
      lastName: 'Meier',
      email: 'sara@example.com',
      password: 'garden42',
      acceptTerms: true,
    });
  });

  it('marks required fields and keeps Sign up disabled until all are filled and the terms accepted', async () => {
    fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    for (const label of Object.keys(complete) as Label[]) {
      expect(field(label)).toBeRequired();
      expect(field(label).closest('.field')?.querySelector('label .required')).toHaveTextContent('*');
    }
    const submit = screen.getByRole('button', { name: 'Sign up' });
    expect(submit).toBeDisabled();
    await fill(complete);
    expect(submit).toBeDisabled();
    await user().click(screen.getByRole('checkbox', { name: /I accept the terms and conditions/ }));
    expect(submit).toBeEnabled();
    await user().clear(field('Last name'));
    expect(submit).toBeDisabled();
  });

  it('says when the email is already registered', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/register', { status: 409, body: { error: 'email_taken' } });
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(complete);
    await user().click(screen.getByRole('checkbox', { name: /I accept/ }));
    await user().click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('An account with this email already exists')).toBeInTheDocument();
    expect(field('Email address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('checks the email format when the field is left', async () => {
    fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    const email = field('Email address');
    await user().type(email, 'sara@example');
    expect(screen.queryByText('Please enter a valid email address')).not.toBeInTheDocument();
    await user().tab();
    expect(await screen.findByText('Please enter a valid email address')).toBeInTheDocument();
    await user().type(email, '.com');
    expect(screen.queryByText('Please enter a valid email address')).not.toBeInTheDocument();
  });

  it('shows the password rules while typing and lets the person show or hide the password', async () => {
    fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    const password = field('Password');
    await user().type(password, 'garden');
    const rules = screen.getByRole('list', { name: 'Password requirements' });
    const rule = (text: string) => within(rules).getByText(text).closest('li');
    expect(rule('At least 8 characters')).not.toHaveClass('ok');
    expect(rule('At least one letter')).toHaveClass('ok');
    expect(rule('At least one number')).not.toHaveClass('ok');
    await user().type(password, '42');
    expect(rule('At least 8 characters')).toHaveClass('ok');
    expect(rule('At least one number')).toHaveClass('ok');

    expect(password).toHaveAttribute('type', 'password');
    const toggle = password.parentElement?.querySelector('button') as HTMLButtonElement;
    expect(toggle).toHaveAccessibleName('Show password');
    await user().click(toggle);
    expect(password).toHaveAttribute('type', 'text');
    expect(toggle).toHaveAccessibleName('Hide password');
    await user().click(toggle);
    expect(password).toHaveAttribute('type', 'password');
  });

  it('says the passwords do not match when Sign up is clicked, and sends nothing', async () => {
    const api = fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill({ ...complete, 'Confirm password': 'garden43' });
    await user().click(screen.getByRole('checkbox', { name: /I accept/ }));
    expect(screen.queryByText('Passwords do not match')).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/register');
  });

  it('does not sign up with a weak password', async () => {
    const api = fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill({ ...complete, Password: 'gardening', 'Confirm password': 'gardening' });
    await user().click(screen.getByRole('checkbox', { name: /I accept/ }));
    await user().click(screen.getByRole('button', { name: 'Sign up' }));
    expect(screen.getByText('At least one number').closest('li')).toHaveClass('bad');
    expect(api.calls).not.toContain('POST /auth/register');
  });

  it('takes people with an account to the log-in page', async () => {
    fakeApi(null);
    renderAt('/signup');
    await user().click(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Log in to MISK' })).toBeInTheDocument();
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

describe('admin navigation', () => {
  const DESIGN = [
    ['Overview', '/admin'],
    ['Bookings', '/admin/bookings'],
    ['Providers', '/admin/providers'],
    ['Plans', '/admin/plans'],
    ['Catalogue', '/admin/catalogue'],
    ['Settings', '/admin/settings'],
  ] as const;

  function stubAdminPages(api: ReturnType<typeof fakeApi>) {
    api.on('GET /admin/overview', {
      body: {
        days: 7,
        kpis: { bookings: 0, completed: 0, grossCents: 0, payoutCents: 0, miskShareCents: 0, ratingAverage: null, ratingCount: 0 },
        weekly: [],
        attention: { pendingApplications: 0, unassigned: 0, unreleasedHolds: 0, failedPayouts: 0 },
      },
    });
    api.on('GET /admin/bookings', { body: { bookings: [] } });
    api.on('GET /admin/pros', { body: { pros: [] } });
    api.on('GET /admin/plans', { body: { plans: [] } });
    api.on('GET /admin/catalogue', { body: { categories: [], services: [] } });
    api.on('GET /admin/settings', { body: { settings: { serviceFeeCents: 290, proSharePct: 82 } } });
  }

  it('shows exactly the design labels, spelled and ordered as in the design', async () => {
    const api = fakeApi(users.admin);
    stubAdminPages(api);
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Control panel' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(DESIGN.map(([label]) => label));
    expect(within(nav).queryAllByRole('button')).toEqual([]);
  });

  it('links each label to its page', async () => {
    const api = fakeApi(users.admin);
    stubAdminPages(api);
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Control panel' });
    for (const [label, path] of DESIGN) {
      const link = within(nav).getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', path);
      await user().click(link);
      expect(await screen.findByRole('heading', { level: 1, name: label })).toBeInTheDocument();
      expect(link).toHaveAttribute('aria-current', 'page');
    }
  });

  it('keeps fees, areas and team under Settings, and sign out at the top', async () => {
    const api = fakeApi(users.admin);
    stubAdminPages(api);
    api.on('GET /admin/postcodes', { body: { postcodes: [] } });
    renderAt('/admin/areas');
    expect(await screen.findByRole('heading', { level: 2, name: 'Areas' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('link').map((l) => l.textContent)).toEqual(['Fees', 'Areas', 'Team']);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('plan page', () => {
  const categories = [
    { id: 'cat-garden', slug: 'gardening', name: 'Gardening', icon: 'leaf', sortOrder: 0, active: true },
    { id: 'cat-clean', slug: 'cleaning', name: 'Cleaning', icon: 'sparkle', sortOrder: 1, active: true },
  ];
  const savedPlan = (body: object, status = 'draft') => ({
    id: 'p1',
    status,
    categoryName: 'Gardening',
    categoryIcon: 'leaf',
    seasonFrom: null,
    seasonTo: null,
    publishedAt: null,
    updatedAt: '',
    ...body,
  });

  function openNewPlan() {
    const api = fakeApi(users.admin);
    api.on('GET /admin/catalogue', { body: { categories, services: [] } });
    api.on('GET /admin/plans', { body: { plans: [] } });
    let stored: object = {};
    api.on('POST /admin/plans', ({ body }) => {
      stored = body as object;
      return { status: 201, body: { plan: savedPlan(stored) } };
    });
    api.on('PUT /admin/plans/p1', ({ body }) => {
      stored = body as object;
      return { body: { plan: savedPlan(stored) } };
    });
    api.on('GET /admin/plans/p1', () => ({ body: { plan: savedPlan(stored) } }));
    renderAt('/admin/plans/new');
    return api;
  }

  async function fillComplete() {
    await user().type(await screen.findByLabelText('Plan name'), 'Lawn care');
    await user().selectOptions(screen.getByLabelText('Category'), 'Gardening');
    await user().type(screen.getByLabelText('Monthly price (€)'), '49');
    await user().type(screen.getByRole('textbox', { name: 'Add a task' }), 'Mow{Enter}');
  }

  it('sets name, category, monthly price, how often, visit length in minutes, skips and minimum term', async () => {
    const api = openNewPlan();
    await fillComplete();
    expect(screen.getByText('Medium size. Small −15%, large +35%.')).toBeInTheDocument();
    await user().selectOptions(screen.getByLabelText('How often'), '2× a week');
    expect(screen.getByText('≈ 8.7 visits a month')).toBeInTheDocument();
    await user().clear(screen.getByLabelText('Visit length (minutes)'));
    await user().type(screen.getByLabelText('Visit length (minutes)'), '90');
    await user().clear(screen.getByLabelText('Skips allowed per month'));
    await user().type(screen.getByLabelText('Skips allowed per month'), '1');
    await user().clear(screen.getByLabelText('Minimum term (months)'));
    await user().type(screen.getByLabelText('Minimum term (months)'), '6');
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(api.bodies['POST /admin/plans']).toMatchObject({
        name: 'Lawn care',
        categoryId: 'cat-garden',
        priceCents: 4900,
        frequency: 'twice_weekly',
        visitMinutes: 90,
        skipsPerMonth: 1,
        minTermMonths: 6,
        tasks: ['Mow'],
      }),
    );
  });

  it('adds tasks with Enter or the plus button, as removable tags, without empty or duplicate ones', async () => {
    openNewPlan();
    const input = await screen.findByRole('textbox', { name: 'Add a task' });
    const plus = screen.getByRole('button', { name: 'Add task' });
    const tags = () => screen.getAllByRole('listitem').filter((li) => li.classList.contains('taskchip')).map((li) => li.textContent);
    await user().type(input, 'Mow{Enter}');
    await user().type(input, 'Edge');
    await user().click(plus);
    await user().type(input, '   {Enter}');
    await user().type(input, 'mow{Enter}');
    expect(tags()).toEqual(['Mow', 'Edge']);
    expect(screen.getByText('"mow" is already in the list.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Remove Mow' }));
    expect(tags()).toEqual(['Edge']);
  });

  it('has one optional extra, shown in the preview with its checkbox and price', async () => {
    openNewPlan();
    await user().type(await screen.findByLabelText('Optional extra'), 'Hedge trimming');
    await user().type(screen.getByLabelText('Extra price (€ / month)'), '15');
    const preview = screen.getByRole('complementary', { name: 'Live preview · customer app' });
    const extra = within(preview).getByRole('checkbox', { name: /Hedge trimming/ });
    expect(extra).toBeInTheDocument();
    expect(within(preview).getByText('+€15/mo')).toBeInTheDocument();
  });

  it('runs a seasonal plan from April to October, switched on with a switch', async () => {
    openNewPlan();
    const seasonal = await screen.findByRole('switch', { name: 'Seasonal plan' });
    expect(screen.getByText('Runs all year')).toBeInTheDocument();
    await user().click(seasonal);
    expect(seasonal).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Runs Apr – Oct, pauses automatically in winter')).toBeInTheDocument();
    const preview = screen.getByRole('complementary', { name: 'Live preview · customer app' });
    expect(within(preview).getByText(/Season Apr – Oct/)).toBeInTheDocument();
  });

  it('splits the price with a slider, a bar, and what each side gets per customer per month', async () => {
    openNewPlan();
    await user().type(await screen.findByLabelText('Monthly price (€)'), '49');
    expect(screen.getByText('Pro: €34.30/month per customer')).toBeInTheDocument();
    expect(screen.getByText('MISK: €14.70/month per customer')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Pro earns: 70% of the monthly price'), { target: { value: '80' } });
    expect(screen.getByText('Pro: €39.20/month per customer')).toBeInTheDocument();
    expect(screen.getByText('MISK: €9.80/month per customer')).toBeInTheDocument();
  });

  it('shows a live customer preview that follows every change', async () => {
    openNewPlan();
    await fillComplete();
    await user().type(screen.getByRole('textbox', { name: 'Add a task' }), 'Edge{Enter}');
    const preview = screen.getByRole('complementary', { name: 'Live preview · customer app' });
    expect(within(preview).getByText('Lawn care')).toBeInTheDocument();
    expect(within(preview).getByText('1× a week · 60 min')).toBeInTheDocument();
    expect(within(preview).getByText('€49')).toBeInTheDocument();
    expect(within(preview).getByText('≈ €11.40 per visit')).toBeInTheDocument();
    expect(within(preview).getByText('Mow')).toBeInTheDocument();
    expect(within(preview).getByText('2 skips/month · min. 3 months')).toBeInTheDocument();
    expect(within(preview).getByText('Subscribe')).toBeInTheDocument();
    await user().clear(screen.getByLabelText('Plan name'));
    await user().type(screen.getByLabelText('Plan name'), 'Garden care');
    expect(within(preview).getByText('Garden care')).toBeInTheDocument();
  });

  it('saves a draft at any time, even empty, and confirms it', async () => {
    const api = openNewPlan();
    const save = await screen.findByRole('button', { name: 'Save draft' });
    expect(save).toBeEnabled();
    await user().type(screen.getByLabelText('Plan name'), 'Half done');
    await user().click(save);
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(api.bodies['POST /admin/plans']).toMatchObject({ name: 'Half done', categoryId: null, priceCents: null, tasks: [] });
  });

  it('refuses to publish an incomplete plan and lists what needs fixing', async () => {
    openNewPlan();
    const publish = await screen.findByRole('button', { name: 'Publish plan' });
    expect(publish).toBeDisabled();
    expect(screen.getByText(/To publish, add: a plan name, a category, a monthly price of at least €5, at least one task/)).toBeInTheDocument();
    await fillComplete();
    expect(screen.queryByText(/To publish, add/)).not.toBeInTheDocument();
    expect(publish).toBeEnabled();
  });

  it('publishes a complete plan', async () => {
    const api = openNewPlan();
    api.on('POST /admin/plans/p1/status', { body: { plan: savedPlan({ name: 'Lawn care', categoryId: 'cat-garden', priceCents: 4900, tasks: ['Mow'] }, 'published') } });
    await fillComplete();
    await user().click(screen.getByRole('button', { name: 'Publish plan' }));
    expect(await screen.findByRole('heading', { name: 'Plan published' })).toBeInTheDocument();
    expect(api.bodies['POST /admin/plans/p1/status']).toEqual({ published: true });
  });

  it('warns before leaving with unsaved changes', async () => {
    openNewPlan();
    await user().type(await screen.findByLabelText('Plan name'), 'Unsaved');
    const menu = screen.getByRole('navigation', { name: 'Control panel' });
    await user().click(within(menu).getByRole('link', { name: 'Plans' }));
    const warning = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    await user().click(within(warning).getByRole('button', { name: 'Stay and keep editing' }));
    expect(screen.getByLabelText('Plan name')).toHaveValue('Unsaved');

    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    await user().click(within(screen.getByRole('navigation', { name: 'Control panel' })).getByRole('link', { name: 'Plans' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();
  });

  it('leaves without saving when the admin chooses to', async () => {
    openNewPlan();
    await user().type(await screen.findByLabelText('Plan name'), 'Throw away');
    await user().click(within(screen.getByRole('navigation', { name: 'Control panel' })).getByRole('link', { name: 'Plans' }));
    await user().click(await screen.findByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();
  });
});

describe('admin', () => {
  it('sends signed-out visitors to the admin sign-in', async () => {
    fakeApi(null);
    renderAt('/admin');
    expect(await screen.findByLabelText('Username or email')).toBeInTheDocument();
  });

  it('is its own website: the app has no admin pages, and the admin site opens on the control panel', async () => {
    fakeApi(users.admin);
    const app = renderAt('/admin', 'app');
    expect(await screen.findByRole('heading', { name: 'This page does not exist' })).toBeInTheDocument();
    app.unmount();
    renderAt('/', 'admin');
    expect(await screen.findByRole('navigation', { name: 'Control panel' })).toBeInTheDocument();
  });

  it('lets new team members request an admin account from the sign-in page', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/register', { status: 201, body: { status: 'pending_approval' } });
    renderAt('/admin/login');
    await user().click(await screen.findByRole('link', { name: 'Request an account' }));
    expect(await screen.findByRole('heading', { name: 'Request an admin account' })).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Request account' });
    expect(submit).toBeDisabled();
    await user().type(screen.getByLabelText(/^First name/), 'Lina');
    await user().type(screen.getByLabelText(/^Last name/), 'Hoxha');
    await user().type(screen.getByLabelText(/^Work email address/), 'lina@misk.test');
    await user().type(screen.getByLabelText(/^Password/), 'short');
    await user().type(screen.getByLabelText(/^Confirm password/), 'short');
    await user().click(submit);
    expect(screen.getByText('The password needs at least 12 characters.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/admin/register');

    await user().clear(screen.getByLabelText(/^Password/));
    await user().type(screen.getByLabelText(/^Password/), 'a long new admin password');
    await user().clear(screen.getByLabelText(/^Confirm password/));
    await user().type(screen.getByLabelText(/^Confirm password/), 'a long new admin password');
    await user().click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent('Your request is with the MISK team');
    expect(api.bodies['POST /auth/admin/register']).toEqual({
      firstName: 'Lina',
      lastName: 'Hoxha',
      email: 'lina@misk.test',
      password: 'a long new admin password',
    });
  });

  it('says when a requested account is still waiting for approval', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/login', { status: 403, body: { error: 'pending_approval' } });
    renderAt('/admin/login');
    await user().type(await screen.findByLabelText('Username or email'), 'lina@misk.test');
    await user().type(screen.getByLabelText('Password'), 'a long new admin password');
    await user().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('waiting for an admin to approve it');
  });

  it('approves an account request with one click from the email link, and hides the token', async () => {
    forgetApprovalLink();
    const api = fakeApi(null);
    api.on('POST /auth/admin/approve', { body: { admin: { email: 'lina@misk.test', firstName: 'Lina', lastName: 'Hoxha' } } });
    window.history.replaceState(null, '', '/admin/approve#token=abcdefghijklmnopqrstuvwxyz123456');
    renderAt('/admin/approve');
    expect(await screen.findByText(/Lina Hoxha can now sign in with lina@misk.test/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c === 'POST /auth/admin/approve')).toHaveLength(1);
    expect(api.bodies['POST /auth/admin/approve']).toEqual({ token: 'abcdefghijklmnopqrstuvwxyz123456' });
    expect(window.location.hash).toBe('');
  });

  it('explains a used or expired approval link', async () => {
    forgetApprovalLink();
    const api = fakeApi(null);
    api.on('POST /auth/admin/approve', { status: 400, body: { error: 'invalid_approval_link' } });
    window.history.replaceState(null, '', '/admin/approve#token=abcdefghijklmnopqrstuvwxyz123456');
    renderAt('/admin/approve');
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used');
  });

  it('lets an admin approve an account request on the Team page', async () => {
    const api = fakeApi(users.admin);
    const lina = { id: 'u-lina', username: 'lina@misk.test', email: 'lina@misk.test', firstName: 'Lina', lastName: 'Hoxha', createdAt: '', disabled: false, pending: true };
    let approved = false;
    api.on('GET /admin/team', () => ({
      body: {
        admins: [
          { id: 'u-admin', username: 'admin', email: null, firstName: null, lastName: null, createdAt: '', disabled: false, pending: false },
          { ...lina, pending: !approved },
        ],
      },
    }));
    api.on('POST /admin/team/u-lina/approve', () => {
      approved = true;
      return { body: { approved: true } };
    });
    renderAt('/admin/settings/team');
    const requests = await screen.findByRole('region', { name: '1 account request' });
    expect(within(requests).getByText('Lina Hoxha')).toBeInTheDocument();
    await user().click(within(requests).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('lina@misk.test can sign in now.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: /account request/ })).not.toBeInTheDocument());
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
    renderAt('/admin/settings/team');
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
    renderAt('/admin/providers/u-pro');
    expect(await screen.findByText('Missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask for changes' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'Pause account' })).toBeInTheDocument();
    expect(api.bodies['POST /admin/pros/u-pro/review']).toEqual({ decision: 'approve' });
  });
});
