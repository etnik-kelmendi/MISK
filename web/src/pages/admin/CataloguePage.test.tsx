import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminCatalogue, AdminCategory, Service } from '../../api/types';
import { fakeApi, renderAt, users } from '../../test/harness';

const user = () => userEvent.setup();

function category(overrides: Partial<AdminCategory> = {}): AdminCategory {
  return {
    id: 'cat-garden',
    slug: 'gardening',
    name: 'Gardening',
    icon: 'leaf',
    sortOrder: 1,
    active: true,
    visibleServices: 2,
    totalServices: 3,
    pros: 5,
    verifiedPros: 4,
    ...overrides,
  };
}

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 'svc-mow',
    categoryId: 'cat-garden',
    name: 'Lawn mowing',
    description: 'Mow, edge and clear the clippings',
    priceCents: 3500,
    durationMinutes: 60,
    sizeSmallPct: 100,
    sizeMediumPct: 130,
    sizeLargePct: 170,
    sortOrder: 0,
    active: true,
    pricing: 'fixed',
    isNew: false,
    ...overrides,
  };
}

function catalogue(overrides: Partial<AdminCatalogue> = {}): AdminCatalogue {
  return {
    categories: [category(), category({ id: 'cat-pool', slug: 'pool-care', name: 'Pool care', icon: 'sun', active: false, visibleServices: 1, totalServices: 1, pros: 0, verifiedPros: 0 })],
    services: [
      service(),
      service({ id: 'svc-hour', name: 'Gardener by the hour', priceCents: 3800, durationMinutes: 120, pricing: 'hourly', isNew: true }),
      service({ id: 'svc-hedge', name: 'Hedge trimming', priceCents: 4500, durationMinutes: 90, active: false }),
      service({ id: 'svc-pool', categoryId: 'cat-pool', name: 'Pool cleaning', priceCents: 6900, durationMinutes: 90 }),
    ],
    proSharePct: 82,
    appUrl: 'http://localhost:5173',
    changes: [
      {
        id: '1',
        categoryId: 'cat-garden',
        serviceId: 'svc-mow',
        action: 'price_changed',
        details: { from: 3200, to: 3500 },
        createdAt: '2026-11-08T09:00:00.000Z',
        serviceName: 'Lawn mowing',
        adminName: 'admin',
      },
    ],
    ...overrides,
  };
}

function setUp(data = catalogue()) {
  const api = fakeApi(users.admin);
  api.on('GET /admin/catalogue', { body: data });
  return api;
}

const rowOf = (name: string) => screen.getByText(name, { selector: 'span.b' }).closest('tr') as HTMLElement;

describe('catalogue page', () => {
  it('lists trades with visible services and pros, and shows the selected trade', async () => {
    setUp();
    renderAt('/admin/catalogue');
    const trades = await screen.findByRole('navigation', { name: 'Trades' });
    const buttons = within(trades).getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Gardening');
    expect(buttons[0]).toHaveTextContent('2 of 3 services visible · 5 pros');
    expect(buttons[1]).toHaveTextContent('Draft');
    expect(screen.getByText('4 verified pros · 2 services visible')).toBeInTheDocument();

    await user().click(buttons[1] as HTMLElement);
    expect(await screen.findByRole('heading', { name: /Pool care/ })).toBeInTheDocument();
    expect(screen.getByText('Pool cleaning')).toBeInTheDocument();
    expect(screen.queryByText('Lawn mowing')).not.toBeInTheDocument();
  });

  it('shows each service with duration, base price, size prices and what the pro earns; hourly ones per hour', async () => {
    setUp();
    renderAt('/admin/catalogue');
    await screen.findByRole('table');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Service', 'Duration', 'Base price', 'Small', 'Medium', 'Large', 'Pro earns (82%)', 'Visible', 'Remove']);
    const mowing = rowOf('Lawn mowing');
    expect(mowing).toHaveTextContent('Mow, edge and clear the clippings');
    expect(mowing).toHaveTextContent('1 h');
    expect(within(mowing).getByRole('textbox', { name: 'Base price of Lawn mowing in euros' })).toHaveValue('35.00');
    expect(mowing).toHaveTextContent('€35€45.50€59.50');
    expect(mowing).toHaveTextContent('€28.70 – €48.79');
    const hourly = rowOf('Gardener by the hour');
    expect(hourly).toHaveTextContent('€38/h');
    expect(hourly).toHaveTextContent('€31.16/h');
    expect(hourly).toHaveTextContent('New');
    expect(hourly).toHaveTextContent('2 h');
  });

  it('updates size prices while typing and saves the price on leaving the field', async () => {
    const api = setUp();
    api.on('PATCH /admin/services/svc-mow', { body: { service: service({ priceCents: 4000 }) } });
    renderAt('/admin/catalogue');
    await screen.findByRole('table');
    const input = within(rowOf('Lawn mowing')).getByRole('textbox', { name: 'Base price of Lawn mowing in euros' });
    await user().clear(input);
    await user().type(input, '40');
    expect(rowOf('Lawn mowing')).toHaveTextContent('€40€52€68');
    expect(api.calls).not.toContain('PATCH /admin/services/svc-mow');
    fireEvent.blur(input);
    await waitFor(() => expect(api.bodies['PATCH /admin/services/svc-mow']).toEqual({ priceCents: 4000 }));
  });

  it('saves on Enter, refuses invalid prices, and Escape puts the old price back', async () => {
    const api = setUp();
    api.on('PATCH /admin/services/svc-mow', { body: { service: service({ priceCents: 3650 }) } });
    renderAt('/admin/catalogue');
    await screen.findByRole('table');
    const input = within(rowOf('Lawn mowing')).getByRole('textbox', { name: /Lawn mowing/ });
    await user().clear(input);
    await user().type(input, 'abc');
    await user().keyboard('{Enter}');
    expect(await screen.findByText(/Enter a price between €1 and €10,000/)).toBeInTheDocument();
    expect(api.calls).not.toContain('PATCH /admin/services/svc-mow');
    await user().click(input);
    await user().keyboard('{Escape}');
    expect(input).toHaveValue('35.00');
    await user().clear(input);
    await user().type(input, '36,50{Enter}');
    await waitFor(() => expect(api.bodies['PATCH /admin/services/svc-mow']).toEqual({ priceCents: 3650 }));
  });

  it('hides and shows a service with its visible switch, and fades hidden ones', async () => {
    const api = setUp();
    api.on('PATCH /admin/services/svc-mow', { body: { service: service({ active: false }) } });
    api.on('PATCH /admin/services/svc-hedge', { body: { service: service({ id: 'svc-hedge', active: true }) } });
    renderAt('/admin/catalogue');
    await screen.findByRole('table');
    expect(rowOf('Hedge trimming')).toHaveClass('faded');
    expect(rowOf('Lawn mowing')).not.toHaveClass('faded');
    const mowingSwitch = screen.getByRole('switch', { name: 'Visible to customers: Lawn mowing' });
    expect(mowingSwitch).toBeChecked();
    await user().click(mowingSwitch);
    expect(api.bodies['PATCH /admin/services/svc-mow']).toEqual({ active: false });
    await user().click(screen.getByRole('switch', { name: 'Visible to customers: Hedge trimming' }));
    expect(api.bodies['PATCH /admin/services/svc-hedge']).toEqual({ active: true });
  });

  it('adds a service only with a name, price and duration, and Cancel closes the row', async () => {
    const api = setUp();
    api.on('POST /admin/services', { status: 201, body: { service: service({ id: 'svc-new', name: 'Leaf clearing', isNew: true }) } });
    renderAt('/admin/catalogue');
    await screen.findByRole('table');
    await user().click(screen.getByRole('button', { name: 'Add service' }));
    let form = screen.getByRole('form', { name: 'Add service' });
    await user().click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Add service' })).not.toBeInTheDocument();

    await user().click(screen.getByRole('button', { name: 'Add service' }));
    form = screen.getByRole('form', { name: 'Add service' });
    await user().click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(form).getByText('Enter a name.')).toBeInTheDocument();
    expect(within(form).getByText(/Enter a price between/)).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /admin/services');

    await user().type(within(form).getByLabelText('Name'), 'Leaf clearing');
    await user().type(within(form).getByLabelText('Price (€)'), '29');
    await user().clear(within(form).getByLabelText('Duration (minutes)'));
    await user().type(within(form).getByLabelText('Duration (minutes)'), '90');
    await user().click(within(form).getByRole('button', { name: 'Add' }));
    expect(api.bodies['POST /admin/services']).toEqual({
      categoryId: 'cat-garden',
      name: 'Leaf clearing',
      description: '',
      priceCents: 2900,
      durationMinutes: 90,
      pricing: 'fixed',
    });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add service' })).not.toBeInTheDocument());
  });

  it('explains the sizes with their factors and an example price from the trade', async () => {
    setUp();
    renderAt('/admin/catalogue');
    const sizes = await screen.findByRole('region', { name: 'Sizes' });
    expect(sizes).toHaveTextContent('Small×1.0');
    expect(sizes).toHaveTextContent('Medium×1.3');
    expect(sizes).toHaveTextContent('Large×1.7');
    expect(sizes).toHaveTextContent('e.g. Lawn mowing: €35');
    expect(sizes).toHaveTextContent('e.g. Lawn mowing: €45.50');
    expect(sizes).toHaveTextContent('e.g. Lawn mowing: €59.50');
    expect(sizes).toHaveTextContent('A small job');
  });

  it('shows the trade as the customer app does, with visible services only', async () => {
    setUp();
    renderAt('/admin/catalogue');
    await user().click(await screen.findByRole('button', { name: 'See in the app' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gardening in the customer app' });
    expect(within(dialog).getByText('Lawn mowing')).toBeInTheDocument();
    expect(within(dialog).getByText('Gardener by the hour')).toBeInTheDocument();
    expect(within(dialog).queryByText('Hedge trimming')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open in the app' })).toHaveAttribute('href', 'http://localhost:5173/category/gardening');
  });

  it('creates a new trade as a draft and publishes it', async () => {
    const api = setUp();
    api.on('POST /admin/categories', {
      status: 201,
      body: { category: category({ id: 'cat-new', slug: 'window-cleaning', name: 'Window cleaning', active: false }) },
    });
    api.on('PATCH /admin/categories/cat-garden', { body: { category: category({ active: false }) } });
    renderAt('/admin/catalogue');
    await user().click(await screen.findByRole('button', { name: 'New trade' }));
    const form = screen.getByRole('form', { name: 'New trade' });
    await user().click(within(form).getByRole('button', { name: 'Create draft' }));
    expect(within(form).getByText('Enter a name for the trade, such as "Moving help".')).toBeInTheDocument();
    expect(within(form).getByLabelText('Trade name')).toHaveFocus();
    expect(api.calls).not.toContain('POST /admin/categories');
    await user().type(within(form).getByLabelText('Trade name'), 'Window cleaning');
    await user().click(within(form).getByRole('img', { name: 'Icon: Sparkle' }));
    await user().click(within(form).getByRole('button', { name: 'Create draft' }));
    expect(api.bodies['POST /admin/categories']).toEqual({ name: 'Window cleaning', icon: 'sparkle' });

    await user().click(await screen.findByRole('button', { name: 'Back to draft' }));
    expect(api.bodies['PATCH /admin/categories/cat-garden']).toEqual({ active: false });
  });

  it('removes a service from its row after asking', async () => {
    const api = setUp();
    api.on('DELETE /admin/services/svc-mow', { status: 204 });
    renderAt('/admin/catalogue?trade=cat-garden');
    const removeButton = await screen.findByRole('button', { name: 'Remove Lawn mowing' });
    await user().click(removeButton);
    const dialog = screen.getByRole('alertdialog', { name: 'Remove "Lawn mowing"?' });
    expect(dialog).toHaveTextContent('Bookings already made with it keep their details.');
    await user().click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.calls).not.toContain('DELETE /admin/services/svc-mow');

    await user().click(screen.getByRole('button', { name: 'Remove Lawn mowing' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove service' }));
    expect(await screen.findByText('"Lawn mowing" was removed.')).toBeInTheDocument();
    expect(api.calls).toContain('DELETE /admin/services/svc-mow');
    expect(api.calls.filter((c) => c === 'GET /admin/catalogue').length).toBeGreaterThan(1);
  });

  it('keeps the trade’s activity log folded until it is opened', async () => {
    setUp();
    renderAt('/admin/catalogue');
    const title = await screen.findByRole('heading', { name: 'Activity log' });
    const log = title.closest('details') as HTMLDetailsElement;
    expect(log).not.toHaveAttribute('open');
    expect(log.querySelector('summary')).toHaveTextContent('1 change');
    await user().click(title);
    expect(log).toHaveAttribute('open');
    expect(log).toHaveTextContent('Lawn mowing: price €32 → €35');
    expect(log).toHaveTextContent('admin');
    await user().click(title);
    expect(log).not.toHaveAttribute('open');
  });

  it('removes a trade after asking, and shows the first trade with a note', async () => {
    const api = setUp();
    api.on('DELETE /admin/categories/cat-garden', { status: 204 });
    renderAt('/admin/catalogue?trade=cat-garden');
    await user().click(await screen.findByRole('button', { name: 'Remove trade' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove "Gardening"?' });
    expect(dialog).toHaveTextContent('removed for good');
    await user().click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.calls).not.toContain('DELETE /admin/categories/cat-garden');

    await user().click(screen.getByRole('button', { name: 'Remove trade' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove trade' }));
    expect(await screen.findByText('"Gardening" was removed.')).toBeInTheDocument();
    expect(api.calls).toContain('DELETE /admin/categories/cat-garden');
  });

  it('explains why a trade in use cannot be removed', async () => {
    const api = setUp();
    api.on('DELETE /admin/categories/cat-garden', { status: 409, body: { error: 'trade_has_bookings' } });
    renderAt('/admin/catalogue?trade=cat-garden');
    await user().click(await screen.findByRole('button', { name: 'Remove trade' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove trade' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This trade has bookings or monthly plans, so it cannot be removed.');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
