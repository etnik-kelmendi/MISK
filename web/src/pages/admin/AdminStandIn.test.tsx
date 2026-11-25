import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminVisit } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

/** D99: the team assigns a stand-in for one plan visit whose pro is off that day. */

const user = () => userEvent.setup();
const VISIT_ID = '33333333-3333-4333-8333-333333333333';

function visit(overrides: Partial<AdminVisit> = {}): AdminVisit {
  return {
    id: VISIT_ID,
    number: 'V-1007',
    startsAt: '2026-12-16T09:00:00.000Z',
    endsAt: '2026-12-16T10:00:00.000Z',
    status: 'planned',
    tasksDone: [],
    completedAt: null,
    subscriptionId: 'sub-1',
    planName: 'Lawn care',
    tasks: ['Mow'],
    address: '12 Linden Street',
    postcode: '10115',
    notes: '',
    priceCents: 4300,
    proSharePct: 70,
    subscriptionStatus: 'active',
    categoryName: 'Gardening',
    customer: { firstName: 'Sara', lastName: null, phone: null, email: null },
    customerProfile: null,
    pro: { id: 'u-daniel', firstName: 'Daniel', phone: null },
    pause: null,
    perVisitCents: 1000,
    proMonthlyCents: 3010,
    miskMonthlyCents: 1290,
    standInNeeded: true,
    standInFor: null,
    ...overrides,
  };
}

function setUp() {
  const api = fakeApi(users.admin);
  api.on('GET /admin/bookings', { body: { bookings: [], counts: { all: 0, needs_action: 0, live: 0, upcoming: 0, done: 0 }, truncated: false } });
  api.on('GET /admin/catalogue', { body: { categories: [], services: [] } });
  let assigned = false;
  api.on(`GET /admin/visits/${VISIT_ID}`, () => ({
    body: {
      visit: assigned
        ? visit({ standInNeeded: false, pro: { id: 'u-leon', firstName: 'Leon', phone: null }, standInFor: { id: 'u-daniel', firstName: 'Daniel' } })
        : visit(),
    },
  }));
  api.on(`GET /admin/visits/${VISIT_ID}/stand-in-candidates`, {
    body: { candidates: [{ id: 'u-leon', firstName: 'Leon', distanceKm: 1.2, ratingAverage: 4.9 }] },
  });
  api.on(`POST /admin/visits/${VISIT_ID}/stand-in`, () => {
    assigned = true;
    return { status: 204 };
  });
  return api;
}

describe('Assign a stand-in (D99)', () => {
  it('lists free pros nearby and assigns one only after Confirm Assignment', async () => {
    const api = setUp();
    renderAt(`/admin/bookings?open=v:${VISIT_ID}`);
    const drawer = await screen.findByRole('dialog', { name: 'V-1007' });
    const section = await within(drawer).findByRole('region', { name: 'Assign a stand-in' });
    expect(section).toHaveTextContent('Daniel is off that day');
    const assign = await within(section).findByRole('button', { name: 'Assign Leon' });
    expect(section).toHaveTextContent('1.2 km away · rating 4.9');

    // Cancel sends nothing.
    await user().click(assign);
    const confirm = await screen.findByRole('alertdialog', { name: 'Make Leon the stand-in for this visit?' });
    expect(within(confirm).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Confirm Assignment']);
    expect(confirm).toHaveTextContent('Lawn care');
    await user().click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.calls).not.toContain(`POST /admin/visits/${VISIT_ID}/stand-in`);

    await user().click(assign);
    await user().click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Confirm Assignment' }));
    await waitFor(() => expect(api.bodies[`POST /admin/visits/${VISIT_ID}/stand-in`]).toEqual({ proId: 'u-leon' }));
    // The drawer shows the visit as it is now: Leon stands in, nothing left to assign.
    await waitFor(() => expect(within(drawer).queryByRole('region', { name: 'Assign a stand-in' })).not.toBeInTheDocument());
    expect(await within(drawer).findByText(/standing in for Daniel/)).toBeInTheDocument();
  });

  it('shows no stand-in section for a visit that needs none', async () => {
    const api = setUp();
    api.on(`GET /admin/visits/${VISIT_ID}`, { body: { visit: visit({ standInNeeded: false }) } });
    renderAt(`/admin/bookings?open=v:${VISIT_ID}`);
    const drawer = await screen.findByRole('dialog', { name: 'V-1007' });
    expect(within(drawer).getByText('Lawn care')).toBeInTheDocument();
    expect(within(drawer).queryByRole('region', { name: 'Assign a stand-in' })).not.toBeInTheDocument();
    expect(api.calls).not.toContain(`GET /admin/visits/${VISIT_ID}/stand-in-candidates`);
  });
});
