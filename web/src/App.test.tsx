import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    services: [{ id: 'svc-mow', name: 'Lawn mowing', priceCents: 4550, durationMinutes: 60 }],
    canReschedule: true,
    ...overrides,
  };
}

describe('log in', () => {
  it('opens the team’s "Invite pro" link with Email selected, and Phone one click away (D60)', async () => {
    fakeApi(null);
    renderAt('/signin?as=pro');
    const methods = await screen.findByRole('group', { name: 'How to log in' });
    expect(within(methods).getByRole('button', { name: 'Email' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(methods).getByRole('button', { name: 'Phone' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.queryByLabelText('Mobile number')).not.toBeInTheDocument();

    await user().click(within(methods).getByRole('button', { name: 'Phone' }));
    expect(screen.getByLabelText('Mobile number')).toBeInTheDocument();
    // The link remembers "invited as a pro" for the browser tab; later tests start without it.
    sessionStorage.clear();
  });

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
    await user().click(screen.getByRole('button', { name: 'Create account' }));

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

  it('marks required fields and says under each one what is missing when Create account is clicked', async () => {
    const api = fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    for (const label of Object.keys(complete) as Label[]) {
      expect(field(label)).toBeRequired();
      expect(field(label).closest('.field')?.querySelector('label .required')).toHaveTextContent('*');
    }
    await fill({ Password: 'garden42' });
    const submit = screen.getByRole('button', { name: 'Create account' });
    expect(submit).toBeEnabled();
    expect(screen.queryByText('Enter your first name.')).not.toBeInTheDocument();
    await user().click(submit);
    for (const message of [
      'Enter your first name.',
      'Enter your last name.',
      'Enter your email address.',
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
    await fill({ 'Last name': 'Meier', 'Email address': 'sara@example.com', 'Confirm password': 'garden42' });
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
    await user().click(screen.getByRole('button', { name: 'Create account' }));
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

  describe('password step', () => {
    const rulesList = () => screen.getByRole('list', { name: 'Password requirements' });
    const rule = (text: string) => within(rulesList()).getByText(text).closest('li');
    const open = async () => {
      fakeApi(null);
      renderAt('/signup');
      await screen.findByRole('heading', { name: 'Create your account' });
    };

    it('shows the checklist before typing and ticks each rule as it is met', async () => {
      await open();
      for (const text of ['At least 8 characters', 'At least one letter', 'At least one number']) {
        expect(rule(text)).not.toHaveClass('ok');
        expect(rule(text)).not.toHaveClass('bad');
      }
      expect(screen.getByText('0 of 3 password requirements met')).toBeInTheDocument();
      expect(screen.getByText('Special characters like ! ? # are allowed, but not needed.')).toBeInTheDocument();
      expect(field('Password')).toHaveAttribute('aria-describedby', rulesList().id);

      await user().type(field('Password'), 'abc');
      expect(rule('At least 8 characters')).not.toHaveClass('ok');
      expect(rule('At least one letter')).toHaveClass('ok');
      expect(rule('At least one number')).not.toHaveClass('ok');
      expect(rule('At least one number')).not.toHaveClass('bad');
      expect(screen.getByText('1 of 3 password requirements met')).toHaveAttribute('aria-live', 'polite');

      await user().type(field('Password'), 'defg1');
      expect(rule('At least 8 characters')).toHaveClass('ok');
      expect(rule('At least one letter')).toHaveClass('ok');
      expect(rule('At least one number')).toHaveClass('ok');
      expect(screen.getByText('3 of 3 password requirements met')).toBeInTheDocument();
    });

    it('keeps Create account disabled, with a reason, until every rule is met', async () => {
      await open();
      const submit = screen.getByRole('button', { name: 'Create account' });
      expect(submit).toBeDisabled();
      expect(submit).toHaveAccessibleDescription('Meet all password requirements to create your account.');
      await user().type(field('Password'), 'abcdefgh');
      expect(submit).toBeDisabled();
      await user().type(field('Password'), '1');
      expect(submit).toBeEnabled();
      expect(screen.queryByText('Meet all password requirements to create your account.')).not.toBeInTheDocument();
    });

    it.each(['pässwörd!1', 'abc!def#9'])('accepts special characters in %s', async (password) => {
      await open();
      await user().type(field('Password'), password);
      expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
    });

    it('does not count special characters as a number', async () => {
      await open();
      await user().type(field('Password'), 'abc!def#?!');
      expect(rule('At least one number')).not.toHaveClass('ok');
      expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    });

    it('shows unmet rules in red only after the field was left', async () => {
      await open();
      await user().type(field('Password'), 'garden');
      expect(rule('At least one number')).not.toHaveClass('bad');
      await user().tab();
      expect(rule('At least one number')).toHaveClass('bad');
      expect(rule('At least one letter')).toHaveClass('ok');
    });

    it('lets the person show or hide the password', async () => {
      await open();
      const password = field('Password');
      expect(password).toHaveAttribute('type', 'password');
      const toggle = password.parentElement?.querySelector('button') as HTMLButtonElement;
      expect(toggle).toHaveAccessibleName('Show password');
      await user().click(toggle);
      expect(password).toHaveAttribute('type', 'text');
      expect(toggle).toHaveAccessibleName('Hide password');
      await user().click(toggle);
      expect(password).toHaveAttribute('type', 'password');
    });
  });

  it('says the passwords do not match when Create account is clicked, and sends nothing', async () => {
    const api = fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill({ ...complete, 'Confirm password': 'garden43' });
    await user().click(screen.getByRole('checkbox', { name: /I accept/ }));
    expect(screen.queryByText('Passwords do not match')).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /auth/register');
  });

  it('does not send a weak password', async () => {
    const api = fakeApi(null);
    renderAt('/signup');
    await screen.findByRole('heading', { name: 'Create your account' });
    await fill({ ...complete, Password: 'gardening', 'Confirm password': 'gardening' });
    await user().click(screen.getByRole('checkbox', { name: /I accept/ }));
    const submit = screen.getByRole('button', { name: 'Create account' });
    expect(submit).toBeDisabled();
    await user().click(submit);
    expect(api.calls).not.toContain('POST /auth/register');
  });

  it('takes people with an account to the log-in page', async () => {
    fakeApi(null);
    renderAt('/signup');
    await user().click(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Log in to MISK' })).toBeInTheDocument();
  });
});

describe('reset password page', () => {
  it('keeps Save new password disabled until the password meets every rule', async () => {
    fakeApi(null);
    window.history.replaceState(null, '', '/reset-password#token=abcdefghijklmnopqrstuvwxyz123456');
    renderAt('/reset-password');
    const password = await screen.findByLabelText(/^New password/, { selector: 'input' });
    const submit = screen.getByRole('button', { name: 'Save new password' });
    expect(screen.getByRole('list', { name: 'Password requirements' })).toBeInTheDocument();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription('Meet all password requirements to save your new password.');
    await user().type(password, 'abcdefgh');
    expect(submit).toBeDisabled();
    await user().type(password, '!9');
    expect(screen.getByText('3 of 3 password requirements met')).toBeInTheDocument();
    expect(submit).toBeEnabled();
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
    await user().click(await screen.findByRole('button', { name: 'Past & receipts' }));
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
    renderAt('/bookings?tab=past');
    expect(await screen.findByText('Job 10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
  });

  it('shows upcoming jobs with Track and Chat, and plan visits, on the first tab', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', {
      body: {
        bookings: [
          { ...booking(0), id: 'b-up', status: 'accepted', serviceName: 'Hedge trimming', unreadMessages: 2, categoryIcon: 'leaf' },
          { ...booking(1), hasReceipt: true },
        ],
        planVisits: [
          {
            id: 'v1',
            startsAt: '2026-12-02T08:00:00.000Z',
            endsAt: '2026-12-02T09:00:00.000Z',
            subscriptionId: 's1',
            planName: 'Weekly lawn care',
            categoryId: 'cat-garden',
            categoryIcon: 'leaf',
            proName: 'Marta',
          },
        ],
      },
    });
    renderAt('/bookings');
    expect(await screen.findByText('Hedge trimming')).toBeInTheDocument();
    expect(screen.queryByText('Job 2')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Track' })).toHaveAttribute('href', '/bookings/b-up');
    expect(screen.getByRole('link', { name: /Chat\s*2 new/ })).toHaveAttribute('href', '/bookings/b-up/chat');
    expect(screen.getByRole('link', { name: /Weekly lawn care/ })).toHaveAttribute('href', '/my-plans/s1');
    expect(screen.getByRole('button', { name: 'Upcoming' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens the receipt of a past booking and emails it', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: [{ ...booking(0), hasReceipt: true, categorySlug: 'garden', categoryActive: true }] } });
    api.on('GET /bookings/b-0/receipt', {
      body: {
        receipt: {
          number: 'R-1042',
          bookingNumber: 'B-1042',
          date: '2026-11-06T10:00:00.000Z',
          serviceName: 'Lawn mowing',
          proName: 'Daniel',
          address: '12 Linden Street, 10115',
          lines: [
            { label: 'Lawn mowing, medium job', cents: 4550, kind: 'job' },
            { label: 'Trim the front hedge (approved in the app)', cents: 2000, kind: 'extra' },
            { label: 'Service fee', cents: 290, kind: 'fee' },
          ],
          totalCents: 6840,
          state: 'charging',
          chargeAt: '2026-11-07T10:00:00.000Z',
        },
      },
    });
    api.on('POST /bookings/b-0/receipt/email', { body: { sentTo: 'anna@example.com' } });
    renderAt('/bookings?tab=past');
    expect(await screen.findByRole('link', { name: 'Book again' })).toHaveAttribute('href', '/category/garden');
    await user().click(screen.getByRole('button', { name: 'Receipt' }));
    const sheet = await screen.findByRole('dialog', { name: 'Receipt' });
    expect(await within(sheet).findByText('Receipt #R-1042')).toBeInTheDocument();
    expect(within(sheet).getByText('Trim the front hedge (approved in the app)')).toBeInTheDocument();
    expect(within(sheet).getByText('€68.40')).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', expect.stringMatching(/\/bookings\/b-0\/receipt\.pdf$/));
    await user().click(within(sheet).getByRole('button', { name: 'Email' }));
    expect(await within(sheet).findByText('Receipt sent to anna@example.com.')).toBeInTheDocument();
    await user().keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a problem from the list: what went wrong first, then the detail', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: [{ ...booking(0), canReportProblem: true }] } });
    api.on('POST /bookings/b-0/problem', { body: { booking: {} } });
    renderAt('/bookings?tab=past');
    await user().click(await screen.findByRole('button', { name: 'Report' }));
    const sheet = screen.getByRole('dialog', { name: 'Report a problem' });
    await user().click(within(sheet).getByRole('button', { name: 'Send report' }));
    expect(within(sheet).getByText('Choose what went wrong.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /bookings/b-0/problem');
    await user().click(within(sheet).getByRole('radio', { name: 'Poor quality' }));
    await user().type(within(sheet).getByLabelText('Tell us more'), ' Edges not cut ');
    await user().click(within(sheet).getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.bodies['POST /bookings/b-0/problem']).toEqual({ note: 'Poor quality: Edges not cut' });
    expect(api.calls.filter((c) => c === 'GET /bookings').length).toBeGreaterThan(1);
  });
});

describe('the Services page (D68)', () => {
  const garden = catalogue.categories[0];
  const mowing = garden?.services[0];
  if (!garden || !mowing) throw new Error('test catalogue changed');
  const hedge = { ...mowing, id: 'svc-hedge', name: 'Hedge trimming', description: 'Shape hedges', priceCents: 4500, durationMinutes: 90 };
  const withHedge = { ...catalogue, categories: [{ ...garden, services: [mowing, hedge] }] };
  const plan = {
    id: 'plan-lawn',
    name: 'Lawn care',
    categoryId: 'cat-garden',
    categoryName: 'Gardening',
    categoryIcon: 'leaf',
    priceCents: 4900,
    frequency: 'weekly',
    visitMinutes: 60,
    tasks: ['Mow', 'Edge'],
    addonName: null,
    addonPriceCents: null,
    seasonal: true,
    seasonFrom: 3,
    seasonTo: 10,
    minTermMonths: 3,
    pauseNoticeDays: 7,
    maxPauseWeeks: 4,
    proSharePct: 70,
    status: 'published',
    publishedAt: '',
    updatedAt: '',
  };

  it('lists every service with tick boxes, prices a package, and continues to the job details', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /catalogue', { body: withHedge });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    renderAt('/category/gardening');
    expect(await screen.findByRole('heading', { name: 'Gardening' })).toBeInTheDocument();
    const lawn = screen.getByRole('checkbox', { name: /Lawn mowing/ });
    expect(lawn.closest('label')).toHaveTextContent('Mow, edge and clear');
    expect(lawn.closest('label')).toHaveTextContent('about 60 min');
    expect(lawn.closest('label')).toHaveTextContent('from €35');
    expect(screen.getByRole('button', { name: 'Choose a service' })).toBeDisabled();
    expect(screen.getByText(/Pick 2 or more for a 10% package price/)).toBeInTheDocument();

    await user().click(lawn);
    expect(screen.getByRole('button', { name: 'Continue · from €35' })).toBeEnabled();
    await user().click(screen.getByRole('checkbox', { name: /Hedge trimming/ }));
    expect(screen.getByText('Package price: 10% off.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Continue · 2 services, from €72' }));
    expect(await screen.findByRole('heading', { name: 'Lawn mowing + Hedge trimming' })).toBeInTheDocument();
    // Medium: (€45.50 + €58.50) - 10%.
    expect(screen.getByRole('button', { name: 'Continue · €93.60' })).toBeInTheDocument();
  });

  it('opens from a Home search result with the found service already ticked', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /catalogue', { body: withHedge });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/');
    const search = await screen.findByRole('searchbox', { name: 'What do you need help with?' });
    await user().type(search, 'hedge');
    const results = screen.getByRole('list', { name: 'Search results' });
    expect(within(results).queryByText('Lawn mowing')).not.toBeInTheDocument();
    await user().click(within(results).getByRole('link', { name: /Hedge trimming/ }));
    expect(await screen.findByRole('checkbox', { name: /Hedge trimming/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Lawn mowing/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue · from €45' })).toBeEnabled();
  });

  it('says when a search finds nothing', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/');
    await user().type(await screen.findByRole('searchbox'), 'piano');
    expect(screen.getByText('No services found')).toBeInTheDocument();
  });

  it('can untick a service again', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /catalogue', { body: withHedge });
    renderAt('/category/gardening');
    const lawn = await screen.findByRole('checkbox', { name: /Lawn mowing/ });
    await user().click(lawn);
    await user().click(lawn);
    expect(lawn).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Choose a service' })).toBeDisabled();
  });

  it('switches to the monthly plans of the trade and opens the plan builder', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /plans', { body: { plans: [plan, { ...plan, id: 'plan-other', name: 'Deep clean', categoryId: 'cat-clean' }] } });
    renderAt('/category/gardening');
    await user().click(await screen.findByRole('button', { name: /Monthly plan/ }));
    const card = await screen.findByRole('radio', { name: 'Lawn care' });
    expect(screen.queryByRole('radio', { name: 'Deep clean' })).not.toBeInTheDocument();
    const label = card.closest('label');
    expect(label).toHaveTextContent('from €41.65/month');
    expect(label).toHaveTextContent('1× a week (you can change it)');
    expect(label).toHaveTextContent('Mow, Edge');
    expect(label).toHaveTextContent('March to October');
    expect(label).toHaveTextContent("Minimum term: 3 months, then cancel with 30 days' notice");
    expect(label).toHaveTextContent("Pause up to 4 weeks a year, with 7 days' notice");
    expect(screen.getByRole('button', { name: 'Choose a plan' })).toBeDisabled();
    await user().click(card);
    expect(screen.getByRole('link', { name: /Customise Lawn care/ })).toHaveAttribute('href', '/plans/plan-lawn');
  });

  it('says when the trade has no plan yet and links to all plans', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /plans', { body: { plans: [] } });
    renderAt('/category/gardening?mode=plan');
    expect(await screen.findByText('No monthly plan for Gardening yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all plans' })).toHaveAttribute('href', '/plans');
  });

  it('sends unknown or mixed services back to the trade', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /catalogue', { body: withHedge });
    renderAt('/book?services=svc-mow,svc-gone');
    expect(await screen.findByRole('heading', { name: 'Gardening' })).toBeInTheDocument();
  });
});

describe('booking a job', () => {
  it('fills in the last address, prices each size, and sends the chosen photos with the booking (D69)', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }, { code: '10117', name: 'Mitte South' }] } });
    api.on('GET /bookings', {
      body: {
        bookings: [
          { id: 'old', status: 'completed', serviceName: 'Lawn mowing', categoryId: 'cat-garden', startsAt: '2026-10-01T09:00:00.000Z', totalCents: 4840, proName: null, canRate: false, address: '3 Old Road', postcode: '10115' },
          { id: 'new', status: 'completed', serviceName: 'Lawn mowing', categoryId: 'cat-garden', startsAt: '2026-11-01T09:00:00.000Z', totalCents: 4840, proName: null, canRate: false, address: '17 Maple Lane', postcode: '10117' },
        ],
      },
    });
    api.on('GET /plans', { body: { plans: [{ id: 'plan-lawn', name: 'Lawn care', categoryId: 'cat-garden', priceCents: 4900 }] } });
    api.on('GET /availability', {
      body: { slots: [{ startsAt: '2026-11-06T09:00:00.000Z', endsAt: '2026-11-06T10:00:00.000Z', freePros: 2, available: true }] },
    });
    api.on('POST /bookings', { status: 201, body: { booking: booking({ status: 'searching', pro: null }), payment: null } });
    api.on('POST /bookings/b1/photos', { status: 201, body: { booking: booking({ status: 'searching', pro: null }) } });
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'searching', pro: null }) } });
    renderAt('/book?services=svc-mow');

    await waitFor(() => expect(screen.getByLabelText('Street and house number')).toHaveValue('17 Maple Lane'));
    await waitFor(() => expect(screen.getByLabelText('Postcode')).toHaveValue('10117'));
    expect(screen.getByRole('radio', { name: /Small.*under 100 m².*€35/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Medium.*100 to 400 m².*€45.50/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Large.*over 400 m².*€/ })).toBeInTheDocument();
    expect(screen.getByText('Not sure?')).toBeInTheDocument();
    expect(screen.getByText("Pick your best guess. The pro checks on arrival. If it's bigger, you approve the extra price first. If it's smaller, you pay less.")).toBeInTheDocument();
    expect(screen.getByLabelText('Take a photo')).toHaveAttribute('capture', 'environment');
    expect(screen.getByText('Fixed price €45.50 for this size.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Need this regularly\? Make it a plan/ })).toHaveAttribute('href', '/plans/plan-lawn');

    await user().upload(screen.getByLabelText('Choose from gallery'), [
      new File(['a'], 'lawn.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'gate.png', { type: 'image/png' }),
    ]);
    expect(screen.getByRole('img', { name: 'lawn.jpg' })).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Remove gate.png' }));
    expect(screen.queryByRole('img', { name: 'gate.png' })).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Continue · €45.50' }));
    await user().click(await screen.findByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: /Continue · Fri 6 Nov, 10:00/ }));
    expect(screen.getByText('1 photo attached')).toBeInTheDocument();
    expect(screen.getByText('17 Maple Lane, 10117')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Book & pay €48.40' }));
    expect(await screen.findByText(/Finding your pro/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c === 'POST /bookings/b1/photos')).toHaveLength(1);
    expect(api.bodies['POST /bookings']).toMatchObject({ address: '17 Maple Lane', postcode: '10117' });
  });

  it('calls the middle size "Standard" outside gardening, and checks the address', async () => {
    const api = fakeApi(users.customer);
    const garden = catalogue.categories[0];
    const mowing = garden?.services[0];
    if (!garden || !mowing) throw new Error('test catalogue changed');
    api.on('GET /catalogue', {
      body: { ...catalogue, categories: [{ ...garden, id: 'cat-clean', slug: 'cleaning', name: 'Cleaning', icon: 'sparkle', services: [{ ...mowing, categoryId: 'cat-clean', name: 'Home cleaning' }] }] },
    });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/book?services=svc-mow');
    expect(await screen.findByRole('radio', { name: /Standard.*typical job/ })).toBeChecked();
    expect(screen.getByText('Job size')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Continue · / }));
    expect(screen.getByText('Enter the street and house number where the job is.')).toBeInTheDocument();
  });

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
    await user().type(await screen.findByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('radio', { name: /Large/ }));
    expect(screen.getByRole('button', { name: 'Continue · €59.50' })).toBeEnabled();
    await user().click(screen.getByRole('radio', { name: /Medium/ }));
    await user().click(screen.getByRole('button', { name: 'Continue · €45.50' }));

    expect(await screen.findByRole('button', { name: /08:00\s*Full · waiting list/ })).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: /Continue · Fri 6 Nov, 10:00/ }));

    expect(screen.getByText('€48.40')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Book & pay €48.40' }));
    expect(await screen.findByText(/Finding your pro/)).toBeInTheDocument();
    expect(api.bodies['POST /bookings']).toMatchObject({
      serviceIds: ['svc-mow'],
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
    const option = await screen.findByRole('checkbox', { name: /Gardener by the hour/ });
    expect(option.closest('label')).toHaveTextContent('New');
    expect(option.closest('label')).toHaveTextContent('€38/h');
    await user().click(option);
    await user().click(screen.getByRole('button', { name: 'Continue · €38/h' }));
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().type(await screen.findByLabelText('Postcode'), '10115');
    expect(screen.queryByRole('radio', { name: /Large/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Paid by the hour: €38\/h for about 2 h/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue · €76' })).toBeEnabled();
  });

  it('offers the waiting list for a postcode MISK does not serve and keeps Continue from going on', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    api.on('POST /waitlist', { status: 201, body: { postcode: '99999' } });
    renderAt('/book/svc-mow');
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().type(screen.getByLabelText('Postcode'), '10115');
    expect(screen.getByText('Mitte')).toBeInTheDocument();
    expect(screen.queryByText("MISK isn't available here yet")).not.toBeInTheDocument();
    await user().clear(screen.getByLabelText('Postcode'));
    await user().type(screen.getByLabelText('Postcode'), '99999');
    expect(screen.getByRole('status')).toHaveTextContent("MISK isn't available here yet");
    expect(screen.getByText("We're not in this area yet. Join the waiting list and we'll tell you as soon as we are.")).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Continue · / }));
    expect(screen.getByText("MISK isn't available at this postcode yet. Join the waiting list below, or use another address.")).toBeInTheDocument();
    expect(screen.queryByText('Choose a time')).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Join the waiting list' }));
    expect(api.bodies['POST /waitlist']).toEqual({ postcode: '99999' });
    expect(await screen.findByText("You're on the waiting list for 99999. We'll let you know.")).toBeInTheDocument();
  });

  it('asks for a valid postcode', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/book/svc-mow');
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().type(screen.getByLabelText('Postcode'), '---');
    await user().click(screen.getByRole('button', { name: /Continue · / }));
    expect(screen.getByText('Enter a valid postcode, for example 10115 or SW1A 1AA.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('accepts a postcode from another country, typed in any case and with spaces', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: 'SW1A 1AA', name: 'Westminster' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/book/svc-mow');
    await user().type(await screen.findByLabelText('Street and house number'), '1 Palace Street');
    const postcode = screen.getByLabelText('Postcode');
    await user().type(postcode, ' sw1a  1aa ');
    // Upper-case and single spaces while typing; the space at the end goes when the field is left.
    expect(postcode).toHaveValue('SW1A 1AA ');
    expect(screen.getByText('Westminster')).toBeInTheDocument();
    await user().tab();
    expect(postcode).toHaveValue('SW1A 1AA');
    expect(screen.queryByText("MISK isn't available here yet")).not.toBeInTheDocument();
  });

  it('adds photos from the camera or the gallery, up to 3', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/book/svc-mow');
    await user().upload(await screen.findByLabelText('Take a photo'), new File(['a'], 'one.jpg', { type: 'image/jpeg' }));
    expect(screen.getByRole('img', { name: 'one.jpg' })).toBeInTheDocument();
    await user().upload(screen.getByLabelText('Choose from gallery'), [
      new File(['b'], 'two.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'three.jpg', { type: 'image/jpeg' }),
    ]);
    expect(screen.getByRole('img', { name: 'three.jpg' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Take a photo')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Choose from gallery')).not.toBeInTheDocument();
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
    await user().type(await screen.findByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('button', { name: /Continue/ }));
    await user().click(await screen.findByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: /Continue · / }));
    await user().click(screen.getByRole('button', { name: /Book & pay/ }));
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
    expect(await screen.findByText('Approved by you')).toBeInTheDocument();
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

  it('shows the pro, the timeline and a way to rate once the job is done', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'on_the_way', unreadMessages: 1 }) } });
    renderAt('/bookings/b1');
    expect(await screen.findByRole('link', { name: 'Chat with Daniel' })).toHaveAttribute('href', '/bookings/b1/chat');
    expect(screen.getByRole('link', { name: 'Daniel sent you a message' })).toHaveAttribute('href', '/bookings/b1/chat');
    expect(screen.getByText('12 Linden Street, 10115')).toBeInTheDocument();
  });

  it('links to the rating once the job is done, and opens the receipt', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, canRate: true }) } });
    api.on('GET /bookings/b1/receipt', { status: 404, body: { error: 'no_receipt' } });
    renderAt('/bookings/b1');
    expect(await screen.findByRole('heading', { name: 'Job complete' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rate Daniel' })).toHaveAttribute('href', '/bookings/b1/rate');
    await user().click(screen.getByRole('button', { name: 'Receipt' }));
    expect(await within(screen.getByRole('dialog', { name: 'Receipt' })).findByText('This could not be loaded.')).toBeInTheDocument();
  });

  it('takes stars, tags, a written review and a tip in one go', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false };
    api.on('GET /bookings/b1', { body: { booking: booking({ ...done, canRate: true, canTip: true }) } });
    const rated = { ...done, canRate: false, canTip: true, rating: { stars: 5, tags: ['tidy'], review: 'Lovely work' } };
    api.on('POST /bookings/b1/rating', { status: 201, body: { booking: booking(rated) } });
    api.on('POST /bookings/b1/tip', {
      status: 201,
      body: { booking: booking({ ...rated, canTip: false, tip: { amountCents: 500, proCents: 410, status: 'captured' } }) },
    });
    renderAt('/bookings/b1/rate');
    expect(await screen.findByRole('heading', { name: 'How was Daniel?' })).toBeInTheDocument();
    expect(screen.getByText('(82% goes to Daniel)')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send review' });
    await user().click(send);
    expect(screen.getByText('Choose from 1 to 5 stars.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /bookings/b1/rating');
    await user().click(screen.getByRole('radio', { name: '5 stars' }));
    await user().click(screen.getByRole('checkbox', { name: 'Tidy work' }));
    await user().type(screen.getByLabelText(/Write a review/), 'Lovely work');
    await user().click(screen.getByRole('radio', { name: '€5' }));
    expect(screen.getByText('€4.10 goes to Daniel.')).toBeInTheDocument();
    await user().click(send);
    expect(await screen.findByText('Review sent')).toBeInTheDocument();
    expect(screen.getByText('Daniel gets €4.10 of your tip and your 5-star rating.')).toBeInTheDocument();
    expect(api.bodies['POST /bookings/b1/rating']).toEqual({ stars: 5, tags: ['tidy'], review: 'Lovely work' });
    expect(api.bodies['POST /bookings/b1/tip']).toEqual({ amountCents: 500 });
    expect(screen.getByRole('link', { name: /See the plans/ })).toHaveAttribute('href', '/plans');
  });

  it('sends no tip when "No tip" stays chosen', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false };
    api.on('GET /bookings/b1', { body: { booking: booking({ ...done, canRate: true, canTip: true }) } });
    api.on('POST /bookings/b1/rating', { status: 201, body: { booking: booking({ ...done, canTip: true, rating: { stars: 4, tags: [] } }) } });
    renderAt('/bookings/b1/rate');
    await user().click(await screen.findByRole('radio', { name: '4 stars' }));
    await user().click(screen.getByRole('button', { name: 'Send review' }));
    expect(await screen.findByText('Review sent')).toBeInTheDocument();
    expect(api.bodies['POST /bookings/b1/rating']).toEqual({ stars: 4, tags: [] });
    expect(api.calls).not.toContain('POST /bookings/b1/tip');
  });

  it('still takes a tip after the review', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false, canTip: true, rating: { stars: 5, tags: [] } };
    api.on('GET /bookings/b1', { body: { booking: booking(done) } });
    api.on('POST /bookings/b1/tip', {
      status: 201,
      body: { booking: booking({ ...done, canTip: false, tip: { amountCents: 1000, proCents: 820, status: 'captured' } }) },
    });
    renderAt('/bookings/b1/rate');
    expect(await screen.findByText('Add a tip for Daniel?')).toBeInTheDocument();
    expect(screen.getByText('€4.10 goes to Daniel.')).toBeInTheDocument();
    await user().click(screen.getByRole('radio', { name: '€10' }));
    expect(screen.getByText('€8.20 goes to Daniel.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Tip €10' }));
    expect(api.bodies['POST /bookings/b1/tip']).toEqual({ amountCents: 1000 });
    expect(await screen.findByText('Daniel gets €8.20 of your tip and your 5-star rating.')).toBeInTheDocument();
  });

  it('lets the customer report a problem before the card is charged', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false, chargeAt: '2026-11-07T10:00:00.000Z' };
    api.on('GET /bookings/b1', { body: { booking: booking({ ...done, canReportProblem: true }) } });
    api.on('POST /bookings/b1/problem', {
      body: {
        booking: booking({ ...done, canReportProblem: false, problemReportedAt: '2026-11-06T12:00:00.000Z', problemNote: 'Other: Back lawn not mowed' }),
      },
    });
    renderAt('/bookings/b1');
    expect(await screen.findByText('We charge your card on Sat 7 Nov, 11:00. Not happy with the job? Tell us before then.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Report' }));
    const sheet = screen.getByRole('dialog', { name: 'Report a problem' });
    const send = within(sheet).getByRole('button', { name: 'Send report' });
    await user().click(within(sheet).getByRole('radio', { name: 'Other' }));
    await user().click(send);
    expect(within(sheet).getByText('Tell us what went wrong.')).toBeInTheDocument();
    await user().type(within(sheet).getByLabelText('Tell us more'), 'No');
    expect(within(sheet).getByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /bookings/b1/problem');
    await user().clear(within(sheet).getByLabelText('Tell us more'));
    await user().type(within(sheet).getByLabelText('Tell us more'), '  Back lawn not mowed ');
    await user().click(send);
    expect(await screen.findByText('within 2 hours. The payment is on hold.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.bodies['POST /bookings/b1/problem']).toEqual({ note: 'Other: Back lawn not mowed' });
  });

  it('sends photos with the problem report, and can add more while it is open', async () => {
    const api = fakeApi(users.customer);
    const done = { status: 'completed' as const, canCancel: false, chargeAt: '2026-11-07T10:00:00.000Z' };
    const reported = { ...done, canReportProblem: false, problemReportedAt: '2026-11-06T12:00:00.000Z', problemNote: 'Something was damaged: Mud on the terrace' };
    let photos: { id: string; kind: 'problem' }[] = [];
    api.on('GET /bookings/b1', { body: { booking: booking({ ...done, canReportProblem: true }) } });
    api.on('POST /bookings/b1/problem', () => ({ body: { booking: booking({ ...reported, photos }) } }));
    api.on('POST /bookings/b1/problem/photos', () => {
      photos = [...photos, { id: `photo-${photos.length + 1}`, kind: 'problem' }];
      return { status: 201, body: { booking: booking({ ...reported, photos }) } };
    });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Report' }));
    const sheet = screen.getByRole('dialog', { name: 'Report a problem' });
    await user().click(within(sheet).getByRole('radio', { name: 'Something was damaged' }));
    await user().type(within(sheet).getByLabelText('Tell us more'), 'Mud on the terrace');
    await user().upload(within(sheet).getByLabelText('Add photos'), [
      new File(['a'], 'terrace.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'steps.png', { type: 'image/png' }),
      new File(['c'], 'extra.png', { type: 'image/png' }),
    ]);
    expect(within(within(sheet).getByRole('list', { name: 'Photos to send' })).getAllByRole('listitem')).toHaveLength(3);
    await user().click(within(sheet).getByRole('button', { name: 'Remove extra.png' }));
    expect(within(within(sheet).getByRole('list', { name: 'Photos to send' })).getAllByRole('listitem')).toHaveLength(2);

    await user().click(within(sheet).getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText('within 2 hours. The payment is on hold.', { exact: false })).toBeInTheDocument();
    expect(api.calls.filter((c) => c === 'POST /bookings/b1/problem/photos')).toHaveLength(2);
    expect(screen.getByText('Something was damaged: Mud on the terrace')).toBeInTheDocument();
    const sent = screen.getByRole('list', { name: 'Your photo of the problem' });
    expect(within(sent).getAllByRole('img')).toHaveLength(2);

    await user().upload(screen.getByLabelText('Add a photo'), new File(['d'], 'more.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your photo of the problem' })).getAllByRole('img')).toHaveLength(3));
  });
});

describe('chat with the pro (D67)', () => {
  const pending = { id: 'x1', description: 'Trim the front hedge', priceCents: 2000, status: 'pending' as const, createdAt: '2026-11-06T09:30:00.000Z' };
  const message = (id: string, from: 'customer' | 'pro', body: string) => ({ id, from, body, createdAt: `2026-11-06T09:2${id}:00.000Z`, readAt: null });

  it('shows messages, status notes and extra work, and sends typed and quick messages', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'working', extras: [pending] }) } });
    api.on('GET /bookings/b1/messages', { body: { messages: [message('1', 'pro', 'Starting with the back lawn')], canWrite: true } });
    let sent = 1;
    api.on('POST /bookings/b1/messages', () => {
      sent += 1;
      return { status: 201, body: { message: message(String(sent), 'customer', sent === 2 ? 'The gate code is 4411' : 'Thanks!') } };
    });
    api.on('POST /bookings/b1/extras/x1/approve', {
      body: { booking: booking({ status: 'working', extras: [{ ...pending, status: 'approved' }], extrasCents: 2000, totalCents: 6840 }), payment: null },
    });
    renderAt('/bookings/b1/chat');
    const log = await screen.findByRole('log', { name: 'Conversation with Daniel' });
    expect(await within(log).findByText('Starting with the back lawn')).toBeInTheDocument();
    expect(within(log).getByText('Daniel accepted your job')).toBeInTheDocument();
    expect(screen.getByText('● Working on your job')).toBeInTheDocument();

    await user().type(screen.getByLabelText('Message to Daniel'), '  The gate code is 4411 ');
    await user().click(screen.getByRole('button', { name: 'Send' }));
    expect(api.bodies['POST /bookings/b1/messages']).toEqual({ body: 'The gate code is 4411' });
    expect(await within(log).findByText('The gate code is 4411')).toBeInTheDocument();
    expect(screen.getByLabelText('Message to Daniel')).toHaveValue('');

    await user().click(within(screen.getByRole('group', { name: 'Quick replies' })).getByRole('button', { name: 'Thanks!' }));
    expect(api.bodies['POST /bookings/b1/messages']).toEqual({ body: 'Thanks!' });

    await user().click(within(log).getByRole('button', { name: 'Approve +€20' }));
    expect(await within(log).findByText('Approved by you')).toBeInTheDocument();
  });

  it('is closed after the job, with a way to rate the pro instead', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, canRate: true }) } });
    api.on('GET /bookings/b1/messages', { body: { messages: [], canWrite: false } });
    renderAt('/bookings/b1/chat');
    expect(await screen.findByText('This job is done, so the chat is read-only.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message to Daniel')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rate Daniel' })).toHaveAttribute('href', '/bookings/b1/rate');
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

  it('announces a job the team gave the pro, and a cancelled job, at the top of the app', async () => {
    sessionStorage.clear();
    const api = fakeApi(users.pro);
    api.on('GET /pro/offers', { body: { offers: [] } });
    api.on('GET /pro/jobs', { body: { jobs: [] } });
    api.on('GET /pro/profile', { body: { profile: { status: 'approved', payoutsEnabled: true } } });
    let messages = [message('m0', 'MISK: your payout of €37.31 is on its way.', true, 'payout_sent')];
    api.on('GET /inbox', () => ({ body: { messages, unread: messages.filter((m) => !m.read).length } }));
    api.on('POST /inbox/read', { status: 204 });
    renderAt('/pro/week');
    await screen.findByRole('navigation', { name: 'Pro menu' });
    // Old, read messages are not announced.
    expect(screen.queryByText('New message')).not.toBeInTheDocument();

    // The team assigns a job; the next check announces it.
    messages = [message('m1', 'MISK: the team gave you a job, Lawn mowing on Wed 11 Nov, 10:00. See the app for details.', false), ...messages];
    fireEvent(document, new Event('visibilitychange'));
    const banner = await screen.findByText('New message');
    const box = banner.closest('[role="status"]') as HTMLElement;
    expect(box).toHaveTextContent('The team gave you a job, Lawn mowing on Wed 11 Nov, 10:00.');
    expect(within(box).getByRole('link', { name: 'Open messages' })).toHaveAttribute('href', '/pro/messages');
    await user().click(within(box).getByRole('button', { name: 'Close the new message' }));
    expect(screen.queryByText('New message')).not.toBeInTheDocument();

    // Then the team cancels it: announced again, and closing one does not hide the next.
    messages = [message('m2', 'MISK: the Lawn mowing job on Wed 11 Nov, 10:00 was cancelled.', false, 'booking_cancelled'), ...messages];
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText('The Lawn mowing job on Wed 11 Nov, 10:00 was cancelled.')).toBeInTheDocument();
    // Opening Messages reads them and the banner goes.
    await user().click(screen.getByRole('link', { name: 'Open messages' }));
    await waitFor(() => expect(api.calls).toContain('POST /inbox/read'));
    expect(screen.queryByText('New message')).not.toBeInTheDocument();
  });

  it('gives customers Messages too, from Profile, with an explanation when there are none', async () => {
    fakeApi(users.customer);
    renderAt('/profile');
    const menu = await screen.findByRole('navigation', { name: 'Main menu' });
    // Messages left the menu (D89); Profile links to it.
    expect(within(menu).queryByRole('link', { name: 'Messages' })).not.toBeInTheDocument();
    await user().click(await screen.findByRole('link', { name: 'Messages' }));
    expect(await screen.findByText(/No messages yet/)).toBeInTheDocument();
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

  // The Application and Application status pages (D93) are covered in pages/pro/Application.test.tsx.
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

  it('(D70) lets a pro pick the start of a flexible job when accepting it', async () => {
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
            startsAt: '2026-11-06T07:00:00.000Z',
            endsAt: '2026-11-06T10:00:00.000Z',
            address: '12 Linden Street',
            postcode: '10115',
            notes: '',
            customerName: 'Sara',
            distanceKm: 2.3,
            photoIds: [],
            earningsCents: 3731,
            flexibleWindow: 'morning',
            startOptions: ['2026-11-06T07:00:00.000Z', '2026-11-06T09:00:00.000Z'],
          },
        ],
      },
    });
    api.on('POST /pro/offers/o1/accept', { body: { job: { id: 'b1' } } });
    api.on('GET /pro/jobs/b1', { body: { job: { ...booking(), customer: { firstName: 'Sara' }, earningsCents: 3731 } } });
    renderAt('/pro');
    const offer = await screen.findByRole('article', { name: 'New job request' });
    expect(within(offer).getByText('Fri 6 Nov, morning · you pick the time')).toBeInTheDocument();
    expect(within(offer).getByRole('button', { name: 'Accept job' })).toBeDisabled();
    await user().click(within(offer).getByRole('radio', { name: '10:00' }));
    await user().click(within(offer).getByRole('button', { name: 'Accept, start 10:00' }));
    expect(api.bodies['POST /pro/offers/o1/accept']).toEqual({ startsAt: '2026-11-06T09:00:00.000Z' });
  });
});

describe('Choose time (D70)', () => {
  /** A slot `days` days ahead at a local hour (Berlin winter time is UTC+1). */
  const at = (days: number, localHour: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    date.setUTCHours(localHour - 1, 0, 0, 0);
    return date.toISOString();
  };
  const slot = (startsAt: string, available: boolean, freePros = available ? 2 : 0) => ({
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3600_000).toISOString(),
    freePros,
    available,
  });
  const berlinDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(iso));

  function setUp(slots: ReturnType<typeof slot>[], waitlist: object[] = [], held: object[] = []) {
    const api = fakeApi(users.customer);
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    api.on('GET /availability', { body: { slots, waitlist, held } });
    return api;
  }

  async function toTimeStep() {
    renderAt('/book?services=svc-mow');
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().type(await screen.findByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('button', { name: /Continue · / }));
  }

  it('puts the customer on the waiting list for a full time, or for the whole day, and off again', async () => {
    const full = at(3, 8);
    const api = setUp([slot(full, false), slot(at(3, 10), true)]);
    let entries = 0;
    api.on('POST /time-waitlist', ({ body }) => {
      entries += 1;
      const b = body as { day: string; startsAt?: string };
      return { status: 201, body: { entry: { id: `w${entries}`, day: b.day, startsAt: b.startsAt ?? null, notifiedAt: null } } };
    });
    api.on('DELETE /time-waitlist/w1', { status: 204 });
    await toTimeStep();

    await user().click(await screen.findByRole('button', { name: /08:00\s*Full · waiting list/ }));
    expect(api.bodies['POST /time-waitlist']).toEqual({ serviceIds: ['svc-mow'], postcode: '10115', day: berlinDay(full), startsAt: full });
    expect(await screen.findByRole('button', { name: /08:00\s*On waiting list/ })).toHaveAttribute('aria-pressed', 'true');
    await user().click(screen.getByRole('button', { name: /08:00\s*On waiting list/ }));
    expect(await screen.findByRole('button', { name: /08:00\s*Full · waiting list/ })).toBeInTheDocument();
    expect(api.calls).toContain('DELETE /time-waitlist/w1');

    await user().click(screen.getByRole('button', { name: /Join the waiting list for this day/ }));
    expect(api.bodies['POST /time-waitlist']).toEqual({ serviceIds: ['svc-mow'], postcode: '10115', day: berlinDay(full) });
    expect(await screen.findByText('On the waiting list for this day')).toBeInTheDocument();
    expect(screen.getByText('Joined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select a time' })).toBeDisabled();
  });

  it('books a flexible window: the pro picks the time by the evening before', async () => {
    const day = at(3, 8);
    const api = setUp([slot(day, false), slot(at(3, 12), true), slot(at(3, 14), true)]);
    api.on('POST /bookings', { status: 201, body: { booking: booking({ status: 'searching', pro: null }), payment: null } });
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'searching', pro: null, flexibleWindow: 'afternoon', timeConfirmed: false, confirmBy: day }) } });
    await toTimeStep();
    await user().click(await screen.findByRole('button', { name: "I'm flexible" }));
    // Morning has no free pro on this day.
    expect(await screen.findByText(/No pro is free in this window/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select a time' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: /^Afternoon/ }));
    expect(await screen.findByText('Flexible booking.')).toBeInTheDocument();
    await user().click(await screen.findByRole('button', { name: /Continue · .+, afternoon/ }));
    expect(await screen.findByText(/afternoon · your pro picks the time by 18:00 the evening before/)).toBeInTheDocument();
    await user().click(await screen.findByRole('button', { name: /Book & pay/ }));
    // The review step already shows "your pro picks the time by", so wait for the booking request itself.
    await waitFor(() => expect(api.bodies['POST /bookings']).toBeDefined());
    expect(await screen.findByText(/your pro picks the time by/)).toBeInTheDocument();
    const sent = api.bodies['POST /bookings'] as Record<string, unknown>;
    expect(sent).toMatchObject({ flexibleWindow: 'afternoon', day: berlinDay(day) });
    expect(sent.startsAt).toBeUndefined();
  });

  it('shows the windows with their hours and when the exact time is confirmed (D74)', async () => {
    setUp([slot(at(3, 8), true), slot(at(3, 14), true)]);
    await toTimeStep();
    await user().click(await screen.findByRole('button', { name: "I'm flexible" }));
    expect(screen.getByRole('button', { name: /^Morning\s*08:00 to 12:00$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Afternoon\s*12:00 to 18:00$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Any time' })).toBeInTheDocument();
    expect(screen.getByText(/The exact time is confirmed by 18:00 the day before/)).toBeInTheDocument();
  });

  it('shows a time held for the customer for 15 minutes (D74)', async () => {
    const freed = at(3, 10);
    setUp([slot(at(3, 8), false), slot(freed, true)], [], [{ startsAt: freed, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }]);
    await toTimeStep();
    expect(await screen.findByRole('button', { name: /10:00\s*Held for you until \d\d:\d\d/ })).toBeInTheDocument();
  });

  it('does not offer a flexible time for today', async () => {
    setUp([slot(at(0, 23), true)]);
    await toTimeStep();
    await user().click(await screen.findByRole('button', { name: "I'm flexible" }));
    expect(screen.getByText(/confirmed by 18:00 the day before, so it is not possible for this day/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select a time' })).toBeDisabled();
  });

});

describe('Review & pay (D73)', () => {
  const garden = catalogue.categories[0];
  const mowing = garden?.services[0];
  if (!garden || !mowing) throw new Error('test catalogue changed');
  const hedge = { ...mowing, id: 'svc-hedge', name: 'Hedge trimming', priceCents: 4500, durationMinutes: 90 };
  const visa = { id: 'pm_visa', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 };
  const master = { id: 'pm_mc', brand: 'mastercard', last4: '5555', expMonth: 1, expYear: 2029 };

  function setUp(methods: object, withHedge = false) {
    const api = fakeApi(users.customer);
    if (withHedge) api.on('GET /catalogue', { body: { ...catalogue, categories: [{ ...garden, services: [mowing, hedge] }] } });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }] } });
    api.on('GET /bookings', { body: { bookings: [] } });
    api.on('GET /availability', {
      body: { slots: [{ startsAt: '2026-11-06T09:00:00.000Z', endsAt: '2026-11-06T10:00:00.000Z', freePros: 2, available: true }], waitlist: [] },
    });
    api.on('GET /payment-methods', { body: { cards: [], cardsAvailable: true, last: null, publishableKey: null, ...methods } });
    api.on('POST /bookings', { status: 201, body: { booking: booking({ status: 'searching', pro: null }), payment: null } });
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'searching', pro: null }) } });
    return api;
  }

  async function toReview(services = 'svc-mow') {
    renderAt(`/book?services=${services}`);
    await user().type(await screen.findByLabelText('Street and house number'), '12 Linden Street');
    await user().type(await screen.findByLabelText('Postcode'), '10115');
    await user().click(screen.getByRole('button', { name: /Continue · / }));
    await user().click(await screen.findByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: /Continue · Fri 6 Nov, 10:00/ }));
    await screen.findByRole('heading', { name: 'Review & pay' });
  }

  it('repeats the choices with the price, fee and total on their own lines', async () => {
    setUp({});
    await toReview();
    const summary = screen.getByRole('region', { name: 'Your booking' });
    expect(summary).toHaveTextContent('Lawn mowing');
    expect(summary).toHaveTextContent('Medium · about 1 h');
    expect(summary).toHaveTextContent('Fri 6 Nov, 10:00');
    expect(summary).toHaveTextContent('12 Linden Street, 10115');
    expect(summary).toHaveTextContent('No photos added');
    const price = screen.getByRole('region', { name: 'Price' });
    expect(within(price).getByText('€45.50')).toBeInTheDocument();
    // The service fee is the one set in the control panel (€2.90 in the test catalogue).
    expect(within(price).getByText('Service fee').nextSibling).toHaveTextContent('€2.90');
    expect(within(price).getByText('Total').nextSibling).toHaveTextContent('€48.40');
    expect(screen.queryByText(/package discount/)).not.toBeInTheDocument();
    expect(screen.getByText(/Your card is charged 24 hours after the job is done/)).toBeInTheDocument();
    expect(screen.getByText('Free cancellation up to 24 hours before the visit. After that you pay the full price.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book & pay €48.40' })).toBeInTheDocument();
  });

  it('says a package includes the 10% discount', async () => {
    setUp({}, true);
    await toReview('svc-mow,svc-hedge');
    expect(screen.getByText('Includes the 10% package discount')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your booking' })).toHaveTextContent('Medium · about 2 h 30 min');
  });

  it('lists the saved cards, Apple Pay and Google Pay, with the choice from last time selected', async () => {
    setUp({ cards: [visa, master], last: { choice: 'card', cardId: 'pm_mc' } });
    await toReview();
    const methods = screen.getByRole('group', { name: 'Payment' });
    expect(within(methods).getByRole('radio', { name: /Mastercard •••• 5555/ })).toBeChecked();
    expect(within(methods).getByRole('radio', { name: /Visa •••• 4242/ })).not.toBeChecked();
    expect(within(methods).getByRole('radio', { name: /Apple Pay/ })).toBeInTheDocument();
    expect(within(methods).getByRole('radio', { name: /Google Pay/ })).toBeInTheDocument();
  });

  it('selects Google Pay when it was used last time, and the newest card for a returning customer otherwise', async () => {
    setUp({ cards: [visa], last: { choice: 'google_pay', cardId: null } });
    await toReview();
    expect(screen.getByRole('radio', { name: /Google Pay/ })).toBeChecked();
  });

  it('falls back to the newest saved card when the card used last time is gone', async () => {
    setUp({ cards: [visa], last: { choice: 'card', cardId: 'pm_removed' } });
    await toReview();
    expect(screen.getByRole('radio', { name: /Visa •••• 4242/ })).toBeChecked();
  });

  it('reserves the money on the chosen saved card and opens the booking', async () => {
    const api = setUp({ cards: [visa, master], last: null });
    await toReview();
    await user().click(screen.getByRole('radio', { name: /Mastercard •••• 5555/ }));
    await user().click(screen.getByRole('button', { name: 'Book & pay €48.40' }));
    expect(await screen.findByText(/Finding your pro/)).toBeInTheDocument();
    expect(api.bodies['POST /bookings']).toMatchObject({ serviceIds: ['svc-mow'], paymentMethod: { type: 'card', cardId: 'pm_mc' } });
  });

  it('sends Apple Pay as the way to pay', async () => {
    const api = setUp({ cards: [visa] });
    await toReview();
    await user().click(screen.getByRole('radio', { name: /Apple Pay/ }));
    await user().click(screen.getByRole('button', { name: 'Book & pay €48.40' }));
    expect(await screen.findByText(/Finding your pro/)).toBeInTheDocument();
    expect(api.bodies['POST /bookings']).toMatchObject({ paymentMethod: { type: 'apple_pay' } });
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
    minTermMonths: 3,
    pauseNoticeDays: 7,
    maxPauseWeeks: 4,
    proSharePct: 70,
    status: 'published',
    publishedAt: '',
    updatedAt: '',
  };
  // The customer plan pages (Plans, Plan builder, My plan) are tested in pages/customer/Plans.test.tsx (D90).

  it('shows the pro a request to move a visit, to accept or decline (D77)', async () => {
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
    api.on('GET /pro/visits', { body: { visits: [] } });
    api.on('GET /pro/plans', { body: { plans: [] } });
    const request = (id: string) => ({
      id,
      visitId: `visit-${id}`,
      subscriptionId: 'sub-1',
      planName: 'Lawn care',
      customerName: 'Sara',
      address: '12 Linden Street',
      postcode: '10115',
      fromStartsAt: '2026-11-24T09:00:00.000Z',
      fromEndsAt: '2026-11-24T10:00:00.000Z',
      toStartsAt: '2026-11-26T09:00:00.000Z',
      toEndsAt: '2026-11-26T10:00:00.000Z',
      respondBy: '2026-11-23T09:00:00.000Z',
    });
    api.on('GET /pro/visit-moves', { body: { moves: [request('m1'), request('m2')] } });
    api.on('POST /pro/visit-moves/m1/accept', { body: { moves: [request('m2')] } });
    api.on('POST /pro/visit-moves/m2/decline', { body: { moves: [] } });
    renderAt('/pro');

    const section = await screen.findByRole('region', { name: 'Requests to move a visit' });
    const cards = within(section).getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAccessibleName('Sara asks to move Lawn care from Tue 24 Nov, 10:00 to Thu 26 Nov, 10:00');
    expect(cards[0]).toHaveTextContent('No answer counts as declined');
    await user().click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(within(section).getAllByRole('article')).toHaveLength(1));
    expect(api.calls).toContain('POST /pro/visit-moves/m1/accept');
    await user().click(within(section).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Requests to move a visit' })).not.toBeInTheDocument());
    expect(api.calls).toContain('POST /pro/visit-moves/m2/decline');
  });

  it('tells the pro when they are no longer free for a requested move', async () => {
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
    api.on('GET /pro/visits', { body: { visits: [] } });
    api.on('GET /pro/plans', { body: { plans: [] } });
    api.on('GET /pro/visit-moves', {
      body: {
        moves: [
          {
            id: 'm1',
            visitId: 'v1',
            subscriptionId: 'sub-1',
            planName: 'Lawn care',
            customerName: 'Sara',
            address: '12 Linden Street',
            postcode: '10115',
            fromStartsAt: '2026-11-24T09:00:00.000Z',
            fromEndsAt: '2026-11-24T10:00:00.000Z',
            toStartsAt: '2026-11-26T09:00:00.000Z',
            toEndsAt: '2026-11-26T10:00:00.000Z',
            respondBy: '2026-11-23T09:00:00.000Z',
          },
        ],
      },
    });
    api.on('POST /pro/visit-moves/m1/accept', { status: 409, body: { error: 'pro_not_free' } });
    renderAt('/pro');
    const section = await screen.findByRole('region', { name: 'Requests to move a visit' });
    await user().click(within(section).getByRole('button', { name: 'Accept' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('You are no longer free at the new time');
    expect(within(section).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(within(section).getByRole('button', { name: 'Decline' })).toBeEnabled();
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
      // Now, so it is on today's list on any clock.
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
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
    api.on('GET /pro/earnings', { body: { earnings: { sentCents: 0, pendingCents: 0, last30Cents: 0 } } });
    // The plans list is on My week since D86.
    renderAt('/pro/week');

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
    // Added after the design: every customer and pro in one place (D65).
    ['Users', '/admin/users'],
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
    expect(await screen.findByRole('heading', { level: 2, name: 'Service area' })).toBeInTheDocument();
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
        minTermMonths: 3,
        pauseNoticeDays: 7,
        maxPauseWeeks: 4,
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

  it('shows Save draft styled exactly like Publish plan', async () => {
    openNewPlan();
    const draft = await screen.findByRole('button', { name: 'Save draft' });
    const publish = screen.getByRole('button', { name: 'Publish plan' });
    expect(draft).toHaveClass('abtn', 'big');
    expect(draft.className).toBe(publish.className);
  });

  it('offers no delete for a plan that was never saved', async () => {
    openNewPlan();
    await screen.findByLabelText('Plan name');
    expect(screen.queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
  });

  function openPlansList(plans: object[]) {
    const api = fakeApi(users.admin);
    let current = plans;
    api.on('GET /admin/plans', () => ({ body: { plans: current } }));
    return { api, remove: (id: string) => (current = current.filter((plan) => (plan as { id: string }).id !== id)) };
  }
  const listed = (id: string, name: string, subscribers: number, status = 'draft') =>
    savedPlan({ id, name, categoryId: 'cat-garden', priceCents: 4900, frequency: 'weekly', tasks: ['Mow'], subscribers }, status);

  it('deletes a plan straight from the plans list after asking', async () => {
    const { api, remove } = openPlansList([listed('p1', 'Lawn care', 0, 'published'), listed('p2', 'Hedge care', 0)]);
    api.on('DELETE /admin/plans/p2', () => {
      remove('p2');
      return { status: 204 };
    });
    renderAt('/admin/plans');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toContain('Subscribers');
    expect(within(table).getByRole('link', { name: 'Edit Hedge care' })).toHaveAttribute('href', '/admin/plans/p2');

    await user().click(within(table).getByRole('button', { name: 'Delete Hedge care' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Hedge care"?' });
    await user().click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.calls).not.toContain('DELETE /admin/plans/p2');

    await user().click(within(table).getByRole('button', { name: 'Delete Hedge care' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('status')).toHaveTextContent('"Hedge care" was deleted.');
    await waitFor(() => expect(screen.queryByText('Hedge care', { selector: 'a' })).not.toBeInTheDocument());
    expect(screen.getByText('Lawn care', { selector: 'a' })).toBeInTheDocument();
  });

  it('does not delete a plan in use, says why with the number of subscribers, and offers to unpublish it (D66)', async () => {
    const { api } = openPlansList([listed('p1', 'Lawn care', 12, 'published')]);
    api.on('POST /admin/plans/p1/status', { body: { plan: listed('p1', 'Lawn care', 12, 'draft') } });
    renderAt('/admin/plans');
    await user().click(await screen.findByRole('button', { name: 'Delete Lawn care' }));
    const dialog = screen.getByRole('alertdialog', { name: '"Lawn care" can\x27t be deleted' });
    expect(dialog).toHaveTextContent("This plan has 12 active subscribers and can't be deleted. Unpublish it to stop new sign-ups");
    expect(within(dialog).queryByRole('button', { name: 'Delete plan' })).not.toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(api.bodies['POST /admin/plans/p1/status']).toEqual({ published: false }));
    expect(api.calls).not.toContain('DELETE /admin/plans/p1');
    expect(screen.getByText('Lawn care', { selector: 'a' })).toBeInTheDocument();
  });

  it('does not delete a plan while one of its visits is happening', async () => {
    const { api } = openPlansList([{ ...listed('p1', 'Hedge care', 0, 'draft'), visitInProgress: true }]);
    renderAt('/admin/plans');
    await user().click(await screen.findByRole('button', { name: 'Delete Hedge care' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('A visit of this plan is happening right now');
    // A draft is already hidden from customers: nothing to unpublish.
    expect(within(dialog).queryByRole('button', { name: 'Unpublish' })).not.toBeInTheDocument();
    await user().click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.calls).not.toContain('DELETE /admin/plans/p1');
  });

  async function fillComplete() {
    await user().type(await screen.findByLabelText('Plan name'), 'Lawn care');
    await user().selectOptions(screen.getByLabelText('Category'), 'Gardening');
    await user().type(screen.getByLabelText('Monthly price (€)'), '49');
    await user().type(screen.getByRole('textbox', { name: 'Add a task' }), 'Mow{Enter}');
  }

  it('sets name, category, monthly price, how often, visit length in minutes, minimum term and pause rules (D77)', async () => {
    const api = openNewPlan();
    await fillComplete();
    expect(screen.getByText('Medium size. Small −15%, large +35%.')).toBeInTheDocument();
    await user().selectOptions(screen.getByLabelText('How often'), '2× a week');
    expect(screen.getByText('≈ 8.7 visits a month')).toBeInTheDocument();
    await user().clear(screen.getByLabelText('Visit length (minutes)'));
    await user().type(screen.getByLabelText('Visit length (minutes)'), '90');
    expect(screen.queryByLabelText(/Skips/)).not.toBeInTheDocument();

    const term = screen.getByRole('combobox', { name: 'Minimum term' });
    expect(within(term).getAllByRole('option').map((o) => o.textContent)).toEqual(['1 month', '3 months', '6 months', '12 months']);
    expect(term).toHaveValue('3');
    await user().selectOptions(term, '6 months');

    const notice = screen.getByRole('combobox', { name: 'Minimum notice to pause a plan' });
    expect(notice).toHaveValue('7');
    const weeks = screen.getByRole('combobox', { name: 'Maximum pause duration per year' });
    expect(weeks).toHaveValue('4');
    await user().selectOptions(notice, '14 days');
    await user().selectOptions(weeks, '2 weeks');

    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(api.bodies['POST /admin/plans']).toMatchObject({
        name: 'Lawn care',
        categoryId: 'cat-garden',
        priceCents: 4900,
        frequency: 'twice_weekly',
        visitMinutes: 90,
        minTermMonths: 6,
        pauseNoticeDays: 14,
        maxPauseWeeks: 2,
        tasks: ['Mow'],
      }),
    );
    expect(api.bodies['POST /admin/plans']).not.toHaveProperty('skipsPerMonth');
  });

  it('groups the pause rules: maximum per year first, then the notice, both as selects with their help (D85)', async () => {
    const api = openNewPlan();
    await fillComplete();
    const group = screen.getByRole('group', { name: 'Pause rules' });
    const weeks = within(group).getByRole('combobox', { name: 'Maximum pause duration per year' });
    const notice = within(group).getByRole('combobox', { name: 'Minimum notice to pause a plan' });
    // The maximum comes above the notice.
    expect(weeks.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group).getAllByRole('combobox')).toEqual([weeks, notice]);

    const weekOptions = within(weeks).getAllByRole('option');
    expect(weekOptions.map((o) => o.textContent)).toEqual([
      '0 weeks – Pauses not allowed',
      '1 week',
      '2 weeks',
      '3 weeks',
      '4 weeks',
      '5 weeks',
      '6 weeks',
      '7 weeks',
      '8 weeks',
    ]);
    const dayOptions = within(notice).getAllByRole('option');
    expect(dayOptions).toHaveLength(31);
    expect(dayOptions[0]).toHaveTextContent('0 days');
    expect(dayOptions[1]).toHaveTextContent('1 day');
    expect(dayOptions[2]).toHaveTextContent('2 days');
    expect(dayOptions[30]).toHaveTextContent('30 days');
    // New plans start with 4 weeks and 7 days.
    expect(weeks).toHaveValue('4');
    expect(notice).toHaveValue('7');

    const weeksHelp = 'Select the total number of weeks customers can pause their plan each year. Choose 0 to disable pauses.';
    const noticeHelp = 'Customers must request a pause at least this many days before it starts.';
    expect(screen.getByText(weeksHelp)).toBeInTheDocument();
    expect(screen.getByText(noticeHelp)).toBeInTheDocument();
    expect(weeks).toHaveAccessibleDescription(weeksHelp);
    expect(notice).toHaveAccessibleDescription(noticeHelp);

    await user().selectOptions(notice, '0 days');
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.bodies['POST /admin/plans']).toMatchObject({ pauseNoticeDays: 0, maxPauseWeeks: 4 }));
  });

  it('removes the notice setting while 0 weeks are chosen, and brings it back with its value', async () => {
    const api = openNewPlan();
    await fillComplete();
    const weeks = screen.getByRole('combobox', { name: 'Maximum pause duration per year' });
    await user().selectOptions(screen.getByRole('combobox', { name: 'Minimum notice to pause a plan' }), '21 days');
    await user().selectOptions(weeks, '0 weeks – Pauses not allowed');
    expect(weeks).toHaveValue('0');
    expect(screen.queryByRole('combobox', { name: 'Minimum notice to pause a plan' })).not.toBeInTheDocument();
    expect(screen.queryByText('Customers must request a pause at least this many days before it starts.')).not.toBeInTheDocument();
    const preview = screen.getByRole('complementary', { name: 'Live preview · customer app' });
    expect(within(preview).getByText("Min. 3 months, then 30 days' notice · Pauses not allowed")).toBeInTheDocument();

    await user().selectOptions(weeks, '3 weeks');
    expect(screen.getByRole('combobox', { name: 'Minimum notice to pause a plan' })).toHaveValue('21');
    await user().selectOptions(weeks, '0 weeks – Pauses not allowed');
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.bodies['POST /admin/plans']).toMatchObject({ maxPauseWeeks: 0, pauseNoticeDays: 21 }));
  });

  it('leaves an emptied number field empty and explains the limits before saving', async () => {
    const api = openNewPlan();
    await fillComplete();
    const length = screen.getByLabelText('Visit length (minutes)');
    await user().clear(length);
    expect(length).toHaveValue('');
    expect(length).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a visit length, for example 60 minutes')).toBeInTheDocument();
    // Publish stays clickable (D42): it points at the field to fix and sends nothing.
    await user().click(screen.getByRole('button', { name: 'Publish plan' }));
    expect(length).toHaveFocus();
    expect(api.calls).not.toContain('POST /admin/plans');
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    expect(api.calls).not.toContain('POST /admin/plans');
    expect(length).toHaveFocus();

    await user().type(length, '50');
    expect(screen.getByText('Visit length must be in steps of 15 minutes, for example 30, 45 or 60')).toBeInTheDocument();
    await user().clear(length);
    await user().type(length, '45');
    expect(length).toHaveValue('45');
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
    expect(within(preview).getByText("Min. 3 months, then 30 days' notice · Pause up to 4 weeks a year, 7 days' notice")).toBeInTheDocument();
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
    // A new plan opens again under its own address after the first save; check the confirmation that stays.
    await waitFor(() => expect(screen.getByText('Draft saved')).toBeInTheDocument());
    expect(api.bodies['POST /admin/plans']).toMatchObject({ name: 'Half done', categoryId: null, priceCents: null, tasks: [] });
  });

  it('says under each field what is missing when publishing an incomplete plan, and moves the cursor there', async () => {
    const api = openNewPlan();
    const publish = await screen.findByRole('button', { name: 'Publish plan' });
    expect(publish).toBeEnabled();
    expect(screen.getByText(/To publish, add: a plan name, a category, a monthly price of at least €5, at least one task/)).toBeInTheDocument();
    expect(screen.getByLabelText('Plan name')).not.toHaveAttribute('aria-invalid');

    await user().click(publish);
    expect(api.calls).not.toContain('POST /admin/plans');
    expect(screen.getByRole('alert')).toHaveTextContent('4 fields need fixing before the plan can be published.');
    const name = screen.getByLabelText('Plan name');
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Enter a name for the plan, for example "Weekly lawn care".');
    expect(screen.getByLabelText('Category')).toHaveAccessibleDescription('Choose the category the plan belongs to.');
    expect(screen.getByLabelText('Monthly price (€)')).toHaveAccessibleDescription('Enter a monthly price of at least €5, such as 49.');
    expect(screen.getByText('Add at least one task the pro does on each visit.')).toBeInTheDocument();

    // Fixing a field clears its message straight away; the rest stay until fixed.
    await user().type(name, 'Lawn care');
    expect(name).not.toHaveAttribute('aria-invalid');
    await user().type(screen.getByLabelText('Monthly price (€)'), '3');
    expect(screen.getByLabelText('Monthly price (€)')).toHaveAccessibleDescription('Enter an amount of at least €5, such as 49 or 49.50.');
    await user().click(publish);
    expect(screen.getByLabelText('Category')).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('3 fields need fixing');

    await user().selectOptions(screen.getByLabelText('Category'), 'Gardening');
    await user().clear(screen.getByLabelText('Monthly price (€)'));
    await user().type(screen.getByLabelText('Monthly price (€)'), '49');
    await user().type(screen.getByLabelText('Add a task'), 'Mow{Enter}');
    expect(screen.queryByText(/need fixing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/To publish, add/)).not.toBeInTheDocument();
  });

  it('says exactly what is wrong with the visit length, under the field, and refuses to publish until it is fixed (D62)', async () => {
    const api = openNewPlan();
    await fillComplete();
    const visit = screen.getByLabelText('Visit length (minutes)');
    const typeVisit = async (value: string) => {
      await user().clear(visit);
      if (value) await user().type(visit, value);
    };

    await typeVisit('10');
    expect(visit).toHaveAccessibleDescription('Visit length must be at least 15 minutes');
    expect(visit.nextElementSibling).toHaveTextContent('Visit length must be at least 15 minutes');
    await typeVisit('50');
    expect(visit).toHaveAccessibleDescription('Visit length must be in steps of 15 minutes, for example 30, 45 or 60');
    await typeVisit('700');
    expect(visit).toHaveAccessibleDescription('Visit length can be at most 600 minutes');

    await user().click(screen.getByRole('button', { name: 'Publish plan' }));
    expect(api.calls).not.toContain('POST /admin/plans');
    expect(api.calls.some((c) => c.endsWith('/status'))).toBe(false);
    expect(visit).toHaveFocus();

    // Valid again: the message goes at once.
    await typeVisit('45');
    expect(visit).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/Visit length (must|can)/)).not.toBeInTheDocument();
  });

  it('confirms a saved draft with only "Draft saved" and one button to close it (D62)', async () => {
    const api = openNewPlan();
    await user().type(await screen.findByLabelText('Plan name'), 'Lawn care');
    await user().click(screen.getByRole('button', { name: 'Save draft' }));
    // A new plan opens again under its own address after the first save; the confirmation comes along.
    await waitFor(() => expect(api.calls).toContain('GET /admin/plans/p1'));
    await screen.findByDisplayValue('Lawn care');
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/^Draft saved$/);
    expect(within(note).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stay/ })).not.toBeInTheDocument();
    await user().click(within(note).getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument();
  });

  it('explains a missing price for the extra and a bad number of minutes', async () => {
    openNewPlan();
    await user().type(await screen.findByLabelText('Optional extra'), 'Hedge trimming');
    const visit = screen.getByLabelText('Visit length (minutes)');
    await user().clear(visit);
    await user().type(visit, '20');
    await user().click(screen.getByRole('button', { name: 'Publish plan' }));
    expect(screen.getByLabelText('Extra price (€ / month)')).toHaveAccessibleDescription('Enter a monthly price for the extra, or clear its name.');
    expect(visit).toHaveAccessibleDescription('Visit length must be in steps of 15 minutes, for example 30, 45 or 60');
  });

  it('publishes a complete plan', async () => {
    const api = openNewPlan();
    const live = savedPlan({ name: 'Lawn care', categoryId: 'cat-garden', priceCents: 4900, tasks: ['Mow'] }, 'published');
    let published = false;
    api.on('POST /admin/plans/p1/status', () => {
      published = true;
      return { body: { plan: live } };
    });
    // Like the API: once published, the plan loads as published. The new plan opens under its own address
    // after publishing, so the editor loads it again (D70a).
    api.on('GET /admin/plans/p1', () => ({ body: { plan: published ? live : savedPlan({}) } }));
    await fillComplete();
    await user().click(screen.getByRole('button', { name: 'Publish plan' }));
    // The editor opens the new plan under its own address and loads it again, which replaces the heading;
    // so the heading is looked up afresh each time instead of keeping an element that may be gone.
    await waitFor(() => expect(api.calls).toContain('GET /admin/plans/p1'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Plan published' })).toBeInTheDocument());
    expect(api.bodies['POST /admin/plans/p1/status']).toEqual({ published: true });
    expect(api.calls.indexOf('POST /admin/plans/p1/status')).toBeLessThan(api.calls.indexOf('GET /admin/plans/p1'));
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
    // A new plan opens again under its own address after the first save; check the confirmation that stays.
    await waitFor(() => expect(screen.getByText('Draft saved')).toBeInTheDocument());
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

  it('has a Back button at the top of a plan', async () => {
    openExistingPlan();
    expect(await screen.findByRole('button', { name: 'Back' })).toBeVisible();
  });

  it('goes back to the Plans list when the plan was opened directly', async () => {
    openExistingPlan();
    await user().click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();
  });

  it('asks before leaving with the Back button when there are unsaved changes', async () => {
    openNewPlan();
    await user().type(await screen.findByLabelText('Plan name'), 'Unsaved');
    await user().click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
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
    expect(await screen.findByRole('alert')).toHaveTextContent('waiting for approval by an admin');
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

  it('offers no way to change the email or password of a colleague (D51)', async () => {
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
    renderAt('/admin/settings/team');
    const row = (await screen.findByText('elion', { selector: '.b' })).closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /password/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set new password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change email' })).not.toBeInTheDocument();
  });
});

describe('rescheduling and payment status (D75)', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'b-row',
    status: 'completed' as const,
    serviceName: 'Lawn mowing',
    categoryId: 'cat-garden',
    startsAt: '2026-10-30T09:00:00.000Z',
    totalCents: 4840,
    proName: 'Daniel',
    canRate: false,
    ...overrides,
  });
  const slot = (startsAt: string, available = true) => ({
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3600_000).toISOString(),
    freePros: 2,
    available,
  });

  it('offers Reschedule on every upcoming booking', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', {
      body: {
        bookings: [
          row({ id: 'b-a', status: 'accepted', serviceName: 'Hedge trimming', canReschedule: true }),
          row({ id: 'b-b', status: 'searching', proName: null, canReschedule: false }),
        ],
      },
    });
    renderAt('/bookings');
    const links = await screen.findAllByRole('link', { name: 'Reschedule' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/bookings/b-a/reschedule', '/bookings/b-b/reschedule']);
  });

  it('moves a booking: pick a day and a time, then it opens the booking', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking() } });
    api.on('GET /availability', {
      body: { slots: [slot('2026-11-06T09:00:00.000Z'), slot('2026-11-06T11:00:00.000Z'), slot('2026-11-06T13:00:00.000Z', false), slot('2026-11-07T09:00:00.000Z')] },
    });
    api.on('POST /bookings/b1/reschedule', { body: { booking: booking({ startsAt: '2026-11-07T09:00:00.000Z' }) } });
    renderAt('/bookings/b1/reschedule');
    expect(await screen.findByText('Now booked for Fri 6 Nov, 10:00')).toBeInTheDocument();
    expect(await screen.findByText(/move your booking for free up to 24 hours before it starts/)).toBeInTheDocument();
    // The current time cannot be chosen again, and a full time is off.
    expect(screen.getByRole('button', { name: /10:00\s*Your time/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /14:00\s*Full/ })).toBeDisabled();
    const move = screen.getByRole('button', { name: 'Choose a new time' });
    expect(move).toBeDisabled();
    await user().click(screen.getByRole('button', { name: /12:00/ }));
    await user().click(screen.getByRole('button', { name: /^Sat\s*7/ }));
    expect(screen.getByRole('button', { name: 'Choose a new time' })).toBeDisabled();
    await user().click(screen.getByRole('button', { name: /10:00/ }));
    await user().click(screen.getByRole('button', { name: 'Move to Sat 7 Nov, 10:00' }));
    await waitFor(() => expect(api.bodies['POST /bookings/b1/reschedule']).toEqual({ startsAt: '2026-11-07T09:00:00.000Z' }));
    expect(await screen.findByRole('heading', { name: 'Your booking' })).toBeInTheDocument();
    await waitFor(() => expect(api.calls.filter((c) => c === 'GET /bookings/b1').length).toBeGreaterThan(1));
  });

  it('explains when the booking can no longer be moved', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ canReschedule: false }) } });
    renderAt('/bookings/b1/reschedule');
    expect(await screen.findByText(/starts in less than 24 hours, or is already under way/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the booking' })).toHaveAttribute('href', '/bookings/b1');
    expect(api.calls).not.toContain('GET /availability');
  });

  it('shows the error when the time was just taken', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking() } });
    api.on('GET /availability', { body: { slots: [slot('2026-11-06T11:00:00.000Z')] } });
    api.on('POST /bookings/b1/reschedule', { status: 409, body: { error: 'slot_unavailable' } });
    renderAt('/bookings/b1/reschedule');
    await user().click(await screen.findByRole('button', { name: /12:00/ }));
    await user().click(screen.getByRole('button', { name: 'Move to Fri 6 Nov, 12:00' }));
    expect(await screen.findByText('That time was just taken. Please choose another.')).toBeInTheDocument();
  });

  it('shows what happened to the money on each past booking', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', {
      body: {
        bookings: [
          row({ id: 'p1', serviceName: 'Job charging', paymentStatus: 'held' }),
          row({ id: 'p2', serviceName: 'Job hold', paymentStatus: 'held', problemOpen: true }),
          row({ id: 'p3', serviceName: 'Job paid', paymentStatus: 'captured' }),
          row({ id: 'p4', serviceName: 'Job refunded', paymentStatus: 'refunded' }),
          row({ id: 'p5', serviceName: 'Job cancelled', status: 'cancelled', paymentStatus: 'released' }),
        ],
      },
    });
    renderAt('/bookings?tab=past');
    const badgeOf = async (service: string) => {
      const item = (await screen.findByText(service)).closest('li');
      if (!item) throw new Error('No row');
      return item.querySelector('.badge')?.textContent;
    };
    expect(await badgeOf('Job charging')).toBe('Charging in 24 hours');
    expect(await badgeOf('Job hold')).toBe('On hold');
    expect(await badgeOf('Job paid')).toBe('Paid');
    expect(await badgeOf('Job refunded')).toBe('Refunded');
    expect(await badgeOf('Job cancelled')).toBe('Cancelled');
  });
});

describe('booking pages (D83)', () => {
  const pro = { id: 'u-pro', firstName: 'Daniel', ratingAverage: 4.9, ratingCount: 12, photoId: 'ph-pro', jobsDone: 212, isFavourite: false };
  const photoOf = (id: string) => document.querySelector(`img[src="http://api.test/files/${id}"]`);
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const arrival = (overrides: Record<string, unknown> = {}) => ({
    expectedAt: '2026-11-06T09:42:00.000Z',
    lateMinutes: 0,
    source: 'live' as const,
    proPosition: { lat: 52.52, lng: 13.39, at: minutesAgo(1) },
    destination: { lat: 52.5323, lng: 13.3846 },
    ...overrides,
  });

  it("shows the pro's photo and number of jobs on the booking and in the chat", async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ pro }) } });
    api.on('GET /bookings/b1/messages', { body: { messages: [], canWrite: true } });
    const { unmount } = renderAt('/bookings/b1');
    const card = await screen.findByRole('region', { name: 'Your pro' });
    expect(within(card).getByText(/212 jobs/)).toBeInTheDocument();
    expect(within(card).getByText(/Verified/)).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /4\.9/ })).toBeInTheDocument();
    expect(photoOf('ph-pro')).toBeInTheDocument();
    unmount();

    renderAt('/bookings/b1/chat');
    await screen.findByRole('log', { name: 'Conversation with Daniel' });
    expect(screen.getByText(/212 jobs/)).toBeInTheDocument();
    expect(photoOf('ph-pro')).toBeInTheDocument();
  });

  it('shows the photo and jobs above the rating form, and the initial without a photo', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, canRate: true, pro }) } });
    const { unmount } = renderAt('/bookings/b1/rate');
    expect(await screen.findByRole('heading', { name: 'How was Daniel?' })).toBeInTheDocument();
    expect(screen.getByText('212 jobs')).toBeInTheDocument();
    expect(screen.getByText(/Lawn mowing · /)).toBeInTheDocument();
    expect(photoOf('ph-pro')).toBeInTheDocument();
    unmount();

    api.on('GET /bookings/b1', {
      body: { booking: booking({ status: 'completed', canCancel: false, canRate: true, pro: { ...pro, photoId: null, jobsDone: 1 } }) },
    });
    renderAt('/bookings/b1/rate');
    expect(await screen.findByText('1 job')).toBeInTheDocument();
    expect(photoOf('ph-pro')).not.toBeInTheDocument();
  });

  it('shows a real map with the pro and the expected arrival while the pro is on the way', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'on_the_way', pro, arrival: arrival() }) } });
    renderAt('/bookings/b1');
    expect(
      await screen.findByRole('img', { name: /^Map: Daniel is about 1\.\d km from your home at 12 Linden Street, 10115\.$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Expected around 10:42')).toBeInTheDocument();
    expect(screen.getByText('updated 1 min ago')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeInTheDocument();
    expect(document.querySelector('img.live-tile')?.getAttribute('src')).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    expect(screen.queryByText(/running about/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel for free' })).not.toBeInTheDocument();
  });

  it('keeps the drawing before the pro sets off, and the booked time without a recent position', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ pro, arrival: arrival({ source: 'booked', proPosition: undefined }) }) } });
    const { unmount } = renderAt('/bookings/b1');
    await screen.findByRole('region', { name: 'Your pro' });
    expect(screen.queryByRole('img', { name: /^Map/ })).not.toBeInTheDocument();
    unmount();

    api.on('GET /bookings/b1', {
      body: {
        booking: booking({
          status: 'on_the_way',
          pro,
          arrival: arrival({ source: 'booked', proPosition: undefined, expectedAt: '2026-11-06T09:00:00.000Z' }),
        }),
      },
    });
    renderAt('/bookings/b1');
    expect(
      await screen.findByRole('img', { name: "Map of your home at 12 Linden Street, 10115. Daniel's position is not known yet." }),
    ).toBeInTheDocument();
    expect(screen.getByText('Expected around 10:00')).toBeInTheDocument();
    expect(screen.getByText("Daniel's location is not shared yet, so this is the booked time.")).toBeInTheDocument();
  });

  it('says in red when the pro will be more than 10 minutes late, with the new time', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: { booking: booking({ status: 'on_the_way', pro, arrival: arrival({ lateMinutes: 15, expectedAt: '2026-11-06T09:57:00.000Z' }) }) },
    });
    renderAt('/bookings/b1');
    const late = await screen.findByText('Your pro is running about 15 minutes late. New arrival around 10:57.');
    expect(late.closest('.info')).toHaveClass('red');
    expect(screen.queryByRole('button', { name: 'Cancel for free' })).not.toBeInTheDocument();
  });

  it('offers to cancel for free when the pro is more than 30 minutes late, after asking', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: {
        booking: booking({
          status: 'on_the_way',
          pro,
          arrival: arrival({ lateMinutes: 35, expectedAt: '2026-11-06T09:35:00.000Z' }),
          freeCancelProLate: true,
          lateCancelCents: null,
        }),
      },
    });
    api.on('POST /bookings/b1/cancel', { body: { booking: booking({ status: 'cancelled', canCancel: false, paymentStatus: 'released' }) } });
    renderAt('/bookings/b1');
    expect(await screen.findByText(/running about 35 minutes late/)).toBeInTheDocument();
    // The usual cancel link gives way to the free one.
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Cancel for free' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Daniel is more than 30 minutes late, so cancelling is free');
    expect(api.calls).not.toContain('POST /bookings/b1/cancel');
    await user().click(screen.getByRole('button', { name: 'Yes, cancel for free' }));
    expect(await screen.findByText('Nothing was charged; the hold was released.')).toBeInTheDocument();
    expect(api.calls).toContain('POST /bookings/b1/cancel');
    expect(api.bodies['POST /bookings/b1/cancel']).toBeUndefined();
  });

  it("opens the pro's photos full screen from the booking", async () => {
    const api = fakeApi(users.customer);
    const photos = [
      { id: 'c1', kind: 'completion' as const },
      { id: 'c2', kind: 'completion' as const },
    ];
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, photos }) } });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Open photo 2 of 2' }));
    expect(screen.getByRole('dialog', { name: 'Photo 2 of 2' })).toBeInTheDocument();
    await user().keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Photo 1 of 2' })).toBeInTheDocument();
    await user().keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('sends a photo in the chat and shows photos in the bubbles, full screen on a tap', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'working', pro }) } });
    const fromPro = { id: '1', from: 'pro', body: null, photoId: 'cp-pro', createdAt: '2026-11-06T09:21:00.000Z', readAt: null };
    api.on('GET /bookings/b1/messages', { body: { messages: [fromPro], canWrite: true } });
    api.on('POST /bookings/b1/messages/photo', {
      status: 201,
      body: { message: { id: '2', from: 'customer', body: null, photoId: 'cp-me', createdAt: '2026-11-06T09:22:00.000Z', readAt: null } },
    });
    renderAt('/bookings/b1/chat');
    const log = await screen.findByRole('log', { name: 'Conversation with Daniel' });
    expect(await within(log).findByRole('img', { name: 'Photo from Daniel' })).toHaveAttribute('src', 'http://api.test/files/cp-pro');

    await user().upload(screen.getByLabelText('Send a photo'), new File(['x'], 'gate.jpg', { type: 'image/jpeg' }));
    expect(await within(log).findByRole('img', { name: 'Your photo' })).toHaveAttribute('src', 'http://api.test/files/cp-me');
    expect(api.calls).toContain('POST /bookings/b1/messages/photo');
    expect(api.bodies['POST /bookings/b1/messages/photo']).toBeInstanceOf(FormData);

    await user().click(within(log).getAllByRole('button', { name: 'Open the photo' })[1] as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'Photo 2 of 2' })).toBeInTheDocument();
  });

  it('refuses a chat photo over 8 MB before sending it', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'working', pro }) } });
    api.on('GET /bookings/b1/messages', { body: { messages: [], canWrite: true } });
    renderAt('/bookings/b1/chat');
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    await user().upload(await screen.findByLabelText('Send a photo'), big);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /bookings/b1/messages/photo');
  });

  it('opens the chat from a chat message in Messages, for customers and pros', async () => {
    const chat = (id: string, link: string | null, body = 'MISK: Daniel about Lawn mowing: I am at the gate') => ({
      id,
      kind: 'chat_message',
      body,
      link,
      read: false,
      createdAt: '2026-11-11T09:00:00.000Z',
    });
    const api = fakeApi(users.customer);
    api.on('GET /inbox', { body: { messages: [chat('m1', '/bookings/b1/chat'), chat('m0', null, 'MISK: your booking is confirmed.')], unread: 2 } });
    api.on('POST /inbox/read', { status: 204 });
    const { unmount } = renderAt('/messages');
    expect(await screen.findByRole('link', { name: 'Daniel about Lawn mowing: I am at the gate' })).toHaveAttribute('href', '/bookings/b1/chat');
    expect(screen.queryByRole('link', { name: 'Your booking is confirmed.' })).not.toBeInTheDocument();
    unmount();

    const proApi = fakeApi(users.pro);
    proApi.on('GET /pro/offers', { body: { offers: [] } });
    proApi.on('GET /pro/jobs', { body: { jobs: [] } });
    proApi.on('GET /pro/profile', { body: { profile: { status: 'approved', payoutsEnabled: true } } });
    proApi.on('GET /inbox', { body: { messages: [chat('m1', '/pro/jobs/b1/chat')], unread: 1 } });
    proApi.on('POST /inbox/read', { status: 204 });
    renderAt('/pro/messages');
    expect(await screen.findByRole('link', { name: 'Daniel about Lawn mowing: I am at the gate' })).toHaveAttribute('href', '/pro/jobs/b1/chat');
  });

  it('shows how long extra work takes, and the answer as "Declined"', async () => {
    const api = fakeApi(users.customer);
    const extra = { id: 'x1', description: 'Trim the front hedge', priceCents: 2000, durationMinutes: 30, status: 'pending' as const, createdAt: '' };
    const old = { id: 'x0', description: 'Water the pots', priceCents: 500, durationMinutes: null, status: 'approved' as const, createdAt: '' };
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'working', extras: [old, extra] }) } });
    api.on('POST /bookings/b1/extras/x1/decline', { body: { booking: booking({ status: 'working', extras: [old, { ...extra, status: 'declined' }] }) } });
    renderAt('/bookings/b1');
    expect(await screen.findByText('About 30 min')).toBeInTheDocument();
    // An older request without a duration shows none.
    expect(screen.getAllByText(/^About /)).toHaveLength(1);
    expect(screen.getByText('Approved by you')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Declined')).toBeInTheDocument();
  });

  // Extra work from the MISK price list (D86) is covered in pages/pro/ProJobs.test.tsx.

  it("shares the pro's location while on the way, at most every 20 seconds, and explains a refusal", async () => {
    let onPosition: ((position: GeolocationPosition) => void) | null = null;
    let onError: ((error: GeolocationPositionError) => void) | null = null;
    const clearWatch = vi.fn();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (success: (position: GeolocationPosition) => void, failure: (error: GeolocationPositionError) => void) => {
          onPosition = success;
          onError = failure;
          return 7;
        },
        clearWatch,
      },
    });
    const at = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng, accuracy: 12 }, timestamp: Date.now() }) as GeolocationPosition;
    try {
      const api = fakeApi(users.pro);
      const job = { ...booking({ status: 'on_the_way' }), customer: { firstName: 'Sara' }, earningsCents: 3731 };
      api.on('GET /pro/jobs/b1', { body: { job } });
      api.on('POST /pro/jobs/b1/location', { status: 204 });
      const { unmount } = renderAt('/pro/jobs/b1');
      expect(await screen.findByText('Sharing your location')).toBeInTheDocument();
      expect(screen.getByText('Allow location so Sara sees when you will arrive.')).toBeInTheDocument();
      await waitFor(() => expect(onPosition).not.toBeNull());
      act(() => onPosition?.(at(52.52, 13.39)));
      await waitFor(() => expect(api.bodies['POST /pro/jobs/b1/location']).toEqual({ lat: 52.52, lng: 13.39, accuracy: 12 }));
      expect(await screen.findByText(/Sara sees where you are on a map/)).toBeInTheDocument();
      await screen.findByText(/Location shared at/);
      // A new position moments later waits for the next 20 seconds.
      act(() => onPosition?.(at(52.521, 13.391)));
      expect(api.calls.filter((c) => c === 'POST /pro/jobs/b1/location')).toHaveLength(1);

      act(() => onError?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'denied' } as GeolocationPositionError));
      expect(await screen.findByText(/Location is off for MISK, so Sara sees the booked time instead/)).toBeInTheDocument();
      unmount();
      expect(clearWatch).toHaveBeenCalledWith(7);
    } finally {
      Reflect.deleteProperty(navigator, 'geolocation');
    }
  });

  it('saves the pro as a favourite with the heart after the review, and removes them again', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: { booking: booking({ status: 'completed', canCancel: false, rating: { stars: 5, tags: [] }, pro }) },
    });
    api.on('PUT /favourites/pros/u-pro', { body: { favourite: true } });
    api.on('DELETE /favourites/pros/u-pro', { body: { favourite: false } });
    renderAt('/bookings/b1/rate');
    const heart = await screen.findByRole('button', { name: 'Save Daniel' });
    expect(heart).toHaveAttribute('aria-pressed', 'false');
    await user().click(heart);
    expect(await screen.findByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');
    expect(api.calls).toContain('PUT /favourites/pros/u-pro');
    await user().click(screen.getByRole('button', { name: 'Saved' }));
    expect(await screen.findByRole('button', { name: 'Save Daniel' })).toHaveAttribute('aria-pressed', 'false');
    expect(api.calls).toContain('DELETE /favourites/pros/u-pro');
  });

  it('shows the heart on the pro card of a finished booking', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, pro: { ...pro, isFavourite: true } }) } });
    renderAt('/bookings/b1');
    const card = await screen.findByRole('region', { name: 'Your pro' });
    expect(within(card).getByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says "Problem reported. Support will contact you" after a report', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', {
      body: { booking: booking({ status: 'completed', canCancel: false, problemReportedAt: '2026-11-06T12:00:00.000Z' }) },
    });
    renderAt('/bookings/b1');
    const title = await screen.findByText('Problem reported. Support will contact you');
    expect(title.closest('p')?.textContent?.startsWith('Problem reported. Support will contact you')).toBe(true);
    expect(title.closest('p')).toHaveTextContent('Problem reported. Support will contact you within 2 hours. The payment is on hold.');
  });

  it('keeps the report pop-up saying the payment is put on hold', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false, canReportProblem: true }) } });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Report' }));
    const sheet = screen.getByRole('dialog', { name: 'Report a problem' });
    expect(within(sheet).getByText(/^The payment is put on hold while we look into it/)).toBeInTheDocument();
  });

  it('shows the total and the payment method on the receipt, with Download PDF', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings/b1', { body: { booking: booking({ status: 'completed', canCancel: false }) } });
    api.on('GET /bookings/b1/receipt', {
      body: {
        receipt: {
          number: 'R-1001',
          bookingNumber: 'B-1001',
          date: '2026-11-06T10:00:00.000Z',
          serviceName: 'Lawn mowing',
          proName: 'Daniel',
          address: '12 Linden Street, 10115',
          lines: [
            { label: 'Lawn mowing, medium job', cents: 4550, kind: 'job' },
            { label: 'Service fee', cents: 290, kind: 'fee' },
          ],
          totalCents: 4840,
          state: 'paid',
          chargeAt: null,
          paymentMethod: { brand: 'visa', last4: '4242', wallet: 'apple_pay', label: 'Apple Pay · Visa •••• 4242' },
        },
      },
    });
    renderAt('/bookings/b1');
    await user().click(await screen.findByRole('button', { name: 'Receipt' }));
    const sheet = screen.getByRole('dialog', { name: 'Receipt' });
    expect(await within(sheet).findByText('Apple Pay · Visa •••• 4242')).toBeInTheDocument();
    expect(within(sheet).getByText('Payment method')).toBeInTheDocument();
    expect(within(sheet).getByText('€48.40')).toBeInTheDocument();
    const pdf = within(sheet).getByRole('link', { name: 'Download PDF' });
    expect(pdf).toHaveAttribute('href', 'http://api.test/bookings/b1/receipt.pdf');
    expect(pdf).toHaveAttribute('download');
  });

  it('lets a pro add, change and remove their profile photo', async () => {
    const api = fakeApi(users.pro);
    const profile: ProProfile = {
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
      photoId: null,
    };
    api.on('GET /pro/profile', { body: { profile } });
    api.on('GET /postcodes', { body: { postcodes: [] } });
    api.on('POST /pro/photo', { status: 201, body: { profile: { ...profile, photoId: 'me1' } } });
    api.on('DELETE /pro/photo', { body: { profile } });
    renderAt('/pro/profile');
    const section = await screen.findByRole('region', { name: 'Your photo' });
    expect(within(section).getByText(/No photo yet/)).toBeInTheDocument();
    await user().upload(within(section).getByLabelText('Add a photo'), new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    expect(await within(section).findByText('Change photo')).toBeInTheDocument();
    expect(photoOf('me1')).toBeInTheDocument();
    await user().click(within(section).getByRole('button', { name: 'Remove photo' }));
    expect(await within(section).findByText('Add a photo')).toBeInTheDocument();
    expect(api.calls).toEqual(expect.arrayContaining(['POST /pro/photo', 'DELETE /pro/photo']));
  });
});
