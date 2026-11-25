import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, type Market, type TestContext } from '../../test/helpers.js';
import type { EmailMessage } from '../notifications/email.js';
import { dataExportTick, maskEmail } from './data-export.js';

/** D100: "Download my data". */

let t: TestContext;
let market: Market;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  market = await seedMarket(t.pool);
});

const request = (cookie: string) => call(t, 'POST', '/account/data-export', { cookie });
const status = async (cookie: string) => (await call(t, 'GET', '/account/data-export', { cookie })).json().export;

async function proWithJob() {
  const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
  await t.pool.query("UPDATE users SET email = 'daniel@example.com', last_name = 'Keller' WHERE id = $1", [pro.proId]);
  await t.pool.query("UPDATE pro_profiles SET home_address = 'Hidden Lane 7', about = 'Gardener' WHERE user_id = $1", [pro.proId]);
  const customer = await t.pool.query<{ id: string }>(
    "INSERT INTO users (phone, role, first_name, last_name, email) VALUES ('+4915100000001', 'customer', 'Sara', 'Meier', 'sara@example.com') RETURNING id",
  );
  const booking = await t.pool.query<{ id: string }>(
    `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode,
       starts_at, ends_at, status, price_cents, fee_cents, pro_share_pct, pro_id, completed_at)
     VALUES ($1, $2, $3, 'Lawn mowing', 'M', '12 Secret Street', '10115', now() - interval '3 days', now() - interval '3 days' + interval '1 hour',
       'completed', 4000, 290, 82, $4, now() - interval '3 days')
     RETURNING id`,
    [customer.rows[0]?.id, market.mowing, market.gardening, pro.proId],
  );
  await t.pool.query("INSERT INTO ratings (booking_id, pro_id, customer_id, stars, review, reply, replied_at) VALUES ($1, $2, $3, 5, 'Great', 'Thanks!', now())", [
    booking.rows[0]?.id,
    pro.proId,
    customer.rows[0]?.id,
  ]);
  return pro;
}

describe('Download my data', () => {
  it('queues one copy a day to the account email address, and the worker emails it as a JSON file', async () => {
    const pro = await proWithJob();
    expect(await status(pro.cookie)).toEqual({ email: 'd•••@example.com', pending: false, requestedAt: null, sentAt: null, nextAllowedAt: null });

    const queued = await request(pro.cookie);
    expect(queued.statusCode).toBe(202);
    expect(queued.json().export).toMatchObject({ email: 'd•••@example.com', pending: true, nextAllowedAt: expect.any(String) });
    expect((await request(pro.cookie)).json().error).toBe('export_limited');

    const sent: EmailMessage[] = [];
    expect(await dataExportTick(t.pool, async (message) => void sent.push(message), t.deps.log)).toBe(1);
    expect(await dataExportTick(t.pool, async (message) => void sent.push(message), t.deps.log)).toBe(0);
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email?.to).toBe('daniel@example.com');
    expect(email?.subject).toBe('Your data at MISK');
    const file = email?.attachments?.[0];
    expect(file).toMatchObject({ filename: 'misk-my-data.json', contentType: 'application/json' });
    const data = JSON.parse(file?.content.toString('utf8') ?? '{}');
    expect(data.account).toMatchObject({ firstName: 'Daniel', lastName: 'Keller', email: 'daniel@example.com' });
    expect(data.asPro.profile).toMatchObject({ homeAddress: 'Hidden Lane 7', about: 'Gardener' });
    expect(data.asPro.trades).toEqual([expect.objectContaining({ trade: 'Gardening', approved: true })]);
    expect(data.asPro.jobs[0]).toMatchObject({ service: 'Lawn mowing', customerFirstName: 'Sara', postcode: '10115' });
    expect(data.asPro.ratingsReceived[0]).toMatchObject({ stars: 5, review: 'Great', reply: 'Thanks!', customerFirstName: 'Sara' });
    // Other people by first name only: no customer's last name, phone, email or street.
    const text = file?.content.toString('utf8') ?? '';
    for (const secret of ['Meier', 'sara@example.com', '+4915100000001', '12 Secret Street']) {
      expect(text).not.toContain(secret);
    }
    expect(await status(pro.cookie)).toMatchObject({ pending: false, sentAt: expect.any(String) });
  });

  it('asks for an email address first, works for customers too, and waits without a mail server', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
    expect(await status(customer)).toMatchObject({ email: null });
    expect((await request(customer)).json().error).toBe('email_missing');
    const id = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id;
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE id = $1", [id]);
    expect((await request(customer)).statusCode).toBe(202);
    expect(await dataExportTick(t.pool, null, t.deps.log)).toBe(0);
    expect(await status(customer)).toMatchObject({ pending: true, email: 's•••@example.com' });
    expect((await call(t, 'POST', '/account/data-export', {})).statusCode).toBe(401);
  });

  it('marks a copy failed after repeated send errors, so the person can ask again', async () => {
    const pro = await proWithJob();
    await request(pro.cookie);
    const failing = async () => {
      throw new Error('mail server down');
    };
    for (let i = 0; i < 5; i += 1) expect(await dataExportTick(t.pool, failing, t.deps.log)).toBe(0);
    expect(await status(pro.cookie)).toMatchObject({ pending: false, nextAllowedAt: null });
    expect((await request(pro.cookie)).statusCode).toBe(202);
  });

  it('masks an address to its first letter and domain', () => {
    expect(maskEmail('daniel.k@example.com')).toBe('d•••@example.com');
  });
});
