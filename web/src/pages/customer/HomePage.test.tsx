import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Catalogue, HomePro, SavedAddress } from '../../api/types';
import { catalogue, fakeApi, renderAt, users } from '../../test/harness';
import { partOfDay } from './HomePage';
import { searchCatalogue } from './HomeSearch';

const user = () => userEvent.setup();

/** D89: the customer Home page. */

const garden = catalogue.categories[0];
const mowing = garden?.services[0];
if (!garden || !mowing) throw new Error('test catalogue changed');

/** Gardening (with an hourly service), then Plumbing, then Cleaning: the order the control panel set. */
const market: Catalogue = {
  ...catalogue,
  categories: [
    { ...garden, services: [mowing, { ...mowing, id: 'svc-hour', name: 'Gardener by the hour', priceCents: 3800, pricing: 'hourly' }] },
    {
      ...garden,
      id: 'cat-plumb',
      slug: 'plumbing',
      name: 'Plumbing',
      icon: 'drop',
      services: [{ ...mowing, id: 'svc-leak', categoryId: 'cat-plumb', name: 'Leak repair', priceCents: 5900 }],
    },
    { ...garden, id: 'cat-clean', slug: 'cleaning', name: 'Cleaning', icon: 'sparkle', services: [{ ...mowing, id: 'svc-clean', categoryId: 'cat-clean', name: 'Home cleaning', priceCents: 4000 }] },
  ],
};

function address(overrides: Partial<SavedAddress> = {}): SavedAddress {
  return {
    id: 'a-home',
    label: 'Home',
    address: '12 Linden Street',
    postcode: '10115',
    notes: null,
    areaName: 'Mitte',
    served: true,
    selected: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function pro(overrides: Partial<HomePro> = {}): HomePro {
  return {
    id: 'u-daniel',
    firstName: 'Daniel',
    photoId: null,
    trades: [{ id: 'cat-garden', slug: 'gardening', name: 'Gardening', icon: 'leaf' }],
    ratingAverage: 4.9,
    ratingCount: 31,
    jobsDone: 120,
    isFavourite: false,
    ...overrides,
  };
}

function setUp(options: { addresses?: SavedAddress[]; pros?: HomePro[]; plan?: { id: string; name: string; categoryId: string; fromCents: number } | null } = {}) {
  const api = fakeApi(users.customer);
  api.on('GET /catalogue', { body: market });
  api.on('GET /addresses', { body: { addresses: options.addresses ?? [address(), address({ id: 'a-work', label: 'Work', address: '5 Unter den Linden', postcode: '10117', areaName: 'Mitte South', selected: false })], max: 10 } });
  api.on('GET /home', { body: { plan: options.plan === undefined ? { id: 'p1', name: 'Lawn care', categoryId: 'cat-garden', fromCents: 4900 } : options.plan, pros: options.pros ?? [pro(), pro({ id: 'u-ben', firstName: 'Ben', isFavourite: true, ratingAverage: 4.7, ratingCount: 12, jobsDone: 1, trades: [{ id: 'cat-plumb', slug: 'plumbing', name: 'Plumbing', icon: 'drop' }] })] } });
  api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }, { code: '10117', name: 'Mitte South' }] } });
  return api;
}

describe('Home (D89)', () => {
  it('shows greeting, address, search, plans banner, trades and top-rated pros from top to bottom, and the four-button menu', async () => {
    setUp();
    renderAt('/');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Sara' });
    expect(screen.getByText(/^Good (morning|afternoon|evening),$/)).toBeInTheDocument();
    const pill = await screen.findByRole('button', { name: /12 Linden Street/ });
    const search = screen.getByRole('searchbox', { name: 'What do you need help with?' });
    expect(search).toHaveAttribute('placeholder', 'What do you need help with?');
    const banner = await screen.findByRole('link', { name: /Lawn care from €49\/month/ });
    const trades = screen.getByRole('heading', { name: 'Categories' });
    const top = screen.getByRole('heading', { name: 'Top rated near you' });
    const order = [heading, pill, search, banner, trades, top];
    for (let i = 1; i < order.length; i += 1) {
      // Each section comes after the one before it in the page.
      expect((order[i - 1] as HTMLElement).compareDocumentPosition(order[i] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    const menu = screen.getByRole('navigation', { name: 'Main menu' });
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Bookings', 'Plans', 'Profile']);
    expect(within(menu).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
    // Messages stay one tap away: the bell in the header.
    expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('href', '/messages');
  });

  it('counts unread messages on the bell', async () => {
    const api = setUp();
    api.on('GET /inbox', { body: { messages: [], unread: 3 } });
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Messages, 3 unread' })).toHaveTextContent('3');
  });

  it('greets by the time of day in the market time zone', () => {
    expect(partOfDay('Europe/Berlin', new Date('2026-06-01T06:00:00Z'))).toBe('morning');
    expect(partOfDay('Europe/Berlin', new Date('2026-06-01T12:00:00Z'))).toBe('afternoon');
    expect(partOfDay('Europe/Berlin', new Date('2026-06-01T19:00:00Z'))).toBe('evening');
  });

  it('switches to another saved address from the address pop-up', async () => {
    const api = setUp();
    api.on('POST /addresses/a-work/select', () => {
      api.on('GET /addresses', { body: { addresses: [address({ selected: false }), address({ id: 'a-work', label: 'Work', address: '5 Unter den Linden', postcode: '10117', selected: true })], max: 10 } });
      return { body: { address: address({ id: 'a-work', selected: true }) } };
    });
    renderAt('/');
    await user().click(await screen.findByRole('button', { name: /12 Linden Street/ }));
    const sheet = screen.getByRole('dialog', { name: 'Your addresses' });
    expect(within(sheet).getByRole('radio', { name: /Home · 12 Linden Street/ })).toBeChecked();
    const homeLoads = api.calls.filter((c) => c === 'GET /home').length;
    await user().click(within(sheet).getByRole('radio', { name: /Work · 5 Unter den Linden/ }));
    expect(await screen.findByRole('button', { name: /5 Unter den Linden/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // "Near you" follows the new address.
    expect(api.calls.filter((c) => c === 'GET /home').length).toBe(homeLoads + 1);
  });

  it('adds an address after checking it, and offers the waiting list for a postcode MISK does not serve', async () => {
    const api = setUp({ addresses: [], pros: [] });
    api.on('POST /addresses', { status: 201, body: { address: address({ id: 'a-new', label: null, address: '9 Cedar Close' }) } });
    renderAt('/');
    expect(await screen.findByText('Add your address above to see the top-rated pros near you.')).toBeInTheDocument();
    await user().click(await screen.findByRole('button', { name: /Add your address/ }));
    const sheet = screen.getByRole('dialog', { name: 'Your addresses' });
    const save = await within(sheet).findByRole('button', { name: 'Save address' });
    await user().click(save);
    expect(within(sheet).getByText('Enter the street and house number where the job is.')).toBeInTheDocument();
    expect(within(sheet).getByText('Choose your postcode.')).toBeInTheDocument();

    await user().type(within(sheet).getByLabelText('Street and house number'), '9 Cedar Close');
    await user().type(within(sheet).getByLabelText('Postcode'), '99999');
    await user().click(save);
    expect(within(sheet).getByText(/MISK isn't available at this postcode yet/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Join the waiting list' })).toBeInTheDocument();
    expect(api.calls).not.toContain('POST /addresses');

    await user().clear(within(sheet).getByLabelText('Postcode'));
    await user().type(within(sheet).getByLabelText('Postcode'), '10115');
    expect(within(sheet).getByText('Mitte')).toBeInTheDocument();
    await user().click(save);
    await waitFor(() => expect(api.bodies['POST /addresses']).toEqual({ label: null, address: '9 Cedar Close', postcode: '10115', notes: null, select: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('finds services by service or trade name, with the trade and starting price, and says when nothing matches', async () => {
    setUp();
    renderAt('/');
    const search = await screen.findByRole('searchbox', { name: 'What do you need help with?' });
    await user().type(search, 'plumb');
    const results = screen.getByRole('list', { name: 'Search results' });
    const [leak] = within(results).getAllByRole('link');
    expect(leak).toHaveTextContent('Leak repair');
    expect(leak).toHaveTextContent('Plumbing');
    expect(leak).toHaveTextContent('from €59');
    expect(leak).toHaveAttribute('href', '/category/plumbing?service=svc-leak');

    await user().clear(search);
    await user().type(search, 'garden');
    expect(within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('link').map((l) => l.textContent)).toEqual([
      expect.stringContaining('Lawn mowingGardeningfrom €35'),
      expect.stringContaining('Gardener by the hourGardening€38/h'),
    ]);

    await user().clear(search);
    await user().type(search, 'piano');
    expect(screen.getByText('No services found')).toBeInTheDocument();
  });

  it('searches names, not descriptions', () => {
    expect(searchCatalogue(market.categories, 'clippings')).toEqual([]);
    expect(searchCatalogue(market.categories, 'leak plumbing').map((r) => r.service.id)).toEqual(['svc-leak']);
  });

  it('links the plans banner to Plans, and leaves it out without published plans', async () => {
    setUp();
    const { unmount } = renderAt('/');
    const banner = await screen.findByRole('link', { name: /Lawn care from €49\/month/ });
    expect(banner).toHaveAttribute('href', '/plans');
    expect(banner).toHaveTextContent('See all plans');
    unmount();

    setUp({ plan: null });
    renderAt('/');
    await screen.findByRole('heading', { name: 'Top rated near you' });
    expect(screen.queryByText(/\/month/)).not.toBeInTheDocument();
  });

  it('shows the trades in the control-panel order with icon and name, each opening its Services page', async () => {
    setUp();
    renderAt('/');
    const heading = await screen.findByRole('heading', { name: 'Categories' });
    const grid = heading.parentElement?.querySelector('ul') as HTMLElement;
    const links = within(grid).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Gardening', 'Plumbing', 'Cleaning']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/category/gardening', '/category/plumbing', '/category/cleaning']);
    expect(links[0]?.querySelector('svg')).not.toBeNull();
  });

  it('shows top-rated pros with photo, name, trade, stars and jobs, a red heart for favourites, and the hint', async () => {
    setUp();
    renderAt('/');
    expect(await screen.findByText('Tap a pro to book them directly. They get your job first.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Favourites' })).toHaveAttribute('href', '/favourites');
    const pros = await screen.findByRole('list', { name: 'Top rated near you' });
    const [daniel, ben] = within(pros).getAllByRole('link');
    if (!daniel || !ben) throw new Error('pros missing');
    expect(daniel).toHaveTextContent('Daniel');
    expect(daniel).toHaveTextContent('Gardening');
    expect(within(daniel).getByRole('img', { name: 'Rated 4.9 out of 5' })).toBeInTheDocument();
    expect(daniel).toHaveTextContent('120 jobs');
    expect(daniel.querySelector('.av')).toHaveTextContent('D');
    expect(within(daniel).queryByRole('img', { name: 'Favourite' })).not.toBeInTheDocument();
    expect(within(ben).getByRole('img', { name: 'Favourite' })).toBeInTheDocument();
    expect(ben).toHaveTextContent('1 job');
    expect(daniel).toHaveAttribute('href', '/category/gardening?pro=u-daniel');
    expect(ben).toHaveAttribute('href', '/category/plumbing?pro=u-ben');
  });

  it('books a picked pro: Services shows "Booking with Daniel", times are theirs, and the booking asks for them', async () => {
    const api = setUp();
    api.on('GET /home/pros/u-daniel', { body: { pro: pro() } });
    api.on('GET /bookings', { body: { bookings: [] } });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 2);
    const at = (hour: number) => {
      const start = new Date(day);
      start.setUTCHours(hour, 0, 0, 0);
      return start.toISOString();
    };
    const slot = (hour: number, preferredFree: boolean) => ({ startsAt: at(hour), endsAt: at(hour + 1), freePros: 2, available: true, preferredFree });
    api.on('GET /availability', ({ url }) => ({
      body: { slots: [slot(9, false), slot(11, url.searchParams.get('proId') === 'u-daniel')], waitlist: [], held: [], preferredPro: { id: 'u-daniel', firstName: 'Daniel' } },
    }));
    api.on('POST /bookings', { status: 201, body: { booking: { id: 'b1' }, payment: null } });
    api.on('GET /bookings/b1', { status: 404, body: { error: 'not_found' } });
    renderAt('/');
    const pros = await screen.findByRole('list', { name: 'Top rated near you' });
    await user().click(within(pros).getAllByRole('link')[0] as HTMLElement);

    const chip = await screen.findByText('Booking with Daniel.');
    expect(chip.closest('.picked-pro')).toHaveTextContent("Daniel gets this job first. If they're busy at the time you pick, it goes to the next best-rated pro.");
    await user().click(screen.getByRole('checkbox', { name: /Lawn mowing/ }));
    await user().click(screen.getByRole('button', { name: 'Continue · from €35' }));

    // The selected address fills the job details.
    await waitFor(() => expect(screen.getByLabelText('Street and house number')).toHaveValue('12 Linden Street'));
    expect(screen.getByLabelText('Postcode')).toHaveValue('10115');
    expect(screen.getByText('Booking with Daniel.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Continue · / }));

    expect(await screen.findByText('Showing the times Daniel is free.')).toBeInTheDocument();
    const time = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    expect(screen.queryByRole('button', { name: new RegExp(`^${time(at(9))}`) })).not.toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: new RegExp(`^${time(at(11))}`) }));
    await user().click(screen.getByRole('button', { name: /Continue · .*, / }));
    expect(await screen.findByText('Daniel gets this job first')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: /Book & pay/ }));
    await waitFor(() => expect(api.bodies['POST /bookings']).toMatchObject({ preferredProId: 'u-daniel', address: '12 Linden Street', startsAt: at(11) }));
  });

  it('lets the customer remove the picked pro and book normally', async () => {
    const api = setUp();
    api.on('GET /home/pros/u-daniel', { body: { pro: pro() } });
    renderAt('/category/gardening?pro=u-daniel');
    await user().click(await screen.findByRole('button', { name: 'Book without Daniel' }));
    expect(screen.queryByText('Booking with Daniel.')).not.toBeInTheDocument();
    await user().click(screen.getByRole('checkbox', { name: /Lawn mowing/ }));
    await user().click(screen.getByRole('button', { name: 'Continue · from €35' }));
    await screen.findByLabelText('Street and house number');
    expect(screen.queryByText('Booking with Daniel.')).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c === 'GET /home/pros/u-daniel')).toHaveLength(1);
  });

  it('lists favourite pros to book them directly', async () => {
    const api = setUp();
    api.on('GET /favourites/pros', {
      body: {
        pros: [
          { ...pro(), savedAt: '2026-11-01T09:00:00.000Z' },
          { ...pro({ id: 'u-gone', firstName: 'Arta', trades: [] }), savedAt: '2026-10-01T09:00:00.000Z' },
        ],
      },
    });
    renderAt('/');
    await user().click(await screen.findByRole('link', { name: 'Favourites' }));
    const list = await screen.findByRole('list', { name: 'Favourite pros' });
    expect(within(list).getByRole('link', { name: 'Book Daniel' })).toHaveAttribute('href', '/category/gardening?pro=u-daniel');
    expect(within(list).getByText(/Not taking jobs right now/)).toBeInTheDocument();
    // Opened from Home, the back arrow goes back to Home.
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/');
  });

  it('manages saved addresses from Profile; Messages is reached from the bell on Home, not from Profile', async () => {
    const api = setUp();
    api.on('DELETE /addresses/a-work', { status: 204 });
    api.on('POST /addresses/a-work/select', { body: { address: address({ id: 'a-work', selected: true }) } });
    renderAt('/');
    await user().click(within(await screen.findByRole('navigation', { name: 'Main menu' })).getByRole('link', { name: 'Profile' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Messages' })).not.toBeInTheDocument();
    await user().click(screen.getByRole('link', { name: /Saved addresses/ }));
    const book = await screen.findByRole('list', { name: 'Saved addresses' });
    expect(within(book).getByText('Default')).toBeInTheDocument();
    await user().click(within(book).getByRole('button', { name: 'Make 5 Unter den Linden the default' }));
    await waitFor(() => expect(api.calls).toContain('POST /addresses/a-work/select'));
    await user().click(within(book).getByRole('button', { name: 'Remove 5 Unter den Linden' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove this address?' });
    await user().click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.calls).toContain('DELETE /addresses/a-work'));
  });
});
