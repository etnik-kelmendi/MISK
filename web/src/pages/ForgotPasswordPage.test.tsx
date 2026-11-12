import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderAt } from '../test/harness';

const user = () => userEvent.setup();
const TOKEN = 'abcdefghijklmnopqrstuvwxyz123456';

describe('forgot password', () => {
  it('shows a "Forgot password?" link on the log-in page that opens the reset request', async () => {
    fakeApi(null);
    renderAt('/signin');
    await user().click(await screen.findByRole('link', { name: 'Forgot password?' }));
    expect(await screen.findByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/)).toBeInTheDocument();
  });

  it('checks the email format before sending, then confirms without saying whether the account exists', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/forgot-password', { status: 202, body: {} });
    renderAt('/forgot-password');
    const email = await screen.findByLabelText(/Email address/);

    await user().click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    await user().type(email, 'sara@example');
    await user().click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveFocus();
    expect(api.calls).not.toContain('POST /auth/forgot-password');

    await user().type(email, '.com');
    await user().click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If sara@example.com belongs to a MISK account, a reset link is on its way.');
    expect(api.bodies['POST /auth/forgot-password']).toEqual({ email: 'sara@example.com' });
    expect(screen.getByText(/works once, for 30 minutes/)).toBeInTheDocument();
  });

  it('sets a new password that meets the rules and is confirmed, then sends the person to log in', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/reset-password', { status: 204 });
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    renderAt('/reset-password');
    const password = await screen.findByLabelText(/^New password/);
    const confirm = screen.getByLabelText(/^Confirm new password/);
    expect(window.location.hash).toBe('');

    await user().type(password, 'short');
    await user().type(confirm, 'short');
    await user().click(screen.getByRole('button', { name: 'Save new password' }));
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).not.toContain('POST /auth/reset-password');

    await user().clear(password);
    await user().type(password, 'meadow77');
    await user().click(screen.getByRole('button', { name: 'Save new password' }));
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).not.toContain('POST /auth/reset-password');

    await user().clear(confirm);
    await user().type(confirm, 'meadow77');
    await user().click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your password has been changed.');
    expect(api.bodies['POST /auth/reset-password']).toEqual({ token: TOKEN, password: 'meadow77' });
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/signin');
  });

  it('offers a new link when the link has expired or was already used', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/reset-password', { status: 400, body: { error: 'invalid_reset_link' } });
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    renderAt('/reset-password');
    await user().type(await screen.findByLabelText(/^New password/), 'meadow77');
    await user().type(screen.getByLabelText(/^Confirm new password/), 'meadow77');
    await user().click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used.');
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('says the link is not valid when the page is opened without one', async () => {
    fakeApi(null);
    window.history.replaceState(null, '', '/reset-password');
    renderAt('/reset-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired or was already used.');
  });

});
