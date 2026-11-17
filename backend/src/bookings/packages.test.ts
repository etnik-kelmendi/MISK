import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  resetDatabase,
  seedMarket,
  signIn,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { packagePrice } from '../catalogue/pricing.js';

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
});

const get = (url: string) => call(t, 'GET', url, { cookie: customer });
const post = (url: string, body: unknown) => call(t, 'POST', url, { cookie: customer, body });

async function freeSlot(query: string) {
  const response = await get(`/availability?${query}&postcode=10115`);
  expect(response.statusCode).toBe(200);
  const slot = (response.json().slots as { startsAt: string; endsAt: string; available: boolean }[]).find((s) => s.available);
  if (!slot) throw new Error('No free slot');
  return slot;
}

const booking = (serviceIds: string[], startsAt: string) => ({ serviceIds, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt });

describe('packages: several services in one visit (D68)', () => {
  it('prices the services together with 10% off, books the whole length, and keeps each service', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const slot = await freeSlot(`serviceIds=${market.mowing},${market.hedge}`);
    // 60 + 90 minutes in one visit.
    expect(new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()).toBe(150 * 60_000);

    const created = await post('/bookings', booking([market.mowing, market.hedge], slot.startsAt));
    expect(created.statusCode).toBe(201);
    const b = created.json().booking;
    expect(b.serviceName).toBe('Lawn mowing + Hedge trimming');
    expect(b.services.map((s: { name: string }) => s.name)).toEqual(['Lawn mowing', 'Hedge trimming']);
    expect(b.priceCents).toBe(9360); // (4550 + 5850) - 10%
    expect(b.packageDiscountCents).toBe(1040);
    expect(b.totalCents).toBe(9360 + b.feeCents);
  });

  it('lists each service and the discount on the receipt of a finished package job', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const slot = await freeSlot(`serviceIds=${market.mowing},${market.hedge}`);
    const id = (await post('/bookings', booking([market.mowing, market.hedge], slot.startsAt))).json().booking.id as string;
    const offer = (await call(t, 'GET', '/pro/offers', { cookie: pro.cookie })).json().offers[0] as { id: string; serviceName: string };
    expect(offer.serviceName).toBe('Lawn mowing + Hedge trimming');
    await call(t, 'POST', `/pro/offers/${offer.id}/accept`, { cookie: pro.cookie });
    for (const status of ['on_the_way', 'working']) await call(t, 'POST', `/pro/jobs/${id}/status`, { cookie: pro.cookie, body: { status } });
    await upload(t, `/pro/jobs/${id}/photos`, pro.cookie, FILES.png);
    expect((await call(t, 'POST', `/pro/jobs/${id}/complete`, { cookie: pro.cookie })).statusCode).toBe(200);

    const receipt = (await get(`/bookings/${id}/receipt`)).json().receipt;
    expect(receipt.lines.map((l: { kind: string; cents: number }) => [l.kind, l.cents])).toEqual([
      ['job', 4550],
      ['job', 5850],
      ['discount', -1040],
      ['fee', receipt.lines[3].cents],
    ]);
    expect(receipt.totalCents).toBe(9360 + receipt.lines[3].cents);
    const pdf = (await get(`/bookings/${id}/receipt.pdf`)).rawPayload.toString('latin1');
    // "-€10.40" with the euro sign as its WinAnsi code.
    expect(pdf).toContain('(-\\20010.40)');
  });

  it('still books one service the old way, without a discount', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const slot = await freeSlot(`serviceId=${market.mowing}`);
    const created = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: slot.startsAt });
    expect(created.statusCode).toBe(201);
    expect(created.json().booking).toMatchObject({ serviceName: 'Lawn mowing', priceCents: 4550, packageDiscountCents: 0 });
    expect(created.json().booking.services).toHaveLength(1);
  });

  it('refuses services of two trades, the same service twice, or none', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const slot = await freeSlot(`serviceId=${market.mowing}`);
    expect((await post('/bookings', booking([market.mowing, market.leak], slot.startsAt))).json()).toEqual({ error: 'services_mixed_trades' });
    expect((await post('/bookings', booking([market.mowing, market.mowing], slot.startsAt))).statusCode).toBe(400);
    expect((await post('/bookings', booking([], slot.startsAt))).statusCode).toBe(400);
    expect((await get(`/availability?serviceIds=${market.mowing},${market.leak}&postcode=10115`)).json()).toEqual({ error: 'services_mixed_trades' });
    expect((await get('/availability?postcode=10115')).json()).toEqual({ error: 'invalid_services' });
  });
});

describe('package price', () => {
  const service = (priceCents: number, durationMinutes: number) => ({
    priceCents,
    durationMinutes,
    sizeSmallPct: 80,
    sizeMediumPct: 100,
    sizeLargePct: 130,
    pricing: 'fixed' as const,
  });

  it('takes 10% off two or more services and adds up their length', () => {
    expect(packagePrice([service(3500, 60)], 'M')).toEqual({ lines: [3500], discountCents: 0, jobCents: 3500, durationMinutes: 60 });
    expect(packagePrice([service(3500, 60), service(4500, 90)], 'L')).toEqual({
      lines: [4550, 5850],
      discountCents: 1040,
      jobCents: 9360,
      durationMinutes: 150,
    });
  });
});
