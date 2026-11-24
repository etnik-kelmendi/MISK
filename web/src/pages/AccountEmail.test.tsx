import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '../api/types';
import { fakeApi, renderAt, users } from '../test/harness';

/** D97: changing the email of one's own account, and the page the link opens. */

const user = () => userEvent.setup();
const sara: User = { ...users.customer, firstName: 'Sara', email: 'sara@example.com' };
const PENDING = { email: 'new@example.com', expiresAt: '2026-11-25T10:00:00.000Z' };

afterEach(() => {
  window.location.hash = '';
});

describe('Change email', () => {
  it('asks for the new address and the password, then shows the change as waiting', async () => {
    const api = fakeApi(sara);
    api.on('POST /account/email/start', { status: 202, body: { pending: PENDING } });
    renderAt('/profile/personal');
    const section = await screen.findByRole('region', { name: 'Email' });
    expect(section).toHaveTextContent('sara@example.com');
    await user().click(await within(section).findByRole('button', { name: 'Change email' }));

    // Nothing is sent until both fields are right.
    await user().click(within(section).getByRole('button', { name: 'Send link' }));
    expect(await within(section).findByText('Enter your email address.')).toBeInTheDocument();
    await user().type(within(section).getByLabelText('New email address'), 'SARA@example.com');
    await user().click(within(section).getByRole('button', { name: 'Send link' }));
    expect(await within(section).findByText('That is already the email of your account.')).toBeInTheDocument();
    expect(within(section).getByText('Please enter your current password.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /account/email/start');

    await user().clear(within(section).getByLabelText('New email address'));
    await user().type(within(section).getByLabelText('New email address'), 'new@example.com');
    await user().type(within(section).getByLabelText('Current password'), 'garden42');
    await user().click(within(section).getByRole('button', { name: 'Send link' }));

    expect(await within(section).findByText('Check your inbox at new@example.com to confirm. The change applies once you confirm.')).toBeInTheDocument();
    expect(api.bodies['POST /account/email/start']).toEqual({ email: 'new@example.com', password: 'garden42' });
    // The current address stays until the link is opened.
    expect(section).toHaveTextContent('sara@example.com');
  });

  it('shows the API\x27s answer to a wrong password', async () => {
    const api = fakeApi(sara);
    api.on('POST /account/email/start', { status: 400, body: { error: 'wrong_password' } });
    renderAt('/profile/personal');
    const section = await screen.findByRole('region', { name: 'Email' });
    await user().click(await within(section).findByRole('button', { name: 'Change email' }));
    await user().type(within(section).getByLabelText('New email address'), 'new@example.com');
    await user().type(within(section).getByLabelText('Current password'), 'nope1234');
    await user().click(within(section).getByRole('button', { name: 'Send link' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('That password is not right.');
  });

  it('lets a phone account add an email without a password', async () => {
    const api = fakeApi(users.customer);
    api.on('POST /account/email/start', { status: 202, body: { pending: { ...PENDING, email: 'sara@example.com' } } });
    renderAt('/profile/personal');
    const section = await screen.findByRole('region', { name: 'Email' });
    await user().click(await within(section).findByRole('button', { name: 'Add email' }));
    expect(within(section).queryByLabelText('Current password')).not.toBeInTheDocument();
    await user().type(within(section).getByLabelText('New email address'), 'sara@example.com');
    await user().click(within(section).getByRole('button', { name: 'Send link' }));
    expect(await within(section).findByText(/Check your inbox at sara@example.com/)).toBeInTheDocument();
    expect(api.bodies['POST /account/email/start']).toEqual({ email: 'sara@example.com' });
  });

  it('sends the link again and cancels a waiting change', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/email', { body: { email: sara.email, hasPassword: true, pending: PENDING } });
    api.on('POST /account/email/resend', { status: 202, body: { pending: PENDING } });
    api.on('DELETE /account/email/pending', { status: 204 });
    renderAt('/profile/personal');
    const section = await screen.findByRole('region', { name: 'Email' });
    expect(await within(section).findByText(/Check your inbox at new@example.com/)).toBeInTheDocument();

    await user().click(within(section).getByRole('button', { name: 'Send the link again' }));
    expect(await within(section).findByText('We sent a new link to new@example.com.')).toBeInTheDocument();

    await user().click(within(section).getByRole('button', { name: 'Cancel change' }));
    expect(await within(section).findByText('The change is cancelled. Your email stays sara@example.com.')).toBeInTheDocument();
    expect(within(section).queryByText(/Check your inbox/)).not.toBeInTheDocument();
    expect(api.calls).toContain('DELETE /account/email/pending');
  });
});

describe('Confirm email page', () => {
  it('confirms the new address from the link', async () => {
    const api = fakeApi(null);
    api.on('POST /account/email/confirm', { body: { email: 'new@example.com' } });
    window.location.hash = '#token=abcdefghijklmnopqrstuvwxyz';
    renderAt('/confirm-email');
    expect(await screen.findByText(/Your MISK email is now new@example.com/)).toBeInTheDocument();
    expect(api.bodies['POST /account/email/confirm']).toEqual({ token: 'abcdefghijklmnopqrstuvwxyz' });
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/signin');
  });

  it('says when the address is already taken', async () => {
    const api = fakeApi(null);
    api.on('POST /account/email/confirm', { status: 409, body: { error: 'email_taken' } });
    window.location.hash = '#token=abcdefghijklmnopqrstuvwxyz';
    renderAt('/confirm-email');
    expect(await screen.findByRole('alert')).toHaveTextContent('An account with this email already exists');
    await waitFor(() => expect(screen.queryByText('Confirming your new email…')).not.toBeInTheDocument());
  });

  it('refuses a link without a token', async () => {
    fakeApi(null);
    renderAt('/confirm-email');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired');
  });
});
