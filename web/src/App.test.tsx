import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomerBooking, ProProfile } from './api/types';
import { forgetApprovalLink } from './pages/admin/ApproveRequestPage';
import { catalogue, fakeApi, renderAt, users } from './test/harness';

const user = () => userEvent.setup();

function booking(overrides: Partial<CustomerBooking> = {}): CustomerBooking {
  return {
    id: 'b1',
    number: 'B-1001',
    categoryName: 'Gardening',
    problemReportedAt: null,
    problemNote: null,
    problemResolvedAt: null,
    chargeAt: null,
    canReportProblem: false,
    lateCancelCents: null,
    lateCancel: false,
    tip: null,
    canTip: false,
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

  it('asks to confirm the email first and can send the link again', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/login', { status: 403, body: { error: 'email_not_verified' } });
    api.on('POST /auth/verify-email/resend', { status: 202, body: {} });
    renderAt('/signin');
    await user().type(await screen.findByLabelText('Email address'), 'sara@example.com');
    await user().type(screen.getByLabelText('Password'), 'garden42');
    await user().click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please confirm your email first.');
    await user().click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText(/A new link is on its way/)).toBeInTheDocument();
    expect(api.bodies['POST /auth/verify-email/resend']).toEqual({ email: 'sara@example.com' });
  });

  it('says what is missing or wrong before sending the log-in', async () => {
    const api = fakeApi(null);
    renderAt('/signin');
    await user().click(await screen.findByRole('button', { name: 'Log in' }));
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter a password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveFocus();
    await user().type(screen.getByLabelText('Email address'), 'sara@example');
    expect(screen.getByText('Enter an email address like name@example.com.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/login');
  });

  it('says how to write the mobile number and the code', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/phone/start', { status: 202, body: { phone: '+4915112345678' } });
    renderAt('/signin?method=phone');
    const send = await screen.findByRole('button', { name: /Send me a sign-in code/ });
    await user().click(send);
    expect(screen.getByText(/Enter your mobile number, starting with the country code/)).toBeInTheDocument();
    await user().type(screen.getByLabelText('Mobile number'), '0151 1234');
    await user().click(send);
    expect(screen.getByText('Enter an international phone number, e.g. +49 151 23456789.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/phone/start');

    await user().clear(screen.getByLabelText('Mobile number'));
    await user().type(screen.getByLabelText('Mobile number'), '+49 151 12345678');
    await user().click(send);
    await user().type(await screen.findByLabelText('6-digit code'), '123');
    await user().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('The code has 6 digits. Check the text message and enter all of them.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/phone/verify');
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
  const field = (label: Label) => screen.getByLabelText(new RegExp(`^${label}`), { selector: 'input' });
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

  it('creates the account and asks the person to confirm their email before signing in', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/register', { status: 201, body: { status: 'verification_sent', email: 'sara@example.com' } });
    api.on('POST /auth/verify-email/resend', { status: 202, body: {} });
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill(complete);
    await user().click(screen.getByRole('checkbox', { name: /I accept the terms and conditions/ }));
    await user().click(screen.getByRole('button', { name: 'Sign up' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('We sent a link to sara@example.com.');
    expect(api.bodies['POST /auth/register']).toEqual({
      firstName: 'Sara',
      lastName: 'Meier',
      email: 'sara@example.com',
      password: 'garden42',
      acceptTerms: true,
    });

    await user().click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText(/A new link is on its way/)).toBeInTheDocument();
    expect(api.bodies['POST /auth/verify-email/resend']).toEqual({ email: 'sara@example.com' });

    await user().click(screen.getByRole('button', { name: 'Use another email' }));
    expect(field('Email address')).toHaveValue('');
    expect(field('First name')).toHaveValue('Sara');
  });

  it('shows the terms and conditions without leaving the form, and can accept them from there', async () => {
    fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill({ 'First name': 'Sara' });
    await user().click(screen.getByRole('button', { name: 'Read the terms and conditions' }));
    const terms = screen.getByRole('dialog', { name: 'Terms and conditions' });
    expect(within(terms).getByRole('heading', { name: '4. Cancelling' })).toBeInTheDocument();
    expect(within(terms).getByText(/cancel for free until 24 hours before the start/)).toBeInTheDocument();
    await user().click(within(terms).getByRole('button', { name: 'I have read and accept the terms' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /I accept the terms and conditions/ })).toBeChecked();
    expect(field('First name')).toHaveValue('Sara');

    await user().click(screen.getByRole('button', { name: 'Read the terms and conditions' }));
    await user().keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has the terms on their own page, linked from log-in', async () => {
    fakeApi(null);
    renderAt('/signin');
    await user().click(await screen.findByRole('link', { name: 'Terms' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms and conditions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '1. What MISK is' })).toBeInTheDocument();
  });

  it('marks required fields and says under each one what is missing when Sign up is clicked', async () => {
    const api = fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    for (const label of Object.keys(complete) as Label[]) {
      expect(field(label)).toBeRequired();
      expect(field(label).closest('.field')?.querySelector('label .required')).toHaveTextContent('*');
    }
    const submit = screen.getByRole('button', { name: 'Sign up' });
    expect(submit).toBeEnabled();
    expect(screen.queryByText('Enter your first name.')).not.toBeInTheDocument();
    await user().click(submit);
    for (const message of [
      'Enter your first name.',
      'Enter your last name.',
      'Enter your email address.',
      'Enter a password.',
      'Enter the password a second time to confirm it.',
      'Tick the box to accept the terms and conditions.',
    ]) {
      expect(screen.getByText(message)).toBeInTheDocument();
    }
    expect(field('First name')).toHaveFocus();
    expect(field('First name')).toHaveAttribute('aria-invalid', 'true');
    expect(field('First name')).toHaveAccessibleDescription('Enter your first name.');
    expect(api.calls).not.toContain('POST /auth/register');

    await fill({ 'First name': 'Sara' });
    expect(screen.queryByText('Enter your first name.')).not.toBeInTheDocument();
    await fill({ 'Last name': 'Meier', 'Email address': 'sara@example.com', Password: 'garden42', 'Confirm password': 'garden42' });
    await user().click(submit);
    expect(screen.getByRole('checkbox', { name: /I accept the terms and conditions/ })).toHaveFocus();
    expect(api.calls).not.toContain('POST /auth/register');
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

describe('confirming an email', () => {
  const TOKEN = 'abcdefghijklmnopqrstuvwxyz123456';

  it('confirms the email from the link once, signs the person in and asks how they will use MISK', async () => {
    const api = fakeApi(null);
    const created = { ...users.new, phone: null, email: 'sara@example.com', firstName: 'Sara', lastName: 'Meier' };
    api.on('POST /auth/verify-email', { body: { user: created } });
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    renderAt('/verify-email');
    expect(await screen.findByRole('heading', { name: 'Welcome!' })).toBeInTheDocument();
    expect(api.bodies['POST /auth/verify-email']).toEqual({ token: TOKEN });
    expect(api.calls.filter((c) => c === 'POST /auth/verify-email')).toHaveLength(1);
    expect(window.location.hash).toBe('');
  });

  it('offers a new link when the link expired or was used', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/verify-email', { status: 400, body: { error: 'invalid_verification_link' } });
    api.on('POST /auth/verify-email/resend', { status: 202, body: {} });
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    renderAt('/verify-email');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used.');
    const send = screen.getByRole('button', { name: 'Send the link again' });
    await user().click(send);
    expect(screen.getByText('Enter a valid email address to get a new link.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/verify-email/resend');
    await user().type(screen.getByLabelText('Email address'), 'sara@example.com');
    await user().click(send);
    expect(await screen.findByText(/A new link is on its way/)).toBeInTheDocument();
    expect(api.bodies['POST /auth/verify-email/resend']).toEqual({ email: 'sara@example.com' });
  });

  it('says a link without a token cannot be used', async () => {
    const api = fakeApi(null);
    window.history.replaceState(null, '', '/verify-email');
    renderAt('/verify-email');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used.');
    expect(api.calls).not.toContain('POST /auth/verify-email');
  });
});

describe('my bookings', () => {
  const booking = (i: number) => ({
    id: `b-${i}`,
    status: 'completed' as const,
    serviceName: `Job ${i + 1}`,
    categoryId: 'cat-garden',
    startsAt: new Date(Date.UTC(2026, 10, 30 - i, 9)).toISOString(),
    totalCents: 4840,
    proName: 'Daniel',
    canRate: false,
  });

  it('shows the 10 most recent bookings and the rest after "View all"', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: Array.from({ length: 13 }, (_, i) => booking(i)) } });
    renderAt('/bookings');
    expect(await screen.findByText('Job 10')).toBeInTheDocument();
    expect(screen.queryByText('Job 11')).not.toBeInTheDocument();
    const viewAll = screen.getByRole('button', { name: 'View all (13)' });
    expect(viewAll).toHaveAttribute('aria-expanded', 'false');
    await user().click(viewAll);
    expect(screen.getByText('Job 13')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Show the 10 most recent' }));
    expect(screen.queryByText('Job 11')).not.toBeInTheDocument();
  });

  it('shows no "View all" for ten bookings or fewer', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: Array.from({ length: 10 }, (_, i) => booking(i)) } });
    renderAt('/bookings');
    expect(await screen.findByText('Job 10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
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

  it('shows new services and hourly prices, and books hourly services without sizes', async () => {
    const api = fakeApi(users.customer);
    const garden = catalogue.categories[0];
    const mowing = garden?.services[0];
    if (!garden || !mowing) throw new Error('test catalogue changed');
    const hourly = { ...mowing, id: 'svc-hour', name: 'Gardener by the hour', priceCents: 3800, durationMinutes: 120, pricing: 'hourly' as const, isNew: true };
    api.on('GET /catalogue', { body: { ...catalogue, categories: [{ ...garden, services: [mowing, hourly] }] } });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    renderAt('/category/gardening');
    const option = await screen.findByRole('radio', { name: /Gardener by the hour/ });
    expect(option.closest('label')).toHaveTextContent('New');
    expect(option.closest('label')).toHaveTextContent('€38/h');
    await user().click(option);
    await user().click(screen.getByRole('button', { name: 'Continue · €38/h' }));
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().selectOptions(await screen.findByLabelText('Postcode'), '10115');
    expect(screen.queryByRole('radio', { name: /Large/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Paid by the hour: €38\/h for about 2 h/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue · €76' })).toBeEnabled();
  });

  it('puts a customer whose postcode is not served on the waitlist', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('POST /waitlist', { status: 201, body: { postcode: '10178' } });
    renderAt('/book/svc-mow');
    await user().click(await screen.findByRole('button', { name: 'Your postcode is not listed?' }));
    await user().type(screen.getByLabelText('Your postcode'), '10178');
    await user().click(screen.getByRole('button', { name: 'Join the waitlist' }));
    expect(api.bodies['POST /waitlist']).toEqual({ postcode: '10178' });
    expect(await screen.findByText(/You are on the waitlist for 10178/)).toBeInTheDocument();
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

  it('warns that a late cancellation costs the full price and confirms it', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ lateCancelCents: 4840 }) } });
    api.on('POST /bookings/b1/cancel', {
      body: { booking: booking({ status: 'cancelled', canCancel: false, lateCancel: true, paymentStatus: 'captured' }) },
    });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Cancel this booking' }));
    expect(screen.getByText(/cancelling now costs the full price of €48.40/)).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Cancel and pay €48.40' }));
    expect(api.bodies['POST /bookings/b1/cancel']).toEqual({ acceptLateCharge: true });
    expect(await screen.findByText('Cancelled less than 24 hours before: €48.40 was charged.')).toBeInTheDocument();
  });

  it('takes a tip and shows how much of it goes to the pro', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false, canTip: true };
    api.on('GET /bookings/b1', { body: { booking: booking(done) } });
    api.on('POST /bookings/b1/tip', {
      status: 201,
      body: { booking: booking({ ...done, canTip: false, tip: { amountCents: 1000, proCents: 820, status: 'captured' } }) },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByText('Add a tip for Daniel?')).toBeInTheDocument();
    expect(screen.getByText('€4.10 goes to Daniel.')).toBeInTheDocument();
    await user().click(screen.getByRole('radio', { name: '€10' }));
    expect(screen.getByText('€8.20 goes to Daniel.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Tip €10' }));
    expect(api.bodies['POST /bookings/b1/tip']).toEqual({ amountCents: 1000 });
    expect(await screen.findByText('You tipped €10. €8.20 went to Daniel. Thank you!')).toBeInTheDocument();
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
    await user().click(send);
    expect(screen.getByText('Choose from 1 to 5 stars.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /bookings/b1/rating');
    await user().click(screen.getByRole('radio', { name: '5 stars' }));
    expect(screen.queryByText('Choose from 1 to 5 stars.')).not.toBeInTheDocument();
    await user().click(screen.getByRole('checkbox', { name: 'Tidy work' }));
    await user().click(send);
    expect(await screen.findByText('You gave 5 stars. Thank you!')).toBeInTheDocument();
    expect(api.bodies['POST /bookings/b1/rating']).toEqual({ stars: 5, tags: ['tidy'] });
  });
  it('lets the customer report a problem before the card is charged', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false, chargeAt: '2026-11-07T10:00:00.000Z' };
    api.on('GET /bookings/b1', { body: { booking: booking({ ...done, canReportProblem: true }) } });
    api.on('POST /bookings/b1/problem', {
      body: {
        booking: booking({ ...done, canReportProblem: false, problemReportedAt: '2026-11-06T12:00:00.000Z', problemNote: 'Back lawn not mowed' }),
      },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByText('We charge your card on Sat 7 Nov, 11:00. Not happy with the job? Tell us before then.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Report a problem' }));
    const send = screen.getByRole('button', { name: 'Send to MISK' });
    await user().click(send);
    expect(screen.getByText('Tell us what went wrong.')).toBeInTheDocument();
    expect(screen.getByLabelText('Tell us what was not done right')).toHaveFocus();
    await user().type(screen.getByLabelText('Tell us what was not done right'), 'No');
    expect(screen.getByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /bookings/b1/problem');
    await user().clear(screen.getByLabelText('Tell us what was not done right'));
    await user().type(screen.getByLabelText('Tell us what was not done right'), '  Back lawn not mowed ');
    await user().click(send);
    expect(await screen.findByText(/we got your report/)).toBeInTheDocument();
    expect(api.bodies['POST /bookings/b1/problem']).toEqual({ note: 'Back lawn not mowed' });
  });

  it('sends photos with the problem report, and can add more while it is open', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false, chargeAt: '2026-11-07T10:00:00.000Z' };
    const reported = { ...done, canReportProblem: false, problemReportedAt: '2026-11-06T12:00:00.000Z', problemNote: 'Mud on the terrace' };
    let photos: { id: string; kind: 'problem' }[] = [];
    api.on('GET /bookings/b1', { body: { booking: booking({ ...done, canReportProblem: true }) } });
    api.on('POST /bookings/b1/problem', () => ({ body: { booking: booking({ ...reported, photos }) } }));
    api.on('POST /bookings/b1/problem/photos', () => {
      photos = [...photos, { id: `photo-${photos.length + 1}`, kind: 'problem' }];
      return { status: 201, body: { booking: booking({ ...reported, photos }) } };
    });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Report a problem' }));
    await user().type(screen.getByLabelText('Tell us what was not done right'), 'Mud on the terrace');
    const picker = screen.getByLabelText('Add photos');
    await user().upload(picker, [
      new File(['a'], 'terrace.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'steps.png', { type: 'image/png' }),
      new File(['c'], 'extra.png', { type: 'image/png' }),
    ]);
    expect(within(screen.getByRole('list', { name: 'Photos to send' })).getAllByRole('listitem')).toHaveLength(3);
    await user().click(screen.getByRole('button', { name: 'Remove extra.png' }));
    expect(within(screen.getByRole('list', { name: 'Photos to send' })).getAllByRole('listitem')).toHaveLength(2);

    await user().click(screen.getByRole('button', { name: 'Send to MISK' }));
    expect(await screen.findByText(/we got your report/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c === 'POST /bookings/b1/problem/photos')).toHaveLength(2);
    const sent = screen.getByRole('list', { name: 'Your photo of the problem' });
    expect(within(sent).getAllByRole('img')).toHaveLength(2);

    await user().upload(screen.getByLabelText('Add a photo'), new File(['d'], 'more.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your photo of the problem' })).getAllByRole('img')).toHaveLength(3));
  });
});

describe('messages', () => {
  const message = (id: string, body: string, read: boolean, kind = 'job_offer') => ({
    id,
    kind,
    body,
    read,
    createdAt: '2026-11-11T09:00:00.000Z',
  });

  it('shows the pro how many messages are new and lists them, marking them read on opening', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/offers', { body: { offers: [] } });
    api.on('GET /pro/jobs', { body: { jobs: [] } });
    api.on('GET /pro/profile', { body: { profile: { status: 'approved', payoutsEnabled: true } } });
    api.on('GET /inbox', {
      body: {
        messages: [
          message('m2', 'MISK: the Lawn mowing job on Wed 11 Nov, 10:00 was cancelled.', false, 'booking_cancelled'),
          message('m1', 'MISK: the team gave you a job, Lawn mowing on Wed 11 Nov, 10:00. See the app for details.', false),
          message('m0', 'MISK: your payout of €37.31 is on its way.', true, 'payout_sent'),
        ],
        unread: 2,
      },
    });
    api.on('POST /inbox/read', { status: 204 });
    renderAt('/pro/week');
    const nav = await screen.findByRole('navigation', { name: 'Pro menu' });
    const tab = within(nav).getByRole('link', { name: /Messages/ });
    await waitFor(() => expect(tab).toHaveTextContent('2'));
    expect(tab).toHaveAccessibleName('Messages, 2');

    await user().click(tab);
    const list = await screen.findByRole('list', { name: 'Messages' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('The Lawn mowing job on Wed 11 Nov, 10:00 was cancelled.');
    expect(items[1]).toHaveTextContent('The team gave you a job');
    const [first, , oldest] = items;
    if (!first || !oldest) throw new Error('Messages missing');
    expect(within(first).getByText('New')).toBeInTheDocument();
    expect(within(oldest).queryByText('New')).not.toBeInTheDocument();
    await waitFor(() => expect(api.calls).toContain('POST /inbox/read'));
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Messages' })).toBeInTheDocument());
  });

  it('gives customers Messages too, with an explanation when there are none', async () => {
    fakeApi(users.customer);
    renderAt('/messages');
    expect(await screen.findByText(/No messages yet/)).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Main menu' })).getByRole('link', { name: 'Messages' })).toHaveAttribute(
      'href',
      '/messages',
    );
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
    jobsPaused: false,
    suspendedReason: null,
    ratingAverage: null,
    ratingCount: 0,
    trades: [],
    documents: { id: null, certificate: null, insurance: null, background: null },
  };

  it('asks for four documents, with the expiry date of the ID and insurance', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', { body: { profile: draft } });
    api.on('GET /postcodes', { body: { postcodes: [] } });
    const uploaded = {
      ...draft,
      documents: {
        ...draft.documents,
        insurance: {
          uploadId: 'f1',
          fileName: 'policy.pdf',
          uploadedAt: '2026-11-09T09:00:00.000Z',
          expiresOn: '2027-06-30',
          reviewStatus: 'pending' as const,
          reviewNote: null,
          state: 'waiting_review' as const,
        },
      },
    };
    let uploadUrl = '';
    api.on('POST /pro/documents/insurance', ({ url }) => {
      uploadUrl = url.search;
      return { status: 201, body: { profile: uploaded } };
    });
    renderAt('/pro');
    expect(await screen.findByText('Documents (0/4)')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload Certificate of good conduct')).toBeEnabled();
    const insurance = screen.getByLabelText('Upload Liability insurance');
    expect(insurance).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Valid until', { selector: '#expiry-insurance' }), { target: { value: '2027-06-30' } });
    expect(insurance).toBeEnabled();
    await user().upload(insurance, new File(['%PDF'], 'policy.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('policy.pdf')).toBeInTheDocument();
    expect(screen.getByText('Uploaded 9 Nov 2026. The MISK team checks it soon.')).toBeInTheDocument();
    expect(uploadUrl).toBe('?expiresOn=2027-06-30');
  });

  it('shows what the team asked for and lets the pro send the application again', async () => {
    const api = fakeApi(users.pro);
    const asked = { ...draft, status: 'info_requested' as const, reviewNote: 'Please send the back of your ID card.' };
    api.on('GET /pro/profile', { body: { profile: asked } });
    api.on('GET /postcodes', { body: { postcodes: [] } });
    api.on('POST /pro/submit', { body: { profile: { ...asked, status: 'submitted', reviewNote: null } } });
    renderAt('/pro');
    expect(await screen.findByText('Please send the back of your ID card.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Send application again' }));
    expect(await screen.findByText('Under review')).toBeInTheDocument();
  });

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

describe('monthly plans in the apps', () => {
  const lawn = {
    id: 'plan-lawn',
    name: 'Lawn care',
    categoryId: 'cat-garden',
    categoryName: 'Gardening',
    categoryIcon: 'leaf',
    priceCents: 4900,
    frequency: 'twice_weekly',
    visitMinutes: 60,
    tasks: ['Mow', 'Edge', 'Blow paths'],
    addonName: 'Hedge trimming',
    addonPriceCents: 1500,
    seasonal: false,
    seasonFrom: null,
    seasonTo: null,
    skipsPerMonth: 2,
    minTermMonths: 3,
    proSharePct: 70,
    status: 'published',
    publishedAt: '',
    updatedAt: '',
  };
  const future = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const subscription = (overrides: object = {}) => ({
    id: 'sub-1',
    planId: 'plan-lawn',
    planName: 'Lawn care',
    categoryId: 'cat-garden',
    tasks: ['Mow', 'Edge', 'Blow paths'],
    size: 'M',
    frequency: 'twice_weekly',
    days: [2, 4],
    timeWindow: 'morning',
    visitMinutes: 60,
    address: '12 Linden Street',
    postcode: '10115',
    notes: '',
    withAddon: true,
    addonName: 'Hedge trimming',
    priceCents: 6400,
    seasonal: false,
    seasonFrom: null,
    seasonTo: null,
    skipsPerMonth: 2,
    minTermMonths: 3,
    status: 'active',
    billingPaused: false,
    startedAt: new Date().toISOString(),
    currentPeriodEnd: future(30),
    endsAt: null,
    createdAt: '',
    proName: 'Daniel',
    cancelableFrom: future(90),
    visits: [
      { id: 'v1', startsAt: future(2), endsAt: future(2), status: 'planned', tasksDone: [] },
      { id: 'v2', startsAt: future(4), endsAt: future(4), status: 'planned', tasksDone: [] },
    ],
    skipsLeftThisMonth: 2,
    ...overrides,
  });

  it('lets a customer pick size, days, time and the extra, with a live monthly price, and subscribe', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /plans', { body: { plans: [lawn] } });
    api.on('GET /subscriptions', { body: { subscriptions: [] } });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('POST /subscriptions', { status: 201, body: { subscription: subscription(), payment: null } });
    api.on('GET /subscriptions/sub-1', { body: { subscription: subscription() } });
    renderAt('/plans');

    await user().click(await screen.findByRole('link', { name: /Lawn care/ }));
    const summary = await screen.findByRole('region', { name: 'Your monthly price' });
    expect(within(summary).getByText('€49')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Large/ }));
    expect(within(summary).getByText('€66.15')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Medium/ }));
    await user().click(screen.getByRole('checkbox', { name: /Hedge trimming/ }));
    expect(within(summary).getByText('€64')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: /Pick 2 more days/ });
    await user().click(submit);
    expect(screen.getByText('Choose 2 days for the visits.')).toBeInTheDocument();
    expect(screen.getByText('Enter the street and house number where the job is.')).toBeInTheDocument();
    expect(screen.getByText('Choose your postcode.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /subscriptions');
    await user().click(screen.getByRole('checkbox', { name: 'Tue' }));
    await user().click(screen.getByRole('checkbox', { name: 'Thu' }));
    await user().type(screen.getByLabelText('Street and house number'), '12 Linden Street');
    await user().selectOptions(screen.getByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('button', { name: 'Subscribe · €64/month' }));

    expect(await screen.findByText('Daniel is your regular pro')).toBeInTheDocument();
    expect(api.bodies['POST /subscriptions']).toEqual({
      planId: 'plan-lawn',
      size: 'M',
      days: [2, 4],
      timeWindow: 'morning',
      address: '12 Linden Street',
      postcode: '10115',
      notes: '',
      withAddon: true,
    });
  });

  it('lets the customer skip a visit, and explains when the plan can be cancelled', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /subscriptions/sub-1', { body: { subscription: subscription() } });
    api.on('POST /subscriptions/sub-1/visits/v1/skip', {
      body: {
        subscription: subscription({
          skipsLeftThisMonth: 1,
          visits: [
            { id: 'v1', startsAt: future(2), endsAt: future(2), status: 'skipped', tasksDone: [] },
            { id: 'v2', startsAt: future(4), endsAt: future(4), status: 'planned', tasksDone: [] },
          ],
        }),
      },
    });
    renderAt('/my-plans/sub-1');
    expect(await screen.findByText('Skips left this month: 2')).toBeInTheDocument();
    await user().click(screen.getAllByRole('button', { name: 'Skip' })[0] as HTMLElement);
    expect(await screen.findByText('Skips left this month: 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel this plan' })).not.toBeInTheDocument();
    expect(screen.getByText(/You can cancel from/)).toBeInTheDocument();
  });

  it('shows the pro the plans in their trades and plan visits with a task checklist', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /pro/profile', {
      body: {
        profile: {
          status: 'approved',
          homePostcode: '10115',
          radiusKm: 12,
          workingDays: [1, 2, 3, 4, 5],
          reviewNote: null,
          payoutsEnabled: true,
          hasPayoutAccount: true,
          ratingAverage: 4.9,
          ratingCount: 10,
          trades: ['cat-garden'],
          documents: { id: null, certificate: null, insurance: null },
        },
      },
    });
    api.on('GET /pro/offers', { body: { offers: [] } });
    api.on('GET /pro/jobs', { body: { jobs: [] } });
    const visit = {
      id: 'v1',
      subscriptionId: 'sub-1',
      startsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 7200 * 1000).toISOString(),
      status: 'planned',
      tasksDone: [],
      tasks: ['Mow', 'Edge'],
      planName: 'Lawn care',
      address: '12 Linden Street',
      postcode: '10115',
      notes: '',
      customerName: 'Sara',
      earningsCents: 798,
    };
    api.on('GET /pro/visits', { body: { visits: [visit] } });
    api.on('GET /pro/plans', { body: { plans: [{ ...lawn, mySubscribers: 3, earningsPerMonthCents: 3430, visitsPerMonth: 8.7 }] } });
    api.on('GET /pro/visits/v1', { body: { visit } });
    api.on('POST /pro/visits/v1/complete', { body: { visit: { status: 'completed', tasksDone: ['Mow', 'Edge'] } } });
    renderAt('/pro');

    const plans = await screen.findByRole('region', { name: 'Monthly plans in your trades' });
    expect(await within(plans).findByText('You earn €34.30/month')).toBeInTheDocument();
    expect(within(plans).getByText('3 of your customers')).toBeInTheDocument();

    await user().click(await screen.findByRole('link', { name: /Lawn care/ }));
    const complete = await screen.findByRole('button', { name: 'Complete with 0 of 2 tasks' });
    await user().click(screen.getByRole('checkbox', { name: 'Mow' }));
    await user().click(screen.getByRole('checkbox', { name: 'Edge' }));
    expect(complete).toHaveAccessibleName('Complete the visit');
    await user().click(complete);
    expect(await screen.findByText('Visit completed.')).toBeInTheDocument();
    expect(api.bodies['POST /pro/visits/v1/complete']).toEqual({ tasksDone: ['Mow', 'Edge'] });
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
        city: 'Berlin',
        timezone: 'Europe/Berlin',
        kpis: {
          bookings: 0,
          previousBookings: 0,
          bookingsChangePct: null,
          completed: 0,
          activeSubscriptions: 0,
          newSubscriptions: 0,
          grossCents: 0,
          previousGrossCents: 0,
          grossChangePct: null,
          payoutCents: 0,
          miskShareCents: 0,
          ratingAverage: null,
          ratingCount: 0,
          onTimePct: null,
        },
        weekly: [],
        attention: { pendingApplications: 0, unassigned: 0, unreleasedHolds: 0, failedPayouts: 0 },
      },
    });
    api.on('GET /admin/overview/live', { body: { bookings: [], applications: { waiting: 0, pros: [] } } });
    api.on('GET /admin/bookings', { body: { bookings: [], counts: { all: 0, needs_action: 0, live: 0, upcoming: 0, done: 0 }, truncated: false } });
    api.on('GET /admin/pros', { body: { pros: [] } });
    api.on('GET /admin/plans', { body: { plans: [] } });
    api.on('GET /admin/catalogue', { body: { categories: [], services: [] } });
    api.on('GET /admin/settings', {
      body: {
        settings: {
          serviceFeeCents: 290,
          commissionPct: 18,
          proSharePct: 82,
          payoutInterval: 'weekly',
          nextPayoutOn: '2026-11-13',
          freeCancelHours: 24,
          chargeDelayHours: 24,
        },
      },
    });
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

  it('has four Settings tabs, the saved label, and sign out at the top', async () => {
    const api = fakeApi(users.admin);
    stubAdminPages(api);
    api.on('GET /admin/zones', { body: { zones: [], elsewhere: [] } });
    renderAt('/admin/areas');
    expect(await screen.findByRole('heading', { level: 2, name: 'Zones' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Fees & payments',
      'Service area',
      'Notifications',
      'Team & access',
    ]);
    expect(screen.getByText('All changes saved', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('shows each team role only its parts of the control panel', async () => {
    const support = { ...users.admin, adminRole: 'support' as const, areas: ['overview' as const, 'bookings' as const, 'providers' as const] };
    const api = fakeApi(support);
    stubAdminPages(api);
    renderAt('/admin');
    const nav = await screen.findByRole('navigation', { name: 'Control panel' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Bookings', 'Providers']);
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

  function openExistingPlan(status = 'draft') {
    const api = fakeApi(users.admin);
    api.on('GET /admin/catalogue', { body: { categories, services: [] } });
    api.on('GET /admin/plans', { body: { plans: [] } });
    const plan = savedPlan(
      {
        name: 'Lawn care',
        categoryId: 'cat-garden',
        priceCents: 4900,
        frequency: 'weekly',
        visitMinutes: 60,
        tasks: ['Mow'],
        addonName: null,
        addonPriceCents: null,
        seasonal: false,
        skipsPerMonth: 2,
        minTermMonths: 3,
        proSharePct: 70,
        subscribers: 0,
      },
      status,
    );
    api.on('GET /admin/plans/p1', { body: { plan } });
    renderAt('/admin/plans/p1');
    return api;
  }

  it('deletes a plan after asking, and says so on the plans list', async () => {
    const api = openExistingPlan('published');
    api.on('DELETE /admin/plans/p1', { status: 204 });
    await user().click(await screen.findByRole('button', { name: 'Delete plan' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Lawn care"?' });
    expect(dialog).toHaveTextContent('it disappears from the app at once');
    await user().click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.calls).not.toContain('DELETE /admin/plans/p1');

    await user().click(screen.getByRole('button', { name: 'Delete plan' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByText('"Lawn care" was deleted.')).toBeInTheDocument();
    expect(api.calls).toContain('DELETE /admin/plans/p1');
  });

  it('explains why a plan with subscribers cannot be deleted', async () => {
    const api = openExistingPlan();
    api.on('DELETE /admin/plans/p1', { status: 409, body: { error: 'plan_has_subscriptions' } });
    await user().click(await screen.findByRole('button', { name: 'Delete plan' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Customers have subscribed to this plan, so it cannot be deleted.');
    expect(screen.getByRole('heading', { level: 1, name: /plan/i })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('offers no delete for a plan that was never saved', async () => {
    openNewPlan();
    await screen.findByLabelText('Plan name');
    expect(screen.queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
  });

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

  it('leaves an emptied number field empty and explains the limits before saving', async () => {
    const api = openNewPlan();
    await fillComplete();
    const length = screen.getByLabelText('Visit length (minutes)');
    await user().clear(length);
    expect(length).toHaveValue(null);
    expect(length).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a visit length from 15 to 600 minutes, in steps of 15.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish plan' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    expect(api.calls).not.toContain('POST /admin/plans');
    expect(length).toHaveFocus();

    await user().type(length, '50');
    expect(screen.getByText('Enter a visit length from 15 to 600 minutes, in steps of 15.')).toBeInTheDocument();
    await user().clear(length);
    await user().type(length, '45');
    expect(length).toHaveValue(45);
    expect(length).not.toHaveAttribute('aria-invalid');
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.bodies['POST /admin/plans']).toMatchObject({ visitMinutes: 45 }));
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
    await user().click(submit);
    expect(screen.getByText('Enter your first name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^First name/)).toHaveFocus();
    expect(api.calls).not.toContain('POST /auth/admin/register');
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

    // Another email can be entered right after, on an empty form.
    await user().click(screen.getByRole('button', { name: 'Request another account' }));
    const email = screen.getByLabelText(/^Work email address/);
    expect(email).toHaveValue('');
    expect(email).toBeEnabled();
    await user().type(screen.getByLabelText(/^First name/), 'Arta');
    await user().type(screen.getByLabelText(/^Last name/), 'Gashi');
    await user().type(email, 'arta@misk.test');
    await user().type(screen.getByLabelText(/^Password/), 'another long admin password');
    await user().type(screen.getByLabelText(/^Confirm password/), 'another long admin password');
    await user().click(screen.getByRole('button', { name: 'Request account' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your request is with the MISK team');
    expect(api.bodies['POST /auth/admin/register']).toMatchObject({ email: 'arta@misk.test' });
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
    expect(panel).not.toHaveTextContent('No email on your account');
    const email = within(panel).getByLabelText('Email');
    await user().type(email, 'not-an-email');
    await user().click(within(panel).getByRole('button', { name: 'Email me a reset link' }));
    expect(within(panel).getByText('Please enter a valid email address')).toBeInTheDocument();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).not.toContain('POST /auth/admin/forgot');
    await user().clear(email);
    await user().type(email, 'elion.thaqi@canera.ch');
    expect(within(panel).queryByText('Please enter a valid email address')).not.toBeInTheDocument();
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
    const member = (id: string, username: string) => ({
      id,
      username,
      email: null,
      firstName: null,
      lastName: null,
      role: 'admin',
      createdAt: '',
      invitedAt: null,
      disabled: false,
      pending: false,
      lastActive: null,
    });
    api.on('GET /admin/team', { body: { admins: [] } });
    api.on('GET /admin/team/members', {
      body: { members: [member('u-admin', 'admin'), member('u-elion', 'elion')], access: { admin: [], operations: [], support: [], finance: [] } },
    });
    api.on('GET /admin/activity', { body: { activity: [] } });
    api.on('POST /admin/team/u-elion/password', { status: 204 });
    renderAt('/admin/settings/team');
    const row = (await screen.findByText('elion', { selector: '.b' })).closest('tr') as HTMLElement;
    await user().click(within(row).getByRole('button', { name: 'Set new password' }));
    const form = within(row).getByRole('form', { name: 'New password for elion' });
    const submit = within(form).getByRole('button', { name: 'Set new password' });
    await user().type(within(form).getByLabelText('Password'), 'a brand new long password');
    await user().type(within(form).getByLabelText('Repeat password'), 'a brand new long passwor');
    expect(within(form).getByText('The passwords do not match.')).toBeInTheDocument();
    await user().click(submit);
    expect(api.calls).not.toContain('POST /admin/team/u-elion/password');
    expect(within(form).getByLabelText('Repeat password')).toHaveFocus();
    await user().type(within(form).getByLabelText('Repeat password'), 'd');
    await user().click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed for elion.');
    expect(api.bodies['POST /admin/team/u-elion/password']).toEqual({ password: 'a brand new long password' });
  });
});
