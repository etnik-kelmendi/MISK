import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { SupportContact } from './api/client';
import type { InboxMessage, User } from './api/types';
import { INBOX_REFRESH_MS } from './inbox/InboxContext';
import { fakeApi, renderAt, users } from './test/harness';

/** D87: the suspended screen, the phone number on the Account page, and team messages in the app. */

const user = () => userEvent.setup();

const suspendedAnswer = (message: string | null, support: SupportContact = { email: 'help@example.com', phone: '+493012345678' }) => ({
  status: 403,
  body: { error: 'account_suspended', message, support },
});

describe('a suspended account', () => {
  it('shows why instead of the app when the session belongs to a suspended account, and leads back to log in', async () => {
    const api = fakeApi(null);
    api.on('GET /auth/me', suspendedAnswer('Please call us about your last payment.'));
    api.on('POST /auth/logout', { status: 204 });
    renderAt('/bookings');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Your account is suspended' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Message from the MISK team')).toBeInTheDocument();
    expect(screen.getByText('Please call us about your last payment.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'help@example.com' })).toHaveAttribute('href', 'mailto:help@example.com');
    expect(screen.getByRole('link', { name: '+493012345678' })).toHaveAttribute('href', 'tel:+493012345678');
    expect(screen.queryByRole('navigation', { name: 'Main menu' })).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Back to log in' }));
    expect(await screen.findByRole('heading', { name: 'Log in to MISK' })).toBeInTheDocument();
    expect(api.calls).toContain('POST /auth/logout');
  });

  it('shows it after the right password, without a message or contact when there is none', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/login', suspendedAnswer(null, { email: null, phone: null }));
    renderAt('/signin');
    await user().type(await screen.findByLabelText('Email address'), 'anna@example.com');
    await user().type(screen.getByLabelText('Password'), 'garden42');
    await user().click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Your account is suspended' })).toBeInTheDocument();
    expect(screen.queryByText('Message from the MISK team')).not.toBeInTheDocument();
    expect(screen.getByText(/Reply to the email or text message we sent you/)).toBeInTheDocument();
  });

  it('replaces the app the moment a signed-in app finds out', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/');
    await screen.findByRole('navigation', { name: 'Main menu' });
    api.on('GET /inbox', suspendedAnswer('We need to talk.'));
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByRole('heading', { name: 'Your account is suspended' })).toBeInTheDocument();
    expect(screen.getByText('We need to talk.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main menu' })).not.toBeInTheDocument();
  });
});

describe('the phone number on the Account page', () => {
  const anna: User = { ...users.customer, id: 'u-anna', phone: null, email: 'anna@example.com', firstName: 'Anna' };

  it('adds a phone number to an email account after a texted code', async () => {
    const api = fakeApi(anna);
    api.on('POST /account/phone/start', ({ body }) => ({ status: 202, body: { phone: (body as { phone: string }).phone.replace(/\s/g, '') } }));
    api.on('POST /account/phone/verify', ({ body }) =>
      (body as { code: string }).code === '123456'
        ? { body: { user: { ...anna, phone: '+4915100000009' } } }
        : { status: 400, body: { error: 'invalid_code' } },
    );
    renderAt('/account');
    const section = await screen.findByRole('region', { name: 'Phone number' });
    expect(section).toHaveTextContent('No phone number yet.');
    await user().click(within(section).getByRole('button', { name: 'Add phone number' }));
    const number = within(section).getByLabelText('Mobile number');
    await waitFor(() => expect(number).toHaveFocus());
    await user().click(within(section).getByRole('button', { name: 'Send code' }));
    expect(within(section).getByText(/Enter your mobile number/)).toBeInTheDocument();
    await user().type(number, '0151 000');
    await user().click(within(section).getByRole('button', { name: 'Send code' }));
    expect(within(section).getByText('Enter an international phone number, e.g. +49 151 23456789.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /account/phone/start');
    await user().clear(number);
    await user().type(number, '+49 151 00000009');
    await user().click(within(section).getByRole('button', { name: 'Send code' }));

    expect(await within(section).findByText('We sent a 6-digit code to +4915100000009. Enter it to save the number.')).toBeInTheDocument();
    await user().type(within(section).getByLabelText('6-digit code'), '000000');
    await user().click(within(section).getByRole('button', { name: 'Save phone number' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('That code is not right or has expired.');
    await user().clear(within(section).getByLabelText('6-digit code'));
    await user().type(within(section).getByLabelText('6-digit code'), '123456');
    await user().click(within(section).getByRole('button', { name: 'Save phone number' }));

    expect(await within(section).findByRole('status')).toHaveTextContent('Your phone number is saved.');
    expect(section).toHaveTextContent('+4915100000009');
    expect(api.bodies['POST /account/phone/verify']).toEqual({ phone: '+4915100000009', code: '123456' });
    expect(within(section).getByRole('button', { name: 'Change phone number' })).toHaveFocus();
  });

  it('says plainly when another account uses the number', async () => {
    const api = fakeApi(anna);
    api.on('POST /account/phone/start', { status: 202, body: { phone: '+4915100000009' } });
    api.on('POST /account/phone/verify', { status: 409, body: { error: 'phone_taken' } });
    renderAt('/account');
    const section = await screen.findByRole('region', { name: 'Phone number' });
    await user().click(within(section).getByRole('button', { name: 'Add phone number' }));
    await user().type(within(section).getByLabelText('Mobile number'), '+4915100000009');
    await user().click(within(section).getByRole('button', { name: 'Send code' }));
    await user().type(await within(section).findByLabelText('6-digit code'), '123456');
    await user().click(within(section).getByRole('button', { name: 'Save phone number' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('Another MISK account already uses this phone number.');
    await user().click(within(section).getByRole('button', { name: 'Use another number' }));
    expect(within(section).getByLabelText('Mobile number')).toBeInTheDocument();
  });

  it('removes the phone of an account that also has an email, after a confirmation', async () => {
    const both = { ...anna, phone: '+4915100000009' };
    const api = fakeApi(both);
    api.on('DELETE /account/phone', { body: { user: anna } });
    renderAt('/account');
    const section = await screen.findByRole('region', { name: 'Phone number' });
    expect(section).toHaveTextContent('You can sign in with this number');
    await user().click(within(section).getByRole('button', { name: 'Remove' }));
    const confirm = within(section).getByRole('alertdialog', { name: 'Remove your phone number?' });
    await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Keep it' })).toHaveFocus());
    await user().click(within(confirm).getByRole('button', { name: 'Remove phone number' }));
    expect(await within(section).findByRole('status')).toHaveTextContent('Your phone number is removed.');
    expect(section).toHaveTextContent('No phone number yet.');
  });

  it('offers no Remove to an account that signs in with its phone only', async () => {
    fakeApi(users.customer);
    renderAt('/account');
    const section = await screen.findByRole('region', { name: 'Phone number' });
    expect(section).toHaveTextContent('+4915100000001');
    expect(within(section).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Change phone number' })).toBeInTheDocument();
  });
});

describe('messages from the MISK team', () => {
  const message = (id: string, body: string, read: boolean, kind = 'team_message'): InboxMessage => ({
    id,
    kind,
    body,
    read,
    createdAt: '2026-11-18T09:00:00.000Z',
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts them on the Messages tab, announces them as from the team, and labels them on the Messages page', async () => {
    // Only the interval is faked, so the app's regular check can be run at once.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = fakeApi(users.customer);
    api.on('GET /bookings', { body: { bookings: [] } });
    api.on('POST /inbox/read', { status: 204 });
    let messages = [message('m0', 'MISK: your Lawn mowing on Wed 11 Nov is booked.', true, 'booking_confirmed')];
    api.on('GET /inbox', () => ({ body: { messages, unread: messages.filter((m) => !m.read).length } }));
    renderAt('/');
    // Messages are opened from the bell on Home (D89).
    const bell = await screen.findByRole('link', { name: 'Messages' });
    expect(bell).toHaveAttribute('href', '/messages');
    const loads = () => api.calls.filter((call) => call === 'GET /inbox').length;
    const before = loads();

    // Nothing new: the regular check does not load the list again.
    act(() => vi.advanceTimersByTime(INBOX_REFRESH_MS));
    await waitFor(() => expect(api.calls).toContain('GET /inbox/unread'));
    expect(loads()).toBe(before);

    // The team writes: the next check finds it, the tab counts it and the app announces it.
    messages = [message('m1', 'MISK team: Please call us about your booking.', false), ...messages];
    act(() => vi.advanceTimersByTime(INBOX_REFRESH_MS));
    const banner = (await screen.findByText('New message from the MISK team')).closest('[role="status"]') as HTMLElement;
    expect(banner).toHaveTextContent('Please call us about your booking.');
    expect(banner).not.toHaveTextContent('MISK team:');
    expect(screen.getByRole('link', { name: 'Messages, 1 unread' })).toBe(bell);
    expect(loads()).toBe(before + 1);

    await user().click(within(banner).getByRole('link', { name: 'Open messages' }));
    const list = await screen.findByRole('list', { name: 'Messages' });
    const [team, older] = within(list).getAllByRole('listitem');
    expect(team).toHaveClass('team');
    expect(team).toHaveTextContent('From the MISK team');
    expect(team).toHaveTextContent('Please call us about your booking.');
    expect(older).not.toHaveTextContent('From the MISK team');
    await waitFor(() => expect(api.calls).toContain('POST /inbox/read'));
    // Read now: Profile's Messages row no longer counts it.
    await user().click(within(screen.getByRole('navigation', { name: 'Main menu' })).getByRole('link', { name: 'Profile' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('href', '/messages'));
  });
});
