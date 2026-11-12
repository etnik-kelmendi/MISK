import { hashPassword } from '../auth/passwords.js';
import { reminderTick, ratingRequestTick } from '../bookings/reminders.js';
import { dispatchOnce, enqueue } from '../notifications/outbox.js';
import { nextPayoutDate, payoutScheduleTick } from '../payments/payouts.js';
import {
  approvedPro,
  call,
  createTestContext,
  resetDatabase,
  seedMarket,
  sessionCookie,
  signIn,
  signInAdmin,
  type Market,
  type TestContext,
} from '../../test/helpers.js';

let t: TestContext;
let market: Market;
let admin: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  t.emails.length = 0;
  market = await seedMarket(t.pool);
  admin = await signInAdmin(t);
});

const get = (url: string, cookie = admin) => call(t, 'GET', url, { cookie });
const patch = (url: string, body: unknown, cookie = admin) => call(t, 'PATCH', url, { cookie, body });
const post = (url: string, body?: unknown, cookie = admin) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });
const activity = async () => (await get('/admin/activity')).json().activity as { area: string; action: string; details: Record<string, unknown> }[];
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

async function teammate(username: string, role: string) {
  await t.pool.query(`INSERT INTO users (username, password_hash, role, admin_role) VALUES ($1, $2, 'admin', $3)`, [
    username,
    await hashPassword('a long teammate password'),
    role,
  ]);
  const response = await call(t, 'POST', '/auth/admin/login', { body: { username, password: 'a long teammate password' } });
  return sessionCookie(response);
}

describe('fees and payments', () => {
  it('sets the service fee, the commission between 10% and 30%, and the payout interval, and logs each change', async () => {
    const before = (await get('/admin/settings')).json().settings;
    expect(before).toMatchObject({ serviceFeeCents: 290, commissionPct: 18, proSharePct: 82, payoutInterval: 'weekly', freeCancelHours: 24 });
    const saved = await patch('/admin/settings', { serviceFeeCents: 350, commissionPct: 20, payoutInterval: 'monthly' });
    expect(saved.json().settings).toMatchObject({ serviceFeeCents: 350, commissionPct: 20, proSharePct: 80, payoutInterval: 'monthly' });
    for (const commissionPct of [9, 31]) {
      expect((await patch('/admin/settings', { commissionPct })).statusCode).toBe(400);
    }
    expect((await patch('/admin/settings', { proSharePct: 80 })).statusCode).toBe(400);
    expect((await activity()).map((a) => [a.action, a.details])).toEqual([
      ['payout_interval', { from: 'weekly', to: 'monthly' }],
      ['commission', { from: 18, to: 20 }],
      ['service_fee', { from: 290, to: 350 }],
    ]);
    const app = (await t.app.inject({ method: 'GET', url: '/catalogue' })).json();
    expect(app).toMatchObject({ feeCents: 350, proSharePct: 80 });
  });

  it('applies a new fee and commission to new bookings only', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const customer = await signIn(t, '+4915100000001', 'customer');
    const book = async () => {
      const slots = (await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=10115`, { cookie: customer })).json().slots;
      const startsAt = slots.filter((s: { available: boolean }) => s.available).at(-1).startsAt;
      return (
        await call(t, 'POST', '/bookings', {
          cookie: customer,
          body: { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt },
        })
      ).json().booking;
    };
    const first = await book();
    await patch('/admin/settings', { serviceFeeCents: 500, commissionPct: 25 });
    const second = await book();
    const shares = await t.pool.query<{ id: string; fee_cents: number; pro_share_pct: number }>(
      'SELECT id, fee_cents, pro_share_pct FROM bookings',
    );
    const byId = Object.fromEntries(shares.rows.map((r) => [r.id, [r.fee_cents, r.pro_share_pct]]));
    expect(byId[first.id]).toEqual([290, 82]);
    expect(byId[second.id]).toEqual([500, 75]);
  });

  it('works out the next payout day for each interval', () => {
    // 2026-11-09 is a Monday.
    expect(nextPayoutDate('weekly', '2026-11-09')).toBe('2026-11-13');
    expect(nextPayoutDate('weekly', '2026-11-13')).toBe('2026-11-13');
    // Every other Friday counted from Friday 2 January 2026: 20 November, 4 December, …
    expect(nextPayoutDate('biweekly', '2026-11-09')).toBe('2026-11-20');
    expect(nextPayoutDate('biweekly', '2026-11-21')).toBe('2026-12-04');
    expect(nextPayoutDate('monthly', '2026-11-09')).toBe('2026-12-01');
    expect(nextPayoutDate('monthly', '2026-12-15')).toBe('2027-01-01');
    expect(nextPayoutDate('monthly', '2026-12-01')).toBe('2026-12-01');
  });

  it('sets every pro’s Stripe payout schedule to match, and shows the pro their next payout', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect(await payoutScheduleTick(t.deps)).toBe(1);
    expect([...t.fake.schedules.values()]).toEqual(['weekly']);
    await patch('/admin/settings', { payoutInterval: 'biweekly' });
    await payoutScheduleTick(t.deps);
    expect([...t.fake.schedules.values()]).toEqual(['manual']);
    expect(await payoutScheduleTick(t.deps)).toBeLessThanOrEqual(1);

    const mine = (await get('/pro/payouts', pro.cookie)).json().payouts;
    expect(mine).toMatchObject({ sharePct: 82, interval: 'biweekly', bankLast4: '3000', nextPayoutOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});

describe('service area', () => {
  it('shows live zones with pros and bookings a week, and waitlist zones with people waiting', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await post('/admin/zones/10117', undefined);
    const added = await call(t, 'PUT', '/admin/zones/10178', { cookie: admin, body: { name: 'Alexanderplatz', lat: 52.5219, lng: 13.4132 } });
    expect(added.json().zone).toMatchObject({ code: '10178', live: false });
    const customer = await signIn(t, '+4915100000001', 'customer');
    expect((await post('/waitlist', { postcode: ' 10178 ' }, customer)).statusCode).toBe(201);
    expect((await post('/waitlist', { postcode: '10178' }, customer)).statusCode).toBe(201);
    expect((await post('/waitlist', { postcode: '99999' }, customer)).statusCode).toBe(201);
    expect((await post('/waitlist', { postcode: '10115' }, customer)).json()).toEqual({ error: 'postcode_served' });

    const zones = (await get('/admin/zones')).json();
    const live = zones.zones.find((z: { code: string }) => z.code === '10115');
    expect(live).toMatchObject({ live: true, pros: 1, bookingsPerWeek: 0 });
    const waiting = zones.zones.find((z: { code: string }) => z.code === '10178');
    expect(waiting).toMatchObject({ live: false, waiting: 1, pros: 1 });
    expect(zones.elsewhere).toEqual([{ postcode: '99999', waiting: 1 }]);
  });

  it('opens a zone and tells the people waiting, and pausing sends new customers to the waitlist', async () => {
    await call(t, 'PUT', '/admin/zones/10178', { cookie: admin, body: { name: 'Alexanderplatz', lat: 52.5219, lng: 13.4132 } });
    const customer = await signIn(t, '+4915100000001', 'customer');
    await post('/waitlist', { postcode: '10178' }, customer);
    const opened = await post('/admin/zones/10178/go-live');
    expect(opened.json()).toEqual({ notified: 1 });
    const text = await t.pool.query("SELECT body FROM notifications WHERE kind = 'waitlist_open'");
    expect(text.rows[0]?.body).toContain('MISK now serves 10178');
    expect((await post('/admin/zones/10178/go-live')).json()).toEqual({ error: 'zone_already_live' });
    const listed = (await t.app.inject({ method: 'GET', url: '/postcodes' })).json().postcodes.map((p: { code: string }) => p.code);
    expect(listed).toContain('10178');

    expect((await post('/admin/zones/10178/pause')).json()).toEqual({ paused: true });
    const after = (await t.app.inject({ method: 'GET', url: '/postcodes' })).json().postcodes.map((p: { code: string }) => p.code);
    expect(after).not.toContain('10178');
    expect((await post('/waitlist', { postcode: '10178' }, customer)).statusCode).toBe(201);
    expect((await post('/admin/zones/00000/pause')).json()).toEqual({ error: 'zone_not_found' });
    expect((await activity()).map((a) => a.action)).toEqual(['zone_paused', 'zone_live', 'zone_added']);
  });
});

describe('notifications', () => {
  it('lists the eight messages with who receives them and their channels, and saves a change', async () => {
    const body = (await get('/admin/notifications')).json();
    expect(body.messages.map((m: { kind: string; audience: string }) => `${m.kind}:${m.audience}`)).toEqual([
      'booking_confirmed:customer',
      'booking_reminder:customer',
      'pro_on_the_way:customer',
      'extra_requested:customer',
      'job_completed:customer',
      'rating_request:customer',
      'job_offer:pro',
      'payout_sent:pro',
    ]);
    expect(body.ready).toEqual({ push: false, sms: false, email: true });
    const changed = await patch('/admin/notifications/job_offer', { email: true, sms: false });
    expect(changed.json().messages.find((m: { kind: string }) => m.kind === 'job_offer')).toMatchObject({ push: true, sms: false, email: true });
    expect((await patch('/admin/notifications/sign_in_code', { sms: false })).statusCode).toBe(400);
    expect((await activity()).map((a) => [a.action, a.details])).toEqual([
      ['channel_on', { message: 'job_offer', channel: 'email' }],
      ['channel_off', { message: 'job_offer', channel: 'sms' }],
    ]);
  });

  it('queues a message once per chosen channel the person can be reached on', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer');
    const id = (await get('/auth/me', customer)).json().user.id;
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE id = $1", [id]);
    await post('/push/subscriptions', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'BKey', auth: 'auth1' } }, customer);
    await enqueue(t.pool, id, 'booking_confirmed', 'Booked');
    const rows = await t.pool.query<{ channel: string }>("SELECT channel FROM notifications WHERE kind = 'booking_confirmed' ORDER BY channel");
    expect(rows.rows.map((r) => r.channel)).toEqual(['email', 'push', 'sms']);

    await patch('/admin/notifications/booking_confirmed', { push: false, sms: false, email: false });
    await t.pool.query('DELETE FROM notifications');
    expect(await enqueue(t.pool, id, 'booking_confirmed', 'Booked')).toBe(false);
    // Messages not on the Settings page go by SMS as before.
    await enqueue(t.pool, id, 'booking_rescheduled', 'Moved');
    expect((await t.pool.query("SELECT channel FROM notifications WHERE kind = 'booking_rescheduled'")).rows).toEqual([{ channel: 'sms' }]);
    // A cancelled job also goes out by push.
    await enqueue(t.pool, id, 'booking_cancelled', 'Cancelled');
    const cancelled = await t.pool.query<{ channel: string }>(
      "SELECT channel FROM notifications WHERE kind = 'booking_cancelled' ORDER BY channel",
    );
    expect(cancelled.rows.map((r) => r.channel)).toEqual(['push', 'sms']);
    // Every message is also in the person's Messages in the app.
    const inbox = (await get('/inbox', customer)).json().messages.map((m: { kind: string }) => m.kind);
    expect(inbox).toEqual(expect.arrayContaining(['booking_confirmed', 'booking_rescheduled', 'booking_cancelled']));
  });

  it('sends each channel with its own sender, and forgets a browser that no longer takes push', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer');
    const id = (await get('/auth/me', customer)).json().user.id;
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE id = $1", [id]);
    await post('/push/subscriptions', { endpoint: 'https://push.example.com/gone', keys: { p256dh: 'BKey', auth: 'auth1' } }, customer);
    await enqueue(t.pool, id, 'booking_confirmed', 'Your mowing is booked');
    const sent: string[] = [];
    const { PushGoneError } = await import('../notifications/push.js');
    await dispatchOnce(
      t.pool,
      {
        sms: async (to) => {
          sent.push(`sms:${to}`);
          return { providerId: 'SM1' };
        },
        email: async (message) => {
          sent.push(`email:${message.to}:${message.subject}`);
        },
        push: async () => {
          throw new PushGoneError('gone');
        },
      },
      silentLog,
    );
    expect(sent.sort()).toEqual(['email:sara@example.com:Your MISK booking is confirmed', 'sms:+4915100000001']);
    expect((await t.pool.query('SELECT 1 FROM push_subscriptions')).rowCount).toBe(0);
    const statuses = await t.pool.query<{ status: string }>('SELECT status FROM notifications ORDER BY channel');
    expect(statuses.rows.map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('sends the admin a test of a message to their own phone and email', async () => {
    const first = (await post('/admin/notifications/booking_confirmed/test')).json();
    expect(first).toMatchObject({ sent: { sms: false, email: false, push: 0 }, missing: ['phone', 'email', 'push'] });
    expect((await patch('/admin/me/phone', { phone: 'not a phone' })).json()).toEqual({ error: 'invalid_phone' });
    expect((await patch('/admin/me/phone', { phone: '+49 151 23456789' })).json()).toEqual({ phone: '+4915123456789' });
    await t.pool.query("UPDATE users SET email = 'me@misk.app' WHERE username = 'admin'");
    const second = (await post('/admin/notifications/booking_confirmed/test')).json();
    expect(second).toMatchObject({ sent: { sms: true, email: true }, missing: ['push'] });
    const rows = await t.pool.query<{ channel: string; phone: string | null; email: string | null; body: string }>(
      "SELECT channel, phone, email, body FROM notifications WHERE kind = 'admin_test' ORDER BY channel",
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ channel: 'email', email: 'me@misk.app', body: expect.stringContaining('[Test] MISK: your Lawn mowing') }),
      expect.objectContaining({ channel: 'sms', phone: '+4915123456789' }),
    ]);
  });
});

describe('team and access', () => {
  it('lists the team with role and last active, and lets each role open only its areas', async () => {
    const support = await teammate('support.sam', 'support');
    const finance = await teammate('finance.fay', 'finance');
    const members = (await get('/admin/team/members')).json();
    expect(members.members.find((m: { username: string }) => m.username === 'support.sam')).toMatchObject({
      role: 'support',
      lastActive: expect.any(String),
    });
    expect(members.access.finance).toEqual(['overview', 'bookings', 'fees']);

    expect((await get('/admin/bookings', support)).statusCode).toBe(200);
    expect((await get('/admin/catalogue', support)).json()).toEqual({ error: 'no_access' });
    expect((await get('/admin/settings', support)).statusCode).toBe(403);
    expect((await get('/admin/settings', finance)).statusCode).toBe(200);
    expect((await get('/admin/team/members', finance)).statusCode).toBe(403);
    expect((await get('/auth/me', support)).json().user.adminRole).toBe('support');
  });

  it('invites a teammate by email, who sets a password with the link and signs in with that role', async () => {
    const invited = await post('/admin/team/invite', { email: ' New.Person@Example.com ', firstName: 'Nora', role: 'operations' });
    expect(invited.statusCode).toBe(201);
    expect(invited.json().member).toMatchObject({ email: 'new.person@example.com', role: 'operations', invitedAt: expect.any(String) });
    expect((await post('/admin/team/invite', { email: 'new.person@example.com', role: 'support' })).json()).toEqual({ error: 'email_taken' });
    const email = t.emails.at(-1);
    expect(email?.to).toBe('new.person@example.com');
    const token = email?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
    const reset = await call(t, 'POST', '/auth/admin/reset', { body: { token, password: 'my own long password' } });
    expect(reset.statusCode).toBe(204);
    const login = await call(t, 'POST', '/auth/admin/login', { body: { username: 'new.person@example.com', password: 'my own long password' } });
    expect(login.json().user).toMatchObject({ adminRole: 'operations' });
    expect((await activity())[0]).toMatchObject({ area: 'team', action: 'invited', details: { email: 'new.person@example.com', role: 'operations' } });
  });

  it('changes roles but never takes away the last admin', async () => {
    const me = (await get('/auth/me')).json().user.id;
    expect((await patch(`/admin/team/${me}/role`, { role: 'support' })).json()).toEqual({ error: 'last_admin' });
    await teammate('second.admin', 'admin');
    const changed = await patch(`/admin/team/${me}/role`, { role: 'finance' });
    expect(changed.json().member.role).toBe('finance');
    // Now a finance member, this admin may no longer manage the team.
    expect((await get('/admin/team/members')).statusCode).toBe(403);
  });

  it('shows who did what and when across the control panel, newest first', async () => {
    await patch('/admin/settings', { serviceFeeCents: 300 });
    await call(t, 'PATCH', `/admin/services/${market.mowing}`, { cookie: admin, body: { priceCents: 3900 } });
    const feed = (await get('/admin/activity')).json().activity;
    expect(feed.map((a: { area: string; action: string; subject: string | null; adminName: string }) => [a.area, a.action, a.subject, a.adminName])).toEqual([
      ['catalogue', 'price_changed', 'Lawn mowing', 'admin'],
      ['fees', 'service_fee', null, 'admin'],
    ]);
  });
});

describe('reminders', () => {
  it('reminds customers the evening before, once, and asks for a rating after the job', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const customer = await signIn(t, '+4915100000001', 'customer');
    const customerId = (await get('/auth/me', customer)).json().user.id;
    const job = await t.pool.query<{ id: string }>(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
         status, price_cents, fee_cents, pro_share_pct, pro_id, payment_status)
       VALUES ($1, $2, $3, 'Lawn mowing', 'M', '12 Linden Street', '10115',
         ((now() AT TIME ZONE 'Europe/Berlin')::date + 1 + time '10:00') AT TIME ZONE 'Europe/Berlin',
         ((now() AT TIME ZONE 'Europe/Berlin')::date + 1 + time '11:00') AT TIME ZONE 'Europe/Berlin',
         'accepted', 4550, 290, 82, $4, 'held') RETURNING id`,
      [customerId, market.mowing, market.gardening, pro.proId],
    );
    const berlinHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const sent = await reminderTick(t.deps);
    expect(sent).toBe(berlinHour >= 18 ? 1 : 0);
    if (sent) {
      expect(await reminderTick(t.deps)).toBe(0);
    }

    await t.pool.query("UPDATE bookings SET status = 'completed', completed_at = now() - interval '3 hours' WHERE id = $1", [job.rows[0]?.id]);
    expect(await ratingRequestTick(t.deps)).toBe(1);
    expect(await ratingRequestTick(t.deps)).toBe(0);
    const text = await t.pool.query("SELECT body FROM notifications WHERE kind = 'rating_request'");
    expect(text.rows[0]?.body).toContain('how did Daniel do?');
  });
});
