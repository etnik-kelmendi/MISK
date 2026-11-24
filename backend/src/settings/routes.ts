import type { FastifyInstance } from 'fastify';
import { ADMIN_ROLES, ACCESS, type AdminRole } from '../auth/access.js';
import { normalizeEmail } from '../auth/admin-accounts.js';
import { currentUser } from '../auth/guard.js';
import { recordAttempt } from '../auth/sessions.js';
import { FREE_CANCEL_HOURS, CHARGE_DELAY_HOURS } from '../bookings/lifecycle.js';
import { isValidPostcode, normalizePostcode, POSTCODE_INPUT_MAX_LENGTH } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { CHANNELS, CONFIGURABLE, enqueue, fitBody, MAX_ATTEMPTS, subjectOf, type ConfigurableKind } from '../notifications/outbox.js';
import { normalizePhone } from '../notifications/phone.js';
import { nextPayoutDate, PAYOUT_INTERVALS, type PayoutInterval } from '../payments/payouts.js';
import { marketToday } from '../pros/checks.js';
import { ACTIVITY_FEED, logActivity } from './activity.js';
import { issueAlertsEmailable, setupChecklist } from './setup.js';

/** The commission MISK keeps, as the Settings slider allows it (D33). */
export const COMMISSION_MIN = 10;
export const COMMISSION_MAX = 30;
/** An invite link lets the new teammate choose a password within this many days. */
export const INVITE_DAYS = 7;
/**
 * Two zones' centres are at least this far apart; closer means one zone's coordinates were reused. Zones may
 * otherwise lie anywhere in the world (D84 removed the 100 km limit of D47).
 */
export const ZONE_MIN_DISTANCE_KM = 0.1;
/** Test messages per admin per 15 minutes, so a stuck button cannot flood a phone or an inbox. */
const MAX_TESTS = 20;
/** The email check used across the API. */
const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_LENGTH = 254;

// Checked again with isValidPostcode after normalizing, so this only keeps out very long input.
const postcodeParams = {
  type: 'object',
  required: ['code'],
  properties: { code: { type: 'string', minLength: 1, maxLength: POSTCODE_INPUT_MAX_LENGTH } },
} as const;

/** One sample text per message, for "Send me a test". */
function sampleText(kind: ConfigurableKind, timezone: string): string {
  const when = formatSlot(new Date(Date.now() + 24 * 3600 * 1000), timezone);
  const samples: Record<ConfigurableKind, string> = {
    booking_confirmed: messages.bookingConfirmed('Lawn mowing', when),
    booking_reminder: messages.bookingReminder('Lawn mowing', when),
    pro_on_the_way: messages.proOnTheWay('Daniel'),
    extra_requested: messages.extraRequested('Trim the front hedge', 2000),
    job_completed: messages.jobCompleted('Lawn mowing'),
    rating_request: messages.ratingRequest('Daniel'),
    job_offer: messages.jobOffer('Lawn mowing', when, 3731),
    payout_sent: messages.payoutSent(3731, 'Lawn mowing', 'Friday'),
  };
  return `[Test] ${samples[kind]}`;
}

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const today = () => marketToday(ctx.config.timezone);

  // ---------- Fees & payments ----------

  async function loadSettings() {
    const found = await pool.query<{
      serviceFeeCents: number;
      proSharePct: number;
      payoutInterval: PayoutInterval;
      noShowFeeCents: number;
      waitingCapMinutes: number;
    }>(
      `SELECT service_fee_cents AS "serviceFeeCents", pro_share_pct AS "proSharePct", payout_interval AS "payoutInterval",
         no_show_fee_cents AS "noShowFeeCents", waiting_cap_minutes AS "waitingCapMinutes"
       FROM settings`,
    );
    const s = onlyRow(found);
    return {
      ...s,
      commissionPct: 100 - s.proSharePct,
      nextPayoutOn: nextPayoutDate(s.payoutInterval, today()),
      freeCancelHours: FREE_CANCEL_HOURS,
      chargeDelayHours: CHARGE_DELAY_HOURS,
    };
  }

  app.get('/admin/settings', { preHandler: guards.admin }, async () => ({ settings: await loadSettings() }));

  app.patch<{
    Body: { serviceFeeCents?: number; commissionPct?: number; payoutInterval?: PayoutInterval; noShowFeeCents?: number; waitingCapMinutes?: number };
  }>(
    '/admin/settings',
    {
      preHandler: guards.admin,
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            serviceFeeCents: { type: 'integer', minimum: 0, maximum: 10_000 },
            commissionPct: { type: 'integer', minimum: COMMISSION_MIN, maximum: COMMISSION_MAX },
            payoutInterval: { type: 'string', enum: PAYOUT_INTERVALS },
            // The call-out fee a customer who is not home pays the pro, and the most waiting at a door paid (D94).
            noShowFeeCents: { type: 'integer', minimum: 0, maximum: 10_000 },
            waitingCapMinutes: { type: 'integer', minimum: 0, maximum: 120 },
          },
        },
      },
    },
    // Fee and commission are copied onto each booking when it is made, so changes only affect new bookings.
    async (request) => {
      const { serviceFeeCents, commissionPct, payoutInterval, noShowFeeCents, waitingCapMinutes } = request.body;
      const adminId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        const before = onlyRow(
          await client.query<{ fee: number; share: number; interval: PayoutInterval; noShowFee: number; waitingCap: number }>(
            `SELECT service_fee_cents AS fee, pro_share_pct AS share, payout_interval AS interval,
               no_show_fee_cents AS "noShowFee", waiting_cap_minutes AS "waitingCap" FROM settings FOR UPDATE`,
          ),
        );
        await client.query(
          `UPDATE settings SET service_fee_cents = COALESCE($1, service_fee_cents),
             pro_share_pct = COALESCE($2, pro_share_pct), payout_interval = COALESCE($3, payout_interval),
             no_show_fee_cents = COALESCE($4, no_show_fee_cents), waiting_cap_minutes = COALESCE($5, waiting_cap_minutes), updated_at = now()`,
          [
            serviceFeeCents ?? null,
            commissionPct === undefined ? null : 100 - commissionPct,
            payoutInterval ?? null,
            noShowFeeCents ?? null,
            waitingCapMinutes ?? null,
          ],
        );
        if (noShowFeeCents !== undefined && noShowFeeCents !== before.noShowFee) {
          await logActivity(client, { adminId, area: 'fees', action: 'no_show_fee', details: { from: before.noShowFee, to: noShowFeeCents } });
        }
        if (waitingCapMinutes !== undefined && waitingCapMinutes !== before.waitingCap) {
          await logActivity(client, {
            adminId,
            area: 'fees',
            action: 'waiting_cap',
            details: { from: before.waitingCap, to: waitingCapMinutes },
          });
        }
        if (serviceFeeCents !== undefined && serviceFeeCents !== before.fee) {
          await logActivity(client, { adminId, area: 'fees', action: 'service_fee', details: { from: before.fee, to: serviceFeeCents } });
        }
        if (commissionPct !== undefined && commissionPct !== 100 - before.share) {
          await logActivity(client, {
            adminId,
            area: 'fees',
            action: 'commission',
            details: { from: 100 - before.share, to: commissionPct },
          });
        }
        if (payoutInterval !== undefined && payoutInterval !== before.interval) {
          await logActivity(client, { adminId, area: 'fees', action: 'payout_interval', details: { from: before.interval, to: payoutInterval } });
        }
      });
      request.log.info({ event: 'settings_changed', by: adminId, serviceFeeCents, commissionPct, payoutInterval, noShowFeeCents, waitingCapMinutes });
      return { settings: await loadSettings() };
    },
  );

  // ---------- Service area ----------

  app.get('/admin/zones', { preHandler: guards.admin }, async () => {
    const [zones, elsewhere] = await Promise.all([
      pool.query(
        `SELECT z.code, z.name, z.lat, z.lng, z.active AS live,
           (SELECT count(*)::int FROM pro_profiles p JOIN postcodes home ON home.code = p.home_postcode
              WHERE p.status = 'approved' AND distance_km(home.lat, home.lng, z.lat, z.lng) <= p.radius_km) AS pros,
           round((SELECT count(*) FROM bookings b WHERE b.postcode = z.code AND b.created_at > now() - interval '28 days'
              AND b.status <> 'awaiting_payment' AND b.cancelled_by IS DISTINCT FROM 'system') / 4.0, 1)::float AS "bookingsPerWeek",
           (SELECT count(*)::int FROM waitlist w WHERE w.postcode = z.code AND w.notified_at IS NULL) AS waiting
         FROM postcodes z ORDER BY z.code`,
      ),
      // People waiting in postcodes that are not a zone yet, so the team sees where demand is.
      pool.query(
        `SELECT w.postcode, count(*)::int AS waiting FROM waitlist w
         WHERE w.notified_at IS NULL AND NOT EXISTS (SELECT 1 FROM postcodes z WHERE z.code = w.postcode)
         GROUP BY w.postcode ORDER BY waiting DESC, w.postcode LIMIT 50`,
      ),
    ]);
    return { zones: zones.rows, elsewhere: elsewhere.rows };
  });

  // Adds or edits a zone. A new zone starts on the waitlist unless `live` is given.
  app.put<{ Params: { code: string }; Body: { name: string; lat: number; lng: number; live?: boolean } }>(
    '/admin/zones/:code',
    {
      preHandler: guards.admin,
      schema: {
        params: postcodeParams,
        body: {
          type: 'object',
          required: ['name', 'lat', 'lng'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            live: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const code = normalizePostcode(request.params.code);
      if (!isValidPostcode(code)) {
        throw badRequest('invalid_postcode');
      }
      const { name, lat, lng, live } = request.body;
      // The same number in both fields (including 0, 0) is a copy-paste mistake, never a real centre point.
      if (lat === lng) {
        throw badRequest('coordinates_identical');
      }
      const saved = await withTransaction(pool, async (client) => {
        const nearest = await client.query<{ km: number }>(
          `SELECT distance_km(lat, lng, $2, $3) AS km FROM postcodes WHERE code <> $1 ORDER BY km LIMIT 1`,
          [code, lat, lng],
        );
        const km = nearest.rows[0]?.km;
        // Two postcodes never share a centre: the coordinates were copied from the other zone.
        if (km !== undefined && km < ZONE_MIN_DISTANCE_KM) {
          throw badRequest('coordinates_taken');
        }
        const result = await client.query<{ inserted: boolean }>(
          `INSERT INTO postcodes (code, name, lat, lng, active) VALUES ($1, $2, $3, $4, COALESCE($5, false))
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng
           RETURNING code, name, lat, lng, active AS live, (xmax = 0) AS inserted`,
          [code, name.trim(), lat, lng, live ?? null],
        );
        const row = onlyRow(result);
        await logActivity(client, {
          adminId: currentUser(request).id,
          area: 'zones',
          action: row.inserted ? 'zone_added' : 'zone_edited',
          details: { code, name: name.trim() },
        });
        return row;
      });
      return { zone: saved };
    },
  );

  // Opens a zone and tells everyone waiting there.
  app.post<{ Params: { code: string } }>(
    '/admin/zones/:code/go-live',
    { preHandler: guards.admin, schema: { params: postcodeParams } },
    async (request) => {
      const code = normalizePostcode(request.params.code);
      const notified = await withTransaction(pool, async (client) => {
        const updated = await client.query('UPDATE postcodes SET active = true WHERE code = $1 AND NOT active', [code]);
        if (!updated.rowCount) {
          const exists = await client.query('SELECT 1 FROM postcodes WHERE code = $1', [code]);
          throw exists.rowCount ? conflict('zone_already_live') : notFound('zone_not_found');
        }
        const waiting = await client.query<{ user_id: string }>(
          'UPDATE waitlist SET notified_at = now() WHERE postcode = $1 AND notified_at IS NULL RETURNING user_id',
          [code],
        );
        for (const { user_id } of waiting.rows) {
          await enqueue(client, user_id, 'waitlist_open', messages.waitlistOpen(code));
        }
        await logActivity(client, {
          adminId: currentUser(request).id,
          area: 'zones',
          action: 'zone_live',
          details: { code, notified: waiting.rowCount ?? 0 },
        });
        return waiting.rowCount ?? 0;
      });
      request.log.info({ event: 'zone_live', code, notified, by: currentUser(request).id });
      return { notified };
    },
  );

  // Closes a zone for new customers, who then join its waitlist. Booked jobs there go ahead.
  app.post<{ Params: { code: string } }>(
    '/admin/zones/:code/pause',
    { preHandler: guards.admin, schema: { params: postcodeParams } },
    async (request) => {
      const code = normalizePostcode(request.params.code);
      await withTransaction(pool, async (client) => {
        const updated = await client.query('UPDATE postcodes SET active = false WHERE code = $1 AND active', [code]);
        if (!updated.rowCount) {
          const exists = await client.query('SELECT 1 FROM postcodes WHERE code = $1', [code]);
          throw exists.rowCount ? conflict('zone_already_paused') : notFound('zone_not_found');
        }
        await logActivity(client, { adminId: currentUser(request).id, area: 'zones', action: 'zone_paused', details: { code } });
      });
      request.log.info({ event: 'zone_paused', code, by: currentUser(request).id });
      return { paused: true };
    },
  );

  // A customer whose postcode MISK does not serve (yet) asks to be told when it does.
  app.post<{ Body: { postcode: string } }>(
    '/waitlist',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['postcode'],
          additionalProperties: false,
          properties: { postcode: { type: 'string', minLength: 2, maxLength: POSTCODE_INPUT_MAX_LENGTH } },
        },
      },
    },
    async (request, reply) => {
      const postcode = normalizePostcode(request.body.postcode);
      if (!isValidPostcode(postcode)) {
        throw badRequest('invalid_postcode');
      }
      const served = await pool.query('SELECT 1 FROM postcodes WHERE code = $1 AND active', [postcode]);
      if (served.rowCount) {
        throw conflict('postcode_served');
      }
      await pool.query('INSERT INTO waitlist (postcode, user_id) VALUES ($1, $2) ON CONFLICT (postcode, user_id) DO NOTHING', [
        postcode,
        currentUser(request).id,
      ]);
      return reply.code(201).send({ postcode });
    },
  );

  // ---------- Notifications ----------

  async function loadNotifications(adminId: string) {
    const [rows, me] = await Promise.all([
      pool.query<{ kind: ConfigurableKind; push: boolean; sms: boolean; email: boolean }>(
        'SELECT kind, push, sms, email FROM notification_settings',
      ),
      pool.query<{ contactPhone: string | null; email: string | null }>(
        'SELECT contact_phone AS "contactPhone", email FROM users WHERE id = $1',
        [adminId],
      ),
    ]);
    const myPush = await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [adminId]);
    return {
      messages: CONFIGURABLE.map(({ kind, audience }) => {
        const row = rows.rows.find((r) => r.kind === kind);
        return { kind, audience, push: row?.push ?? false, sms: row?.sms ?? false, email: row?.email ?? false };
      }),
      // Which channels the server can actually send on; the others are saved but held as not sent.
      ready: { push: ctx.config.push !== null, sms: ctx.config.twilio !== null, email: ctx.deliverEmail !== null },
      me: { phone: me.rows[0]?.contactPhone ?? null, email: me.rows[0]?.email ?? null, push: Boolean(myPush.rowCount) },
    };
  }

  app.get('/admin/notifications', { preHandler: guards.admin }, async (request) => loadNotifications(currentUser(request).id));

  app.patch<{ Params: { kind: ConfigurableKind }; Body: { push?: boolean; sms?: boolean; email?: boolean } }>(
    '/admin/notifications/:kind',
    {
      preHandler: guards.admin,
      schema: {
        params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: CONFIGURABLE.map((c) => c.kind) } } },
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: { push: { type: 'boolean' }, sms: { type: 'boolean' }, email: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const { kind } = request.params;
      await withTransaction(pool, async (client) => {
        const before = onlyRow(
          await client.query<{ push: boolean; sms: boolean; email: boolean }>(
            'SELECT push, sms, email FROM notification_settings WHERE kind = $1 FOR UPDATE',
            [kind],
          ),
        );
        await client.query(
          `UPDATE notification_settings SET push = COALESCE($2, push), sms = COALESCE($3, sms), email = COALESCE($4, email),
             updated_at = now() WHERE kind = $1`,
          [kind, request.body.push ?? null, request.body.sms ?? null, request.body.email ?? null],
        );
        for (const channel of CHANNELS) {
          const value = request.body[channel];
          if (value !== undefined && value !== before[channel]) {
            await logActivity(client, {
              adminId: currentUser(request).id,
              area: 'notifications',
              action: value ? 'channel_on' : 'channel_off',
              details: { message: kind, channel },
            });
          }
        }
      });
      return loadNotifications(currentUser(request).id);
    },
  );

  // Sends one message, on its chosen channels, to the admin's own phone, email and devices.
  app.post<{ Params: { kind: ConfigurableKind } }>(
    '/admin/notifications/:kind/test',
    {
      preHandler: guards.admin,
      schema: {
        params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: CONFIGURABLE.map((c) => c.kind) } } },
      },
    },
    async (request) => {
      const adminId = currentUser(request).id;
      const { kind } = request.params;
      if ((await recordAttempt(pool, `test-message:${adminId}`, MAX_TESTS)).overLimit) {
        throw new ApiError(429, 'too_many_attempts');
      }
      const chosen = onlyRow(
        await pool.query<{ push: boolean; sms: boolean; email: boolean }>('SELECT push, sms, email FROM notification_settings WHERE kind = $1', [kind]),
      );
      const me = onlyRow(
        await pool.query<{ phone: string | null; email: string | null }>('SELECT contact_phone AS phone, email FROM users WHERE id = $1', [adminId]),
      );
      const text = fitBody(sampleText(kind, ctx.config.timezone));
      const sent = { push: 0, sms: false, email: false };
      await withTransaction(pool, async (client) => {
        if (chosen.sms && me.phone) {
          await client.query("INSERT INTO notifications (user_id, channel, phone, kind, body) VALUES (NULL, 'sms', $1, 'admin_test', $2)", [
            me.phone,
            text,
          ]);
          sent.sms = true;
        }
        if (chosen.email && me.email) {
          await client.query(
            "INSERT INTO notifications (user_id, channel, email, subject, kind, body) VALUES (NULL, 'email', $1, $2, 'admin_test', $3)",
            [me.email, `[Test] ${subjectOf(kind)}`, text],
          );
          sent.email = true;
        }
        if (chosen.push) {
          const pushed = await client.query(
            `INSERT INTO notifications (user_id, channel, push_subscription_id, kind, body)
             SELECT $1, 'push', id, 'admin_test', $2 FROM push_subscriptions WHERE user_id = $1`,
            [adminId, text],
          );
          sent.push = pushed.rowCount ?? 0;
        }
        await logActivity(client, { adminId, area: 'notifications', action: 'test_sent', details: { message: kind, ...sent } });
      });
      return {
        sent,
        // What stopped a chosen channel, so the page can say what to add.
        missing: [
          ...(chosen.sms && !me.phone ? ['phone'] : []),
          ...(chosen.email && !me.email ? ['email'] : []),
          ...(chosen.push && sent.push === 0 ? ['push'] : []),
        ],
      };
    },
  );

  /** Where a test email stands, as the outbox records it, for the admin who sent it. */
  async function testEmailStatus(id: string, adminId: string) {
    const found = await pool.query<{ id: string; to: string; status: string; attempts: number; error: string | null; updatedAt: Date }>(
      `SELECT id, email AS "to", status, attempts, error, updated_at AS "updatedAt" FROM notifications
       WHERE id = $1 AND user_id = $2 AND kind = 'admin_test' AND channel = 'email'`,
      [id, adminId],
    );
    const row = found.rows[0];
    if (!row) {
      throw notFound('test_email_not_found');
    }
    // A failed email is tried again a few times; only after the last try has it really failed.
    const finalFailure = row.status === 'not_configured' || (row.status === 'failed' && row.attempts >= MAX_ATTEMPTS);
    return {
      id: row.id,
      to: row.to,
      status: row.status as 'queued' | 'sending' | 'sent' | 'failed' | 'not_configured',
      done: row.status === 'sent' || finalFailure,
      error: row.status === 'failed' ? (row.error ?? '').slice(0, 300) : null,
      updatedAt: row.updatedAt,
    };
  }

  // Sends one message as a test email to any address the admin types, through the normal outbox, so the
  // email really goes out with the email sender and its result can be followed (D84).
  app.post<{ Params: { kind: ConfigurableKind }; Body: { email: string } }>(
    '/admin/notifications/:kind/test-email',
    {
      preHandler: guards.admin,
      schema: {
        params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: CONFIGURABLE.map((c) => c.kind) } } },
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          // A little room for spaces around the address, which are removed before the check.
          properties: { email: { type: 'string', minLength: 3, maxLength: MAX_EMAIL_LENGTH + 20 } },
        },
      },
    },
    async (request, reply) => {
      const adminId = currentUser(request).id;
      const { kind } = request.params;
      const to = normalizeEmail(request.body.email);
      if (to.length > MAX_EMAIL_LENGTH || !EMAIL_FORMAT.test(to)) {
        throw badRequest('invalid_email');
      }
      if (!ctx.deliverEmail) {
        // Saying so now is more honest than queueing an email that can never leave.
        throw new ApiError(503, 'email_not_set_up');
      }
      // The same limit as the other tests, so typing many addresses cannot be used to send mail in bulk.
      if ((await recordAttempt(pool, `test-message:${adminId}`, MAX_TESTS)).overLimit) {
        throw new ApiError(429, 'too_many_attempts');
      }
      const text = fitBody(sampleText(kind, ctx.config.timezone));
      const id = await withTransaction(pool, async (client) => {
        const queued = await client.query<{ id: string }>(
          `INSERT INTO notifications (user_id, channel, email, subject, kind, body) VALUES ($1, 'email', $2, $3, 'admin_test', $4)
           RETURNING id`,
          [adminId, to, `[Test] ${subjectOf(kind)}`, text],
        );
        // The activity log already shows teammates' emails (email_changed), and only admins can read it.
        await logActivity(client, { adminId, area: 'notifications', action: 'test_email_sent', details: { message: kind, email: to } });
        return onlyRow(queued).id;
      });
      request.log.info({ event: 'test_email_queued', notificationId: id, kind, by: adminId });
      return reply.code(202).send({ email: await testEmailStatus(id, adminId) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/notifications/test-email/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => ({ email: await testEmailStatus(request.params.id, currentUser(request).id) }),
  );

  // ---------- Push on this device (anyone signed in) ----------

  app.get('/push/key', async () => ({ publicKey: ctx.config.push?.publicKey ?? null }));

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/push/subscriptions',
    {
      preHandler: guards.signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['endpoint', 'keys'],
          additionalProperties: false,
          properties: {
            endpoint: { type: 'string', pattern: '^https://', maxLength: 1000 },
            keys: {
              type: 'object',
              required: ['p256dh', 'auth'],
              additionalProperties: false,
              properties: { p256dh: { type: 'string', maxLength: 200 }, auth: { type: 'string', maxLength: 100 } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { endpoint, keys } = request.body;
      // A browser belongs to whoever signed in on it last.
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [currentUser(request).id, endpoint, keys.p256dh, keys.auth],
      );
      return reply.code(201).send({ subscribed: true });
    },
  );

  app.post<{ Body: { endpoint: string } }>(
    '/push/subscriptions/remove',
    {
      preHandler: guards.signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['endpoint'],
          additionalProperties: false,
          properties: { endpoint: { type: 'string', maxLength: 1000 } },
        },
      },
    },
    async (request, reply) => {
      await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [request.body.endpoint, currentUser(request).id]);
      return reply.code(204).send();
    },
  );

  // ---------- Team & access ----------

  const TEAM = `SELECT u.id, u.username, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
      u.admin_role AS role, u.created_at AS "createdAt", u.invited_at AS "invitedAt",
      u.disabled_at IS NOT NULL AS disabled, (u.admin_requested_at IS NOT NULL AND u.admin_approved_at IS NULL) AS pending,
      (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS "lastActive"
    FROM users u WHERE u.role = 'admin'`;

  app.get('/admin/team/members', { preHandler: guards.admin }, async () => {
    const result = await pool.query(`${TEAM} ORDER BY u.disabled_at NULLS FIRST, "lastActive" DESC NULLS LAST, u.username`);
    return { members: result.rows, access: ACCESS };
  });

  app.patch<{ Params: { id: string }; Body: { role: AdminRole } }>(
    '/admin/team/:id/role',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { type: 'string', enum: ADMIN_ROLES } } },
      },
    },
    async (request) => {
      const adminId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        // Lock the admins so two people cannot each take away the other's last admin role.
        const admins = await client.query<{ id: string; admin_role: AdminRole; pending: boolean }>(
          `SELECT id, admin_role, (admin_requested_at IS NOT NULL AND admin_approved_at IS NULL) AS pending
           FROM users WHERE role = 'admin' AND disabled_at IS NULL ORDER BY id FOR UPDATE`,
        );
        const member = admins.rows.find((a) => a.id === request.params.id);
        if (!member) {
          throw notFound();
        }
        // Someone still waiting for approval cannot sign in, so they never count as the remaining admin.
        const fullAdmins = admins.rows.filter((a) => a.admin_role === 'admin' && !a.pending);
        if (member.admin_role === 'admin' && request.body.role !== 'admin' && fullAdmins.length <= 1) {
          throw conflict('last_admin');
        }
        await client.query('UPDATE users SET admin_role = $2 WHERE id = $1', [member.id, request.body.role]);
        if (member.admin_role !== request.body.role) {
          await logActivity(client, {
            adminId,
            area: 'team',
            action: 'role_changed',
            details: { memberId: member.id, from: member.admin_role, to: request.body.role },
          });
        }
      });
      const member = await pool.query(`${TEAM} AND u.id = $1`, [request.params.id]);
      return { member: member.rows[0] };
    },
  );

  // The admin's own phone, for test messages. Admins never sign in with a phone.
  app.patch<{ Body: { phone: string | null } }>(
    '/admin/me/phone',
    {
      preHandler: guards.admin,
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          additionalProperties: false,
          properties: { phone: { anyOf: [{ type: 'string', maxLength: 30 }, { type: 'null' }] } },
        },
      },
    },
    async (request) => {
      const phone = request.body.phone === null || request.body.phone.trim() === '' ? null : normalizePhone(request.body.phone);
      if (request.body.phone && request.body.phone.trim() !== '' && !phone) {
        throw badRequest('invalid_phone');
      }
      await pool.query('UPDATE users SET contact_phone = $2 WHERE id = $1', [currentUser(request).id, phone]);
      return { phone };
    },
  );

  // The Setup checklist (D98): which optional production settings are set, yes or no only, never a value, and
  // whether a pro's issue report can be emailed to anyone. Under Team & access, which only full admins open.
  app.get('/admin/team/setup', { preHandler: guards.admin }, async () => ({
    checklist: setupChecklist(ctx.config),
    issueAlertsEmailable: await issueAlertsEmailable(pool, ctx.config.support.email),
  }));

  // Who did what and when, across the whole control panel, newest first.
  app.get<{ Querystring: { before?: string } }>(
    '/admin/activity',
    {
      preHandler: guards.admin,
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { before: { type: 'string', format: 'date-time' } } },
      },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT f.id, f.area, f.action, f.details, f."createdAt", f.subject, COALESCE(u.email, u.username) AS "adminName",
           concat_ws(' ', u.first_name, u.last_name) AS "adminFullName"
         FROM (${ACTIVITY_FEED}) f LEFT JOIN users u ON u.id = f.admin_id
         WHERE (f.admin_id IS NOT NULL OR f.area = 'team') AND ($1::timestamptz IS NULL OR f."createdAt" < $1)
         ORDER BY f."createdAt" DESC, f.id DESC LIMIT 100`,
        [request.query.before ?? null],
      );
      return { activity: result.rows };
    },
  );

}
