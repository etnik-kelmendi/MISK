import { call, createTestContext, resetDatabase, seedMarket, signIn, type TestContext } from '../../test/helpers.js';
import { MAX_ADDRESS_NOTES } from './addresses.js';
import { LANGUAGES } from './profile.js';

/** D92: the customer Profile pages — Personal information, address notes, settings and Become a pro. */

let t: TestContext;
let customer: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

const get = (url: string, cookie = customer) => call(t, 'GET', url, { cookie });
const post = (url: string, body?: unknown, cookie = customer) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });
const patch = (url: string, body: unknown, cookie = customer) => call(t, 'PATCH', url, { cookie, body });

describe('saved address notes', () => {
  it('keeps notes for the pro with an address, trimmed, and lets them be changed and removed', async () => {
    const added = await post('/addresses', { label: 'Home', address: '12 Linden Street', postcode: '10115', notes: '  Gate code 4411 ' });
    expect(added.statusCode).toBe(201);
    const id = added.json().address.id as string;
    expect(added.json().address).toMatchObject({ label: 'Home', notes: 'Gate code 4411', selected: true });

    // Editing something else keeps the notes.
    expect((await patch(`/addresses/${id}`, { label: 'Flat' })).json().address.notes).toBe('Gate code 4411');
    expect((await patch(`/addresses/${id}`, { notes: 'Key under the blue pot' })).json().address.notes).toBe('Key under the blue pot');
    // Blank notes are none.
    expect((await patch(`/addresses/${id}`, { notes: '   ' })).json().address.notes).toBeNull();
    expect((await patch(`/addresses/${id}`, { notes: null })).json().address.notes).toBeNull();
    expect((await get('/addresses')).json().addresses).toEqual([expect.objectContaining({ id, notes: null })]);

    const plain = await post('/addresses', { address: '5 Unter den Linden', postcode: '10117' });
    expect(plain.json().address.notes).toBeNull();
  });

  it('refuses notes that are too long', async () => {
    const tooLong = 'x'.repeat(MAX_ADDRESS_NOTES + 1);
    expect((await post('/addresses', { address: '12 Linden Street', postcode: '10115', notes: tooLong })).statusCode).toBe(400);
    const id = (await post('/addresses', { address: '12 Linden Street', postcode: '10115', notes: 'x'.repeat(MAX_ADDRESS_NOTES) })).json().address
      .id as string;
    expect((await patch(`/addresses/${id}`, { notes: tooLong })).statusCode).toBe(400);
    expect((await patch(`/addresses/${id}`, { notes: 42 })).statusCode).toBe(400);
  });
});

describe('Personal information', () => {
  it('saves the first and last name and the language, trimmed', async () => {
    const saved = await patch('/account/personal', { firstName: '  Anna ', lastName: ' Meier ', language: 'en' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ user: expect.objectContaining({ firstName: 'Anna', lastName: 'Meier' }), language: 'en' });
    expect((await get('/auth/me')).json().user).toMatchObject({ firstName: 'Anna', lastName: 'Meier' });

    // Leaving the last name out keeps it; a blank one removes it.
    expect((await patch('/account/personal', { firstName: 'Anna' })).json().user.lastName).toBe('Meier');
    expect((await patch('/account/personal', { firstName: 'Anna', lastName: '  ' })).json().user.lastName).toBeNull();
    expect((await patch('/account/personal', { firstName: 'Anna', lastName: null })).json().user.lastName).toBeNull();
  });

  it('checks the name and only takes languages the app has texts for', async () => {
    const refused = [
      {},
      { firstName: '' },
      { firstName: '   ' },
      { firstName: 'x'.repeat(61) },
      { firstName: 'Anna', lastName: 'x'.repeat(61) },
      { firstName: 'Anna', language: 'fr' },
      { firstName: 'Anna', language: 'EN' },
      { firstName: 'Anna', email: 'anna@example.com' },
    ];
    for (const body of refused) {
      expect((await patch('/account/personal', body)).statusCode).toBe(400);
    }
    expect((await get('/auth/me')).json().user.firstName).toBe('Sara');
    // Only signed-in customers (and pros booking for themselves) have it.
    expect((await call(t, 'PATCH', '/account/personal', { body: { firstName: 'Anna' } })).statusCode).toBe(401);
  });

  it('tells the app the language, the languages it may offer and the support contact', async () => {
    expect((await get('/account/settings')).json()).toEqual({ language: 'en', languages: [...LANGUAGES], support: { email: null, phone: null } });
    expect(LANGUAGES).toEqual(['en', 'de', 'sq']);
    expect((await call(t, 'GET', '/account/settings')).statusCode).toBe(401);
  });

  it('saves the language on its own, sends it with the account, and only takes English, German and Albanian (D110)', async () => {
    expect((await get('/auth/me')).json().user.language).toBe('en');
    for (const language of ['de', 'sq', 'en', 'sq']) {
      const saved = await patch('/account/language', { language });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ user: expect.objectContaining({ language }), language });
    }
    expect((await get('/auth/me')).json().user.language).toBe('sq');
    expect((await get('/account/settings')).json().language).toBe('sq');
    for (const body of [{}, { language: 'fr' }, { language: 'DE' }, { language: 'de', firstName: 'Anna' }]) {
      expect((await patch('/account/language', body)).statusCode).toBe(400);
    }
    expect((await call(t, 'PATCH', '/account/language', { body: { language: 'de' } })).statusCode).toBe(401);
    // A pro sets it too, from the pro Profile.
    const pro = await signIn(t, '+4915100000009', 'pro', 'Daniel');
    expect((await patch('/account/language', { language: 'de' }, pro)).json().language).toBe('de');
  });
});

describe('Become a pro', () => {
  it('turns the same account into a pro with a fresh application, once', async () => {
    const id = (await get('/auth/me')).json().user.id as string;
    await post('/addresses', { address: '12 Linden Street', postcode: '10115' });

    const became = await post('/account/become-pro');
    expect(became.statusCode).toBe(200);
    expect(became.json().user).toMatchObject({ id, role: 'pro', firstName: 'Sara' });
    // The same session now opens the pro app, starting with the application.
    expect((await get('/pro/profile')).json().profile).toMatchObject({ status: 'draft' });
    // What the customer had stays theirs (D64).
    expect((await get('/addresses')).json().addresses).toHaveLength(1);

    expect((await post('/account/become-pro')).json()).toEqual({ error: 'already_pro' });
  });

  it('is not for pros or the team', async () => {
    const pro = await signIn(t, '+4915100000002', 'pro', 'Daniel');
    expect((await post('/account/become-pro', undefined, pro)).json()).toEqual({ error: 'already_pro' });
    expect((await call(t, 'POST', '/account/become-pro')).statusCode).toBe(401);
  });
});
