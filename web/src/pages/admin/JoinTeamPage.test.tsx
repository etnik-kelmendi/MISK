import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderAt } from '../../test/harness';

const user = () => userEvent.setup();
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function openLink() {
  window.history.replaceState(null, '', `/admin/join#token=${TOKEN}`);
  renderAt('/admin/join');
}

describe('joining the team with an invitation link', () => {
  it('says which role the link is for, checks the fields, and creates the account', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/invite/check', { body: { invite: { role: 'operations', expiresAt: '2026-11-19T10:00:00.000Z' } } });
    api.on('POST /auth/admin/invite/accept', { status: 201, body: { email: 'nora@example.com', role: 'operations' } });
    openLink();
    expect(await screen.findByText(/invited to the MISK control panel as Operations/)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(api.bodies['POST /auth/admin/invite/check']).toEqual({ token: TOKEN });

    await user().click(screen.getByRole('button', { name: 'Join the team' }));
    expect(screen.getByLabelText('First name')).toHaveFocus();
    expect(api.calls).not.toContain('POST /auth/admin/invite/accept');

    await user().type(screen.getByLabelText('First name'), 'Nora');
    await user().type(screen.getByLabelText('Last name'), 'Berisha');
    await user().type(screen.getByLabelText('Email address'), 'nora@example');
    await user().type(screen.getByLabelText('Password'), 'too short');
    await user().type(screen.getByLabelText('Repeat password'), 'too short');
    await user().click(screen.getByRole('button', { name: 'Join the team' }));
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).not.toContain('POST /auth/admin/invite/accept');

    await user().type(screen.getByLabelText('Email address'), '.com');
    await user().clear(screen.getByLabelText('Password'));
    await user().type(screen.getByLabelText('Password'), 'my own long password');
    await user().clear(screen.getByLabelText('Repeat password'));
    await user().type(screen.getByLabelText('Repeat password'), 'my own long password');
    await user().click(screen.getByRole('button', { name: 'Join the team' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Welcome to the team! Sign in with nora@example.com');
    expect(api.bodies['POST /auth/admin/invite/accept']).toEqual({
      token: TOKEN,
      firstName: 'Nora',
      lastName: 'Berisha',
      email: 'nora@example.com',
      password: 'my own long password',
    });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/admin/login');
  });

  it('explains when the link was used, withdrawn or has run out', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/invite/check', { status: 400, body: { error: 'invalid_invite_link' } });
    openLink();
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation link has expired, was already used or was withdrawn.');
    expect(screen.queryByRole('button', { name: 'Join the team' })).not.toBeInTheDocument();
  });

  it('keeps the form when the email is already taken, so another can be used', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/invite/check', { body: { invite: { role: 'support', expiresAt: '2026-11-19T10:00:00.000Z' } } });
    api.on('POST /auth/admin/invite/accept', { status: 409, body: { error: 'email_taken' } });
    openLink();
    await user().type(await screen.findByLabelText('First name'), 'Sam');
    await user().type(screen.getByLabelText('Last name'), 'Okafor');
    await user().type(screen.getByLabelText('Email address'), 'sam@example.com');
    await user().type(screen.getByLabelText('Password'), 'my own long password');
    await user().type(screen.getByLabelText('Repeat password'), 'my own long password');
    await user().click(screen.getByRole('button', { name: 'Join the team' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join the team' })).toBeInTheDocument();
  });
});
