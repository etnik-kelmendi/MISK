import type { FastifyInstance, FastifyReply } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { ApiError, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { recordAttempt } from '../auth/sessions.js';
import { enqueue } from '../notifications/outbox.js';
import { loadReceipt, receiptsPdf, receiptText, type Receipt } from './receipt.js';

/** The chat stays open this long after the job is done, for questions about it (D67). */
export const CHAT_DAYS_AFTER = 7;
const MESSAGE_MAX = 1000;
/** A customer can ask for the same receipt by email this often in the attempts window (15 minutes). */
const RECEIPT_EMAILS = 3;

type Side = 'customer' | 'pro';

interface ChatBooking {
  id: string;
  customer_id: string;
  pro_id: string | null;
  service_name: string;
  open: boolean;
}

/**
 * Chat between the customer and the pro of one booking, and the customer's receipts (D67). Messages reach
 * the other side in the app and by push, not by text: a conversation would otherwise cost an SMS each.
 */
export async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;

  /** The booking when the signed-in person is its customer (or its pro), else 404. */
  async function chatBooking(bookingId: string, userId: string, side: Side): Promise<ChatBooking> {
    const found = await pool.query<ChatBooking>(
      `SELECT id, customer_id, pro_id, service_name,
         (pro_id IS NOT NULL AND status IN ('accepted', 'on_the_way', 'working', 'completed')
          AND (completed_at IS NULL OR completed_at > now() - make_interval(days => $3))) AS open
       FROM bookings WHERE id = $1 AND ${side === 'customer' ? 'customer_id' : 'pro_id'} = $2`,
      [bookingId, userId, CHAT_DAYS_AFTER],
    );
    const booking = found.rows[0];
    if (!booking) throw notFound();
    return booking;
  }

  async function messages(booking: ChatBooking, side: Side) {
    // Opening the chat marks what the other side wrote as read.
    await pool.query('UPDATE booking_messages SET read_at = now() WHERE booking_id = $1 AND sender_role <> $2 AND read_at IS NULL', [
      booking.id,
      side,
    ]);
    const rows = await pool.query(
      `SELECT id::text, sender_role AS "from", body, created_at AS "createdAt", read_at AS "readAt"
       FROM booking_messages WHERE booking_id = $1 ORDER BY id`,
      [booking.id],
    );
    return { messages: rows.rows, canWrite: booking.open };
  }

  async function send(booking: ChatBooking, side: Side, senderId: string, text: string, senderName: string | null) {
    if (!booking.open) throw conflict('chat_closed');
    const body = text.trim();
    const other = side === 'customer' ? booking.pro_id : booking.customer_id;
    const saved = await withTransaction(pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO booking_messages (booking_id, sender_id, sender_role, body) VALUES ($1, $2, $3, $4)
         RETURNING id::text, sender_role AS "from", body, created_at AS "createdAt", read_at AS "readAt"`,
        [booking.id, senderId, side, body],
      );
      if (other) {
        await enqueue(client, other, 'chat_message', `MISK: ${senderName ?? (side === 'customer' ? 'Your customer' : 'Your pro')} about ${booking.service_name}: ${body}`, {
          channels: { push: true, sms: false, email: false },
        });
      }
      return inserted.rows[0];
    });
    return saved;
  }

  const messageBody = {
    type: 'object',
    required: ['body'],
    additionalProperties: false,
    properties: { body: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX, pattern: '\\S' } },
  } as const;

  for (const side of ['customer', 'pro'] as const) {
    const path = side === 'customer' ? '/bookings/:id/messages' : '/pro/jobs/:id/messages';
    const guard = side === 'customer' ? guards.customer : guards.pro;

    app.get<{ Params: { id: string } }>(path, { preHandler: guard, schema: { params: uuidParams } }, async (request) => {
      const user = currentUser(request);
      return messages(await chatBooking(request.params.id, user.id, side), side);
    });

    app.post<{ Params: { id: string }; Body: { body: string } }>(
      path,
      { preHandler: guard, schema: { params: uuidParams, body: messageBody } },
      async (request, reply) => {
        const user = currentUser(request);
        const booking = await chatBooking(request.params.id, user.id, side);
        const message = await send(booking, side, user.id, request.body.body, user.firstName);
        request.log.info({ event: 'chat_message_sent', bookingId: booking.id, side });
        return reply.code(201).send({ message });
      },
    );
  }

  // ---------- Receipts ----------

  async function receiptOrThrow(bookingId: string, customerId: string): Promise<Receipt> {
    const receipt = await loadReceipt(pool, bookingId, customerId);
    if (!receipt) throw notFound('no_receipt');
    return receipt;
  }

  function sendPdf(reply: FastifyReply, pdf: Buffer, filename: string) {
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'private, no-store')
      .send(pdf);
  }

  app.get<{ Params: { id: string } }>('/bookings/:id/receipt', { preHandler: guards.customer, schema: { params: uuidParams } }, async (request) => ({
    receipt: await receiptOrThrow(request.params.id, currentUser(request).id),
  }));

  app.get<{ Params: { id: string } }>(
    '/bookings/:id/receipt.pdf',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request, reply) => {
      const receipt = await receiptOrThrow(request.params.id, currentUser(request).id);
      return sendPdf(reply, receiptsPdf([receipt], config.timezone, `MISK receipt ${receipt.number}`), `misk-receipt-${receipt.number}.pdf`);
    },
  );

  // Every receipt of one year in one PDF, newest first ("Download all receipts").
  app.get<{ Querystring: { year?: string } }>(
    '/bookings/receipts.pdf',
    {
      preHandler: guards.customer,
      // Query values arrive as text: the year is checked as four digits and converted below.
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { year: { type: 'string', pattern: '^20[2-9][0-9]$' } } } },
    },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const year = request.query.year ? Number(request.query.year) : new Date().getUTCFullYear();
      const ids = await pool.query<{ id: string }>(
        `SELECT id FROM bookings
         WHERE customer_id = $1 AND (status = 'completed' OR (status = 'cancelled' AND late_cancel))
           AND extract(year FROM COALESCE(completed_at, starts_at) AT TIME ZONE $3) = $2
         ORDER BY COALESCE(completed_at, starts_at) DESC`,
        [customerId, year, config.timezone],
      );
      const receipts: Receipt[] = [];
      for (const row of ids.rows) {
        const receipt = await loadReceipt(pool, row.id, customerId);
        if (receipt) receipts.push(receipt);
      }
      if (receipts.length === 0) throw notFound('no_receipt');
      return sendPdf(reply, receiptsPdf(receipts, config.timezone, `MISK receipts ${year}`), `misk-receipts-${year}.pdf`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/bookings/:id/receipt/email',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request) => {
      const user = currentUser(request);
      const deliver = ctx.deliverEmail;
      if (!deliver) throw new ApiError(503, 'email_unavailable');
      if (!user.email) throw conflict('no_email');
      const receipt = await receiptOrThrow(request.params.id, user.id);
      if ((await recordAttempt(pool, `receipt:${request.params.id}`, RECEIPT_EMAILS)).overLimit) {
        throw new ApiError(429, 'too_many_attempts');
      }
      await deliver({
        to: user.email,
        subject: `Your MISK receipt ${receipt.number}`,
        text: receiptText(receipt, config.timezone),
        attachments: [
          { filename: `misk-receipt-${receipt.number}.pdf`, content: receiptsPdf([receipt], config.timezone, `MISK receipt ${receipt.number}`), contentType: 'application/pdf' },
        ],
      });
      request.log.info({ event: 'receipt_emailed', bookingId: request.params.id });
      return { sentTo: user.email };
    },
  );
}
