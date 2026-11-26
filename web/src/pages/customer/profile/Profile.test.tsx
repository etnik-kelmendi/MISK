import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FavouritePro, SavedAddress, User } from '../../../api/types';
import { fakeApi, renderAt, users } from '../../../test/harness';
import { COOKIE_CHOICE_KEY } from './TermsPrivacyPage';

/** D92: the customer Profile and its pages. */

const user = () => userEvent.setup();

const sara: User = { ...users.customer, firstName: 'Sara', lastName: 'Meier', email: 'sara@example.com' };

function address(overrides: Partial<SavedAddress> = {}): SavedAddress {
  return {
    id: 'a-home',
    label: 'Home',
    address: '12 Linden Street',
    postcode: '10115',
    notes: 'Gate code 4411',
    areaName: 'Mitte',
    served: true,
    selected: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function favourite(overrides: Partial<FavouritePro> = {}): FavouritePro {
  return {
    id: 'u-daniel',
    firstName: 'Daniel',
    photoId: null,
    ratingAverage: 4.9,
    ratingCount: 12,
    jobsDone: 40,
    trades: [{ id: 'cat-garden', slug: 'gardening', name: 'Gardening', icon: 'leaf' }],
    savedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

const VISA = { id: 'pm_visa', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 };
const MC = { id: 'pm_mc', brand: 'mastercard', last4: '4444', expMonth: 1, expYear: 2031 };

describe('Profile', () => {
  it('shows photo, name and phone, an Edit button and the sections in order', async () => {
    const api = fakeApi(sara);
    api.on('GET /addresses', { body: { addresses: [address(), address({ id: 'a-mum', label: "Mum's house", selected: false })], max: 10 } });
    api.on('GET /favourites/pros', { body: { pros: [favourite()] } });
    renderAt('/profile');
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    const head = screen.getByRole('region', { name: 'Your profile' });
    expect(head).toHaveTextContent('Sara Meier');
    expect(head).toHaveTextContent('+4915100000001');
    expect(within(head).getByRole('link', { name: 'Edit personal information' })).toHaveAttribute('href', '/profile/personal');

    const account = screen.getByRole('list', { name: 'Account' });
    expect(within(account).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Personal information', '/profile/personal'],
      ['Saved addresses', '/profile/addresses'],
      ['Payment methods', '/profile/payments'],
      ['Receipts', '/bookings?tab=past'],
      ['Notifications', '/profile/notifications'],
    ]);
    await waitFor(() => expect(within(account).getByRole('link', { name: /Saved addresses/ })).toHaveTextContent('Saved addresses2'));
    const misk = screen.getByRole('list', { name: 'MISK' });
    expect(within(misk).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/favourites',
      '/profile/become-a-pro',
      '/profile/help',
      '/profile/terms',
    ]);
    expect(within(misk).getByRole('link', { name: /Become a pro/ })).toHaveTextContent('Same account');
    await waitFor(() => expect(within(misk).getByRole('link', { name: /Favourite pros/ })).toHaveTextContent('Favourite pros1'));
  });

  it('opens Personal information from Edit and each section from its row', async () => {
    fakeApi(sara);
    renderAt('/profile');
    await user().click(await screen.findByRole('link', { name: 'Edit personal information' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Personal information' })).toBeInTheDocument();
    await user().click(screen.getByRole('link', { name: 'Back' }));
    await user().click(await screen.findByRole('link', { name: 'Help & support' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Help & support' })).toBeInTheDocument();
  });

  it('opens Receipts as the "Past & receipts" tab of Bookings', async () => {
    const api = fakeApi(sara);
    api.on('GET /bookings', { body: { bookings: [] } });
    renderAt('/profile');
    await user().click(await screen.findByRole('link', { name: 'Receipts' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Bookings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Past & receipts' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('logs out and opens Sign in', async () => {
    const api = fakeApi(sara);
    api.on('POST /auth/logout', { status: 204 });
    renderAt('/profile');
    await user().click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Log in to MISK' })).toBeInTheDocument();
    expect(api.calls).toContain('POST /auth/logout');
  });

  it('offers a pro "Switch to Pro app" at the top instead of Become a pro, keeps the Profile tab, and no Notifications', async () => {
    fakeApi(users.pro);
    renderAt('/profile');
    const misk = await screen.findByRole('list', { name: 'MISK' });
    const switchApp = screen.getByRole('link', { name: /Switch to Pro app/ });
    expect(switchApp).toHaveAttribute('href', '/pro');
    // It comes before everything else on the page.
    expect(switchApp.compareDocumentPosition(screen.getByRole('region', { name: 'Your profile' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Main menu' })).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
    expect(within(misk).queryByRole('link', { name: /Become a pro/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument();
  });
});

describe('Personal information', () => {
  it('saves the name and language, with the phone, email and the privacy note', async () => {
    const api = fakeApi(sara);
    api.on('PATCH /account/personal', ({ body }) => ({ body: { user: { ...sara, ...(body as object) }, language: 'en' } }));
    renderAt('/profile/personal');
    const first = await screen.findByLabelText('First name');
    expect(first).toHaveValue('Sara');
    expect(screen.getByLabelText(/Last name/)).toHaveValue('Meier');
    expect(screen.getByRole('region', { name: 'Phone number' })).toHaveTextContent('+4915100000001');
    expect(screen.getByRole('region', { name: 'Email' })).toHaveTextContent('sara@example.com');
    const language = screen.getByLabelText('Language');
    expect(within(language).getAllByRole('option').map((option) => option.textContent)).toEqual(['English']);
    expect(screen.getByText('Pros only see your first name and the job address.')).toBeInTheDocument();

    await user().clear(first);
    await user().click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter your first name.')).toBeInTheDocument();
    expect(api.calls).not.toContain('PATCH /account/personal');

    await user().type(first, ' Anna ');
    await user().clear(screen.getByLabelText(/Last name/));
    await user().click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your changes are saved.');
    expect(api.bodies['PATCH /account/personal']).toEqual({ firstName: 'Anna', lastName: null, language: 'en' });
  });

  it('confirms a new phone number with a texted code', async () => {
    const api = fakeApi(sara);
    api.on('POST /account/phone/start', { status: 202, body: { phone: '+4915100000009' } });
    api.on('POST /account/phone/verify', { body: { user: { ...sara, phone: '+4915100000009' } } });
    renderAt('/profile/personal');
    const phone = await screen.findByRole('region', { name: 'Phone number' });
    await user().click(within(phone).getByRole('button', { name: 'Change phone number' }));
    await user().type(within(phone).getByLabelText('Mobile number'), '+4915100000009');
    await user().click(within(phone).getByRole('button', { name: 'Send code' }));
    await user().type(await within(phone).findByLabelText('6-digit code'), '123456');
    await user().click(within(phone).getByRole('button', { name: 'Save phone number' }));
    expect(await within(phone).findByRole('status')).toHaveTextContent('Your phone number is saved.');
    expect(api.bodies['POST /account/phone/verify']).toEqual({ phone: '+4915100000009', code: '123456' });
  });

  it('says how a phone-only account logs in when it has no email', async () => {
    fakeApi(users.customer);
    renderAt('/profile/personal');
    const email = await screen.findByRole('region', { name: 'Email' });
    expect(email).toHaveTextContent('Your account logs in with your phone number.');
    expect(await within(email).findByRole('button', { name: 'Add email' })).toBeEnabled();
  });

  it('is where the old Account address leads', async () => {
    fakeApi(sara);
    renderAt('/account');
    expect(await screen.findByRole('heading', { level: 1, name: 'Personal information' })).toBeInTheDocument();
  });
});

describe('Saved addresses', () => {
  it('shows each address with its name and notes, the default marked, and adds, edits and removes', async () => {
    const api = fakeApi(sara);
    const mum = address({ id: 'a-mum', label: "Mum's house", address: '5 Oak Avenue', postcode: '10117', notes: 'Key under the blue pot', selected: false });
    api.on('GET /addresses', { body: { addresses: [address(), mum], max: 10 } });
    api.on('GET /postcodes', { body: { postcodes: [{ code: '10115', name: 'Mitte' }, { code: '10117', name: 'Mitte South' }] } });
    api.on('POST /addresses', { status: 201, body: { address: address({ id: 'a-new', label: 'Work', notes: 'Ring twice', selected: false }) } });
    api.on('PATCH /addresses/a-mum', { body: { address: mum } });
    api.on('POST /addresses/a-mum/select', { body: { address: { ...mum, selected: true } } });
    api.on('DELETE /addresses/a-mum', { status: 204 });
    renderAt('/profile/addresses');

    const list = await screen.findByRole('list', { name: 'Saved addresses' });
    const [home, other] = within(list).getAllByRole('listitem');
    expect(home).toHaveTextContent('Home Default');
    expect(home).toHaveTextContent('12 Linden Street');
    expect(home).toHaveTextContent('Gate code 4411');
    expect(other).toHaveTextContent("Mum's house");
    expect(other).toHaveTextContent('Key under the blue pot');
    expect(other).not.toHaveTextContent('Default');
    expect(screen.getByText(/Notes like gate codes go to the pro automatically/)).toBeInTheDocument();

    await user().click(within(list).getByRole('button', { name: 'Make 5 Oak Avenue the default' }));
    await waitFor(() => expect(api.calls).toContain('POST /addresses/a-mum/select'));

    await user().click(within(list).getByRole('button', { name: 'Edit 5 Oak Avenue' }));
    const editForm = await screen.findByRole('form', { name: 'Edit address' });
    const notes = within(editForm).getByLabelText(/Notes for the pro/);
    expect(notes).toHaveValue('Key under the blue pot');
    await user().clear(notes);
    await user().type(notes, 'Key in the letterbox');
    await user().click(within(editForm).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.bodies['PATCH /addresses/a-mum']).toEqual({ label: "Mum's house", address: '5 Oak Avenue', postcode: '10117', notes: 'Key in the letterbox' }),
    );

    await user().click(await screen.findByRole('button', { name: 'Add address' }));
    const addForm = await screen.findByRole('form', { name: 'New address' });
    await user().type(within(addForm).getByLabelText(/^Name/), 'Work');
    await user().type(within(addForm).getByLabelText('Street and house number'), '12 Linden Street');
    await user().type(await within(addForm).findByLabelText('Postcode'), '10115');
    await user().type(within(addForm).getByLabelText(/Notes for the pro/), 'Ring twice');
    await user().click(within(addForm).getByRole('button', { name: 'Save address' }));
    await waitFor(() =>
      expect(api.bodies['POST /addresses']).toEqual({ label: 'Work', address: '12 Linden Street', postcode: '10115', notes: 'Ring twice' }),
    );

    await user().click(await screen.findByRole('button', { name: 'Remove 5 Oak Avenue' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove this address?' });
    await user().click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.calls).toContain('DELETE /addresses/a-mum'));
  });
});

describe('Payment methods', () => {
  const cards = (overrides: Record<string, unknown> = {}) => ({
    body: { cards: [VISA, MC], defaultCardId: 'pm_visa', planCardIds: [], publishableKey: null, ...overrides },
  });

  it('lists each card with its last 4 digits and expiry, the default marked, and the provider note', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/cards', cards());
    api.on('POST /account/cards/pm_mc/default', cards({ defaultCardId: 'pm_mc' }));
    renderAt('/profile/payments');
    const list = await screen.findByRole('list', { name: 'Saved cards' });
    const [visa, mc] = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(visa).toHaveTextContent('Visa •••• 4242');
    expect(visa).toHaveTextContent('Expires 08/28');
    expect(visa).toHaveTextContent('Default');
    expect(mc).toHaveTextContent('Mastercard •••• 4444');
    expect(mc).toHaveTextContent('Expires 01/31');
    expect(screen.getByText('Card details are stored by our payment provider, never by MISK.')).toBeInTheDocument();

    api.on('GET /account/cards', cards({ defaultCardId: 'pm_mc' }));
    await user().click(within(mc).getByRole('button', { name: 'Make Mastercard •••• 4444 the default' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Mastercard •••• 4444 is now your default card.');
    expect(api.calls).toContain('POST /account/cards/pm_mc/default');
  });

  it('removes a card after a confirmation', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/cards', cards());
    api.on('DELETE /account/cards/pm_mc', { status: 204 });
    renderAt('/profile/payments');
    await user().click(await screen.findByRole('button', { name: 'Remove Mastercard •••• 4444' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Remove this card?' });
    api.on('GET /account/cards', cards({ cards: [VISA] }));
    await user().click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Mastercard •••• 4444 is removed.');
    await waitFor(() => expect(screen.queryByText('Mastercard •••• 4444')).not.toBeInTheDocument());
  });

  it('keeps the card that pays for a plan until another card is the default', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/cards', cards({ planCardIds: ['pm_visa'] }));
    renderAt('/profile/payments');
    const remove = await screen.findByRole('button', { name: 'Remove Visa •••• 4242' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription('Pays for your plan');
    expect(screen.getByRole('button', { name: 'Remove Mastercard •••• 4444' })).toBeEnabled();
    expect(screen.getByText(/can be removed once another card is the default/)).toBeInTheDocument();
  });

  it('explains the refusal when the card started paying for a plan meanwhile', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/cards', cards());
    api.on('DELETE /account/cards/pm_visa', { status: 409, body: { error: 'card_pays_for_plan' } });
    renderAt('/profile/payments');
    await user().click(await screen.findByRole('button', { name: 'Remove Visa •••• 4242' }));
    await user().click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This card pays for your plan. Make another card the default first');
  });

  it('adds a card in a pop-up, and says so when payments are not set up', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/cards', cards({ cards: [], defaultCardId: null }));
    api.on('POST /account/cards/setup', { body: { clientSecret: 'seti_1_secret', publishableKey: null } });
    renderAt('/profile/payments');
    expect(await screen.findByText('No saved cards yet. Add one to pay faster next time.')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Add a card' }));
    const sheet = screen.getByRole('dialog', { name: 'Add a card' });
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Payments are not working right now.');
    expect(api.calls).toContain('POST /account/cards/setup');
  });
});

describe('Notifications', () => {
  const topics = { booking_updates: true, pro_on_the_way: true, reminders: true, plan_changes: true, offers: false };

  it('has a switch for each topic and saves a change, noting what is always sent', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/notifications', { body: { topics } });
    api.on('PATCH /account/notifications', ({ body }) => ({ body: { topics: { ...topics, ...(body as object) } } }));
    renderAt('/profile/notifications');
    const switches = await screen.findAllByRole('switch');
    expect(switches).toHaveLength(5);
    expect(screen.getByRole('switch', { name: 'Booking updates' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Pro is on the way' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Reminders' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Plan changes' })).toBeInTheDocument();
    const offers = screen.getByRole('switch', { name: 'Offers & tips' });
    expect(offers).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Messages about payments and safety are always sent.')).toBeInTheDocument();

    await user().click(screen.getByRole('switch', { name: 'Reminders' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Reminders' })).toHaveAttribute('aria-checked', 'false'));
    expect(api.bodies['PATCH /account/notifications']).toEqual({ reminders: false });
    await user().click(offers);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Offers & tips' })).toHaveAttribute('aria-checked', 'true'));
    expect(api.bodies['PATCH /account/notifications']).toEqual({ offers: true });
  });
});

describe('Favourite pros', () => {
  it('shows photo, name, trade and rating, books a pro on the Services page and removes one with the heart', async () => {
    const api = fakeApi(sara);
    api.on('GET /favourites/pros', { body: { pros: [favourite()] } });
    api.on('DELETE /favourites/pros/u-daniel', { body: { favourite: false } });
    renderAt('/profile');
    await user().click(await screen.findByRole('link', { name: /Favourite pros/ }));
    const list = await screen.findByRole('list', { name: 'Favourite pros' });
    const daniel = within(list).getByRole('listitem');
    expect(daniel).toHaveTextContent('Daniel');
    expect(daniel).toHaveTextContent('Gardening');
    expect(within(daniel).getByRole('img', { name: 'Rated 4.9 out of 5' })).toBeInTheDocument();
    expect(within(daniel).getByRole('link', { name: 'Book Daniel' })).toHaveAttribute('href', '/category/gardening?pro=u-daniel');
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/profile');

    api.on('GET /favourites/pros', { body: { pros: [] } });
    await user().click(within(daniel).getByRole('button', { name: 'Remove Daniel from your favourites' }));
    expect(await screen.findByText('No favourites yet.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Daniel is no longer one of your favourites.');
    expect(api.calls).toContain('DELETE /favourites/pros/u-daniel');
  });
});

describe('Become a pro', () => {
  it('explains the same account and the three steps, and starts the pro application', async () => {
    const api = fakeApi(sara);
    api.on('POST /account/become-pro', { body: { user: { ...sara, role: 'pro' } } });
    renderAt('/profile/become-a-pro');
    expect(await screen.findByText(/Use this same account. Your bookings and plans stay/)).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'How it works' });
    expect(within(steps).getAllByRole('listitem').map((step) => step.querySelector('.tt')?.textContent)).toEqual([
      'Apply in the app',
      'MISK checks you',
      'Get jobs',
    ]);
    await user().click(screen.getByRole('button', { name: 'Start my pro application' }));
    expect(await screen.findByRole('navigation', { name: 'Pro menu' })).toBeInTheDocument();
    expect(api.calls).toContain('POST /account/become-pro');
  });
});

describe('Help & support', () => {
  it('opens the answer of a question and offers chat and call when support is set up', async () => {
    const api = fakeApi(sara);
    api.on('GET /account/settings', { body: { language: 'en', languages: ['en'], support: { email: 'help@example.com', phone: '+493012345678' } } });
    renderAt('/profile/help');
    const question = await screen.findByRole('button', { name: 'When am I charged?' });
    expect(question).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/24 hours after the job is marked done/)).not.toBeVisible();
    await user().click(question);
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/24 hours after the job is marked done/)).toBeVisible();
    await user().click(question);
    expect(question).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/24 hours after the job is marked done/)).not.toBeVisible();

    expect(await screen.findByRole('link', { name: 'Chat with us' })).toHaveAttribute('href', 'mailto:help@example.com?subject=Help%20with%20MISK');
    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+493012345678');
  });

  it('keeps Chat with us and Call when no support contact is set up, and says how to reach the team', async () => {
    fakeApi(sara);
    renderAt('/profile/help');
    const chat = await screen.findByRole('button', { name: 'Chat with us' });
    const call = screen.getByRole('button', { name: 'Call' });
    expect(screen.queryByRole('link', { name: 'Chat with us' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reply to any message from MISK and the team gets back to you.')).not.toBeInTheDocument();
    await user().click(chat);
    expect(chat).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Reply to any message from MISK and the team gets back to you.')).toBeInTheDocument();
    await user().click(call);
    expect(call).toHaveAttribute('aria-expanded', 'true');
    expect(chat).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Terms & privacy', () => {
  it('links the terms, the privacy policy and the cookie settings, without a separate subscription terms row', async () => {
    fakeApi(sara);
    renderAt('/profile/terms');
    const list = await screen.findByRole('list', { name: 'Terms & privacy' });
    expect(within(list).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
    expect(within(list).queryByText('Subscription terms')).not.toBeInTheDocument();
    // The owner has not published a privacy policy address in this build.
    expect(within(list).getByText('Privacy Policy').closest('li')).toHaveTextContent('Coming soon');

    await user().click(within(list).getByRole('button', { name: 'Cookie settings' }));
    const sheet = screen.getByRole('dialog', { name: 'Cookie settings' });
    // Necessary storage is a plain "Always on" label, not a switch.
    expect(within(sheet).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(sheet).getByText('✓ Always on')).toBeInTheDocument();
    expect(within(sheet).getByText(/no advertising or tracking cookies/)).toBeInTheDocument();
    await user().click(within(sheet).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(COOKIE_CHOICE_KEY) ?? '{}')).toMatchObject({ necessary: true });
  });

  it('opens the terms page', async () => {
    fakeApi(sara);
    renderAt('/profile/terms');
    await user().click(await screen.findByRole('link', { name: 'Terms of Service' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Terms/ })).toBeInTheDocument();
    // The usual header bar with a Back button, and the text in the padded page body.
    expect(screen.getByRole('button', { name: /Back/ }).closest('header')).toHaveClass('appbar');
    expect(screen.getByRole('heading', { level: 2, name: '1. What MISK is' }).closest('.body')).not.toBeNull();
  });
});
