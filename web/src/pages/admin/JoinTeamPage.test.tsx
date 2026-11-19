import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeApi, renderAt } from '../../test/harness';

const user = () => userEvent.setup();
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const CREATE = { name: 'Create account' };
const OPENED = { body: { invite: { role: 'operations', expiresAt: '2026-11-19T10:00:00.000Z' } } };

function openLink() {
  window.history.replaceState(null, '', `/admin/join#token=${TOKEN}`);
  renderAt('/admin/join');
}

function openValidLink() {
  const api = fakeApi(null);
  api.on('POST /auth/admin/invite/check', OPENED);
  api.on('POST /auth/admin/invite/accept', { status: 201, body: { email: 'nora@example.com', role: 'operations' } });
  openLink();
  return api;
}

describe('joining the team with an invitation link', () => {
  it('says which role the link is for, checks the fields, and creates the account', async () => {
    const api = openValidLink();
    expect(await screen.findByText(/invited to the MISK control panel as Operations/)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(api.bodies['POST /auth/admin/invite/check']).toEqual({ token: TOKEN });

    // A good password, but the names are missing: the form points at the first one.
    await user().type(screen.getByLabelText('Password'), 'garden42');
    await user().type(screen.getByLabelText('Repeat password'), 'garden42');
    await user().click(screen.getByRole('button', CREATE));
    expect(screen.getByLabelText('First name')).toHaveFocus();
    expect(api.calls).not.toContain('POST /auth/admin/invite/accept');

    await user().type(screen.getByLabelText('First name'), 'Nora');
    await user().type(screen.getByLabelText('Last name'), 'Berisha');
    await user().type(screen.getByLabelText('Email address'), 'nora@example');
    await user().clear(screen.getByLabelText('Repeat password'));
    await user().type(screen.getByLabelText('Repeat password'), 'garden43');
    await user().click(screen.getByRole('button', CREATE));
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Repeat password')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls).not.toContain('POST /auth/admin/invite/accept');

    await user().type(screen.getByLabelText('Email address'), '.com');
    await user().clear(screen.getByLabelText('Repeat password'));
    await user().type(screen.getByLabelText('Repeat password'), 'garden42');
    await user().click(screen.getByRole('button', CREATE));
    expect(await screen.findByRole('status')).toHaveTextContent('Welcome to the team! Sign in with nora@example.com');
    expect(api.bodies['POST /auth/admin/invite/accept']).toEqual({
      token: TOKEN,
      firstName: 'Nora',
      lastName: 'Berisha',
      email: 'nora@example.com',
      password: 'garden42',
    });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/admin/login');
  });

  it('shows the password checklist before typing and updates it on every key press', async () => {
    openValidLink();
    await screen.findByLabelText('Password');
    const list = screen.getByRole('list', { name: /password/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.querySelectorAll('li.ok')).toHaveLength(0);
    expect(list.querySelectorAll('li.bad')).toHaveLength(0);
    expect(screen.getByText(/Special characters like/)).toBeInTheDocument();

    await user().type(screen.getByLabelText('Password'), 'abc');
    expect(list.querySelectorAll('li.ok')).toHaveLength(1);
    expect(list.querySelector('li.ok')).toHaveTextContent(/letter/i);
    expect(screen.getByText('1 of 3 password requirements met')).toBeInTheDocument();

    await user().type(screen.getByLabelText('Password'), 'defg1');
    expect(list.querySelectorAll('li.ok')).toHaveLength(3);
    expect(screen.getByText('3 of 3 password requirements met')).toBeInTheDocument();
  });

  it('keeps Create account disabled until every rule is met, and allows special characters', async () => {
    openValidLink();
    const password = await screen.findByLabelText('Password');
    const button = screen.getByRole('button', CREATE);
    expect(button).toBeDisabled();
    expect(screen.getByText('Meet all password requirements to create your account.')).toBeInTheDocument();

    await user().type(password, 'abcdefgh');
    expect(button).toBeDisabled();
    await user().clear(password);
    await user().type(password, '12345678');
    expect(button).toBeDisabled();
    await user().clear(password);
    await user().type(password, 'abc!def#?!');
    expect(button).toBeDisabled();

    await user().clear(password);
    await user().type(password, 'abc!def#9');
    expect(button).toBeEnabled();
    expect(screen.queryByText('Meet all password requirements to create your account.')).not.toBeInTheDocument();
  });

  it('marks unmet rules in red after leaving the field', async () => {
    openValidLink();
    const password = await screen.findByLabelText('Password');
    await user().type(password, 'abc');
    const list = screen.getByRole('list', { name: /password/i });
    expect(list.querySelectorAll('li.bad')).toHaveLength(0);
    await user().tab();
    expect(list.querySelectorAll('li.bad')).toHaveLength(2);
  });

  it('shows and hides the password with a button', async () => {
    openValidLink();
    const password = await screen.findByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    await user().click(within(password.closest('.password-input') as HTMLElement).getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    await user().click(within(password.closest('.password-input') as HTMLElement).getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('explains when the link was used, withdrawn or has run out', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/invite/check', { status: 400, body: { error: 'invalid_invite_link' } });
    openLink();
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation link has expired, was already used or was withdrawn.');
    expect(screen.queryByRole('button', CREATE)).not.toBeInTheDocument();
  });

  it('keeps the form when the email is already taken, so another can be used', async () => {
    const api = fakeApi(null);
    api.on('POST /auth/admin/invite/check', { body: { invite: { role: 'support', expiresAt: '2026-11-19T10:00:00.000Z' } } });
    api.on('POST /auth/admin/invite/accept', { status: 409, body: { error: 'email_taken' } });
    openLink();
    await user().type(await screen.findByLabelText('First name'), 'Sam');
    await user().type(screen.getByLabelText('Last name'), 'Okafor');
    await user().type(screen.getByLabelText('Email address'), 'sam@example.com');
    await user().type(screen.getByLabelText('Password'), 'garden42');
    await user().type(screen.getByLabelText('Repeat password'), 'garden42');
    await user().click(screen.getByRole('button', CREATE));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', CREATE)).toBeInTheDocument();
  });
});
