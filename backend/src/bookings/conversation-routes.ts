import type { FastifyInstance, FastifyReply } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { ApiError, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { recordAttempt } from '../auth/sessions.js';
import { enqueue } from '../notifications/outbox.js';
import { readSingleFile, storeUpload } from '../uploads/uploads.js';
import { loadReceipt, receiptsPdf, receiptText, type Receipt } from './receipt.js';

/**
 * The chat can be written in while the pro is booked and the job is not done yet; afterwards it stays
 * readable but is read-only (D83, replacing D67's 7 days after the job).
 */
export const CHAT_WRITABLE_STATUSES = ['accepted', 'on_the_way', 'working'];
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

const MESSAGE_COLUMNS = `id::text, sender_role AS "from", body, photo_id AS "photoId", created_at AS "createdAt", read_at AS "readAt"`;

/**
 * Chat between the customer and the pro of one booking, and the customer's receipts (D67). Messages reach
 * the other side in the app and by push, not by text: a conversation would otherwise cost an SMS each.
 * Either side can send a photo too (D83).
 */
export async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;

  /** The booking when the signed-in person is its customer (or its pro), else 404. */
  async function chatBooking(bookingId: string, userId: string, side: Side): Promise<ChatBooking> {
    const found = await pool.query<ChatBooking>(
      `SELECT id, customer_id, pro_id, service_name, (pro_id IS NOT NULL AND status = ANY($3)) AS open
       FROM bookings WHERE id = $1 AND ${side === 'customer' ? 'customer_id' : 'pro_id'} = $2`,
      [bookingId, userId, CHAT_WRITABLE_STATUSES],
    );
    const booking = found.rows[0];
    if (!booking) throw notFound();
    return booking;
  }

  async function messages(booking: ChatBooking, side: Side) {
    // Opening the chat marks what the other side wrote as read.
    // A pro sees only the messages from their own time on the job: an earlier pro's conversation with the
    // customer stays private after a cancel or reassignment. The customer sees everything.
    const scope = side === 'pro' ? 'AND pro_id = $3' : '';
    const scopeParams = side === 'pro' ? [booking.pro_id] : [];
    await pool.query(`UPDATE booking_messages SET read_at = now() WHERE booking_id = $1 AND sender_role <> $2 AND read_at IS NULL ${scope}`, [
      booking.id,
      side,
      ...scopeParams,
    ]);
    const rows = await pool.query(
      `SELECT ${MESSAGE_COLUMNS} FROM booking_messages WHERE booking_id = $1 ${side === 'pro' ? 'AND pro_id = $2' : ''} ORDER BY id`,
      [booking.id, ...scopeParams],
    );
    return { messages: rows.rows, canWrite: booking.open };
  }

  /** Saves a message (text, a photo, or both) and tells the other side, with a link to the chat (D83). */
  async function send(
    booking: ChatBooking,
    side: Side,
    senderId: string,
    senderName: string | null,
    content: { text: string | null; photo: Buffer | null },
  ) {
    const body = content.text?.trim() || null;
    const other = side === 'customer' ? booking.pro_id : booking.customer_id;
    return withTransaction(pool, async (client) => {
      // Checked again under the lock: the job may have been finished a moment ago.
      const current = await client.query<{ status: string; pro_id: string | null }>('SELECT status, pro_id FROM bookings WHERE id = $1 FOR UPDATE', [
        booking.id,
      ]);
      const row = current.rows[0];
      if (!row || !row.pro_id || !CHAT_WRITABLE_STATUSES.includes(row.status)) throw conflict('chat_closed');
      const photo = content.photo ? await storeUpload(client, ctx.storage, { ownerId: senderId, kind: 'photo', content: content.photo }) : null;
      const inserted = await client.query(
        `INSERT INTO booking_messages (booking_id, sender_id, sender_role, body, photo_id, pro_id) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${MESSAGE_COLUMNS}`,
        [booking.id, senderId, side, body, photo?.id ?? null, row.pro_id],
      );
      if (other) {
        const who = senderName ?? (side === 'customer' ? 'Your customer' : 'Your pro');
        const text = body
          ? `MISK: ${who} about ${booking.service_name}: ${body}`
          : `MISK: ${who} sent a photo about ${booking.service_name}.`;
        // The other side's way into this chat: customers and pros have their own chat pages.
        const link = side === 'customer' ? `/pro/jobs/${booking.id}/chat` : `/bookings/${booking.id}/chat`;
        await enqueue(client, other, 'chat_message', text, { channels: { push: true, sms: false, email: false }, link });
      }
      return inserted.rows[0];
    });
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
        if (!booking.open) throw conflict('chat_closed');
        const message = await send(booking, side, user.id, user.firstName, { text: request.body.body, photo: null });
        request.log.info({ event: 'chat_message_sent', bookingId: booking.id, side });
        return reply.code(201).send({ message });
      },
    );

    // A photo in the chat (D83): one JPEG or PNG of up to 8 MB, as multipart form data.
    app.post<{ Params: { id: string } }>(`${path}/photo`, { preHandler: guard, schema: { params: uuidParams } }, async (request, reply) => {
      const user = currentUser(request);
      const booking = await chatBooking(request.params.id, user.id, side);
      const photo = await readSingleFile(request);
      if (!booking.open) throw conflict('chat_closed');
      const message = await send(booking, side, user.id, user.firstName, { text: null, photo });
      request.log.info({ event: 'chat_photo_sent', bookingId: booking.id, side });
      return reply.code(201).send({ message });
    });
  }

  // ---------- Receipts ----------

  async function receiptOrThrow(bookingId: string, customerId: string): Promise<Receipt> {
    const receipt = await loadReceipt(pool, bookingId, customerId, { gateway: ctx.gateway, log: app.log });
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
        const receipt = await loadReceipt(pool, row.id, customerId, { gateway: ctx.gateway, log: app.log });
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
