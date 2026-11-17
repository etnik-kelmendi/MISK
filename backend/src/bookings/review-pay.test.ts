import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, type Market, type TestContext } from '../../test/helpers.js';

let t: TestContext;
let market: Market;
let customer: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
  await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
});

const get = (url: string) => call(t, 'GET', url, { cookie: customer });
const post = (url: string, body: unknown) => call(t, 'POST', url, { cookie: customer, body });

async function freeSlots() {
  const slots = (await get(`/availability?serviceIds=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
  return slots.filter((s) => s.available).map((s) => s.startsAt);
}

const book = (startsAt: string, paymentMethod?: unknown) =>
  post('/bookings', {
    serviceIds: [market.mowing],
    size: 'M',
    address: '12 Linden Street',
    postcode: '10115',
    startsAt,
    ...(paymentMethod ? { paymentMethod } : {}),
  });

describe('Review & pay (D73)', () => {
  it('lists no cards and no last choice for a first-time customer', async () => {
    expect((await get('/payment-methods')).json()).toEqual({ cards: [], cardsAvailable: true, last: null, publishableKey: null });
  });

  it('reserves the money without taking it, and starts the next booking with the same way to pay', async () => {
    const [first, second] = await freeSlots();
    if (!first || !second) throw new Error('No free slots');
    const created = await book(first);
    expect(created.statusCode).toBe(201);
    expect(created.json().booking.paymentStatus).toBe('held');
    const intent = [...t.fake.intents.values()][0];
    expect(intent?.status).toBe('held');

    const methods = (await get('/payment-methods')).json();
    expect(methods.cards).toEqual([{ id: 'pm_card_visa', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 }]);
    expect(methods.last).toEqual({ choice: 'new_card', cardId: null });

    const again = await book(second, { type: 'card', cardId: 'pm_card_visa' });
    expect(again.statusCode).toBe(201);
    expect(again.json().payment).toBeNull();
    const onCard = [...t.fake.intents.values()].find((i) => i.metadata.bookingId === again.json().booking.id);
    expect(onCard).toMatchObject({ status: 'held', paymentMethodId: 'pm_card_visa' });
    expect((await get('/payment-methods')).json().last).toEqual({ choice: 'card', cardId: 'pm_card_visa' });
  });

  it('remembers Apple Pay and Google Pay as the last choice', async () => {
    const [first] = await freeSlots();
    if (!first) throw new Error('No free slots');
    expect((await book(first, { type: 'google_pay' })).statusCode).toBe(201);
    expect((await get('/payment-methods')).json().last).toEqual({ choice: 'google_pay', cardId: null });
  });

  it('refuses a card that is not the customer\x27s, before booking anything', async () => {
    const [first] = await freeSlots();
    if (!first) throw new Error('No free slots');
    // No payment account yet: no saved card can be theirs.
    expect((await book(first, { type: 'card', cardId: 'pm_card_visa' })).json()).toEqual({ error: 'card_not_found' });
    await book(first);
    const [next] = await freeSlots();
    if (!next) throw new Error('No free slots');
    expect((await book(next, { type: 'card', cardId: 'pm_someone_else' })).json()).toEqual({ error: 'card_not_found' });
    expect((await book(next, { type: 'card' })).json()).toEqual({ error: 'card_not_found' });
    expect((await book(next, { type: 'cash' })).statusCode).toBe(400);
    const count = await t.pool.query('SELECT 1 FROM bookings');
    expect(count.rowCount).toBe(1);
  });

  it('does not count a payment that never went through as the last choice', async () => {
    t.fake.setInstantHolds(false);
    const [first] = await freeSlots();
    if (!first) throw new Error('No free slots');
    await book(first, { type: 'apple_pay' });
    expect((await get('/payment-methods')).json().last).toBeNull();
  });
});
