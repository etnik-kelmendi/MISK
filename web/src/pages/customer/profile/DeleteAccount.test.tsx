import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { User } from '../../../api/types';
import { fakeApi, renderAt, users } from '../../../test/harness';
import type { DeletionCheck } from './DeleteAccountSheet';

/** D97: "Delete account" on Profile. */

const user = () => userEvent.setup();
const sara: User = { ...users.customer, firstName: 'Sara', email: 'sara@example.com' };
const ALLOWED: DeletionCheck = { pro: false, allowed: true, confirmWith: 'password', blockers: [], upcomingBookings: 2 };

async function openSheet() {
  await user().click(await screen.findByRole('button', { name: 'Delete account' }));
  return screen.findByRole('dialog', { name: 'Delete account' });
}

describe('Delete account', () => {
  it('explains what happens, needs the password, and ends on the goodbye screen', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/deletion', { body: ALLOWED });
    api.on('POST /account/delete', { body: { deleted: true } });
    api.on('POST /auth/logout', { status: 204 });
    renderAt('/profile');
    const sheet = await openSheet();
    expect(await within(sheet).findByText("This can't be undone.")).toBeInTheDocument();
    expect(sheet).toHaveTextContent('Receipts are kept for 7 years because the law requires it.');
    expect(sheet).toHaveTextContent('Your 2 upcoming bookings are cancelled and refunded');

    await user().click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(await within(sheet).findByText('Please enter your current password.')).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /account/delete');

    await user().type(within(sheet).getByLabelText('Your password'), 'garden42');
    await user().click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'Your account is deleted' })).toBeInTheDocument();
    expect(api.bodies['POST /account/delete']).toEqual({ password: 'garden42' });
    await waitFor(() => expect(api.calls).toContain('POST /auth/logout'));
    expect(screen.getByRole('heading', { name: 'Your account is deleted' })).toBeInTheDocument();
  });

  it('asks an account without a password to type DELETE', async () => {
    const api = fakeApi(users.customer);
    api.on('GET /account/deletion', { body: { ...ALLOWED, confirmWith: 'typed', upcomingBookings: 0 } });
    api.on('POST /account/delete', { body: { deleted: true } });
    api.on('POST /auth/logout', { status: 204 });
    renderAt('/profile');
    const sheet = await openSheet();
    const field = await within(sheet).findByLabelText('Type DELETE to confirm');
    await user().type(field, 'delete');
    await user().click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(await within(sheet).findByText('Type DELETE in capital letters to confirm.')).toBeInTheDocument();
    await user().clear(field);
    await user().type(field, 'DELETE');
    await user().click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'Your account is deleted' })).toBeInTheDocument();
    expect(api.bodies['POST /account/delete']).toEqual({ confirmText: 'DELETE' });
  });

  it('lists what must end first and offers no Delete button', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/deletion', {
      body: {
        ...ALLOWED,
        allowed: false,
        blockers: [
          { kind: 'plan', id: 'sub-1', name: 'Lawn care', at: null },
          { kind: 'plan', id: 'sub-2', name: 'Hedge care', at: '2026-12-20T12:00:00.000Z' },
          { kind: 'booking_soon', id: 'b-1', name: 'Lawn mowing', at: '2026-11-25T09:00:00.000Z' },
          { kind: 'problem_open', id: 'b-2', name: 'Leak repair', at: '2026-11-01T09:00:00.000Z' },
          { kind: 'money_held', id: 'b-3', name: 'Hedge trimming', at: '2026-11-02T09:00:00.000Z' },
        ],
      },
    });
    renderAt('/profile');
    const sheet = await openSheet();
    const list = await within(sheet).findByRole('region', { name: 'Before you can delete your account' });
    expect(list).toHaveTextContent('Your plan Lawn care is still running. Cancel it first.');
    expect(list).toHaveTextContent('Your plan Hedge care ends on 20 Dec 2026. You can delete your account after that.');
    expect(list).toHaveTextContent('starts within 24 hours');
    expect(list).toHaveTextContent('Your problem report about Leak repair is still open.');
    expect(list).toHaveTextContent('Money for Hedge trimming is still held on your card.');
    expect(within(list).getAllByRole('link', { name: 'Open plan' })[0]).toHaveAttribute('href', '/my-plans/sub-1');
    expect(within(list).getAllByRole('link', { name: 'Open booking' })[0]).toHaveAttribute('href', '/bookings/b-1');
    expect(within(sheet).queryByLabelText('Your password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Keep account' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows something that opened meanwhile, from the API\x27s refusal', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/deletion', { body: ALLOWED });
    api.on('POST /account/delete', {
      status: 409,
      body: { error: 'account_has_open_items', blockers: [{ kind: 'booking_in_progress', id: 'b-9', name: 'Lawn mowing', at: null }] },
    });
    renderAt('/profile');
    const sheet = await openSheet();
    await user().type(await within(sheet).findByLabelText('Your password'), 'garden42');
    await user().click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(await within(sheet).findByText(/Lawn mowing is under way right now./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('sends a pro who also books to support', async () => {
    const api = fakeApi(users.pro);
    api.on('GET /account/deletion', { body: { ...ALLOWED, pro: true, allowed: false, upcomingBookings: 0 } });
    api.on('GET /account/settings', { body: { language: 'en', languages: ['en'], support: { email: 'help@example.com', phone: null } } });
    renderAt('/profile');
    const sheet = await openSheet();
    expect(await within(sheet).findByText(/MISK support closes it for you/)).toBeInTheDocument();
    expect(await within(sheet).findByText('Contact MISK support at help@example.com.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('has a goodbye screen anyone can open', async () => {
    fakeApi(null);
    renderAt('/account-deleted');
    expect(await screen.findByRole('heading', { name: 'Your account is deleted' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the start' })).toHaveAttribute('href', '/signin');
  });
});
