import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { isValidPostcode, normalizePostcode, POSTCODE_INPUT_MAX_LENGTH } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction, type Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';

/** A customer keeps at most this many saved addresses (D89). */
export const MAX_ADDRESSES = 10;
export const MAX_ADDRESS_LABEL = 30;
/** Notes for the pro, e.g. a gate code (D92). */
export const MAX_ADDRESS_NOTES = 200;

export interface SavedAddress {
  id: string;
  label: string | null;
  address: string;
  postcode: string;
  /** For the pro, e.g. "Gate code 4411"; null when there are none (D92). */
  notes: string | null;
  /** The zone's name, e.g. "Mitte". */
  areaName: string;
  /** Whether MISK still serves the postcode; a zone the team paused leaves the address saved but unserved. */
  served: boolean;
  selected: boolean;
  createdAt: Date;
}

const ADDRESS_COLUMNS = `a.id, a.label, a.address, a.postcode, a.notes, pc.name AS "areaName", pc.active AS served,
  a.is_selected AS selected, a.created_at AS "createdAt"`;
const ADDRESS_FROM = 'customer_addresses a JOIN postcodes pc ON pc.code = a.postcode';

interface AddressBody {
  label?: string | null;
  address?: string;
  postcode?: string;
  notes?: string | null;
  /** Makes the new address the selected one; a customer's first address is always selected. */
  select?: boolean;
}

const addressProperties = {
  label: { anyOf: [{ type: 'string', maxLength: MAX_ADDRESS_LABEL }, { type: 'null' }] },
  address: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
  postcode: { type: 'string', minLength: 2, maxLength: POSTCODE_INPUT_MAX_LENGTH },
  notes: { anyOf: [{ type: 'string', maxLength: MAX_ADDRESS_NOTES }, { type: 'null' }] },
} as const;

/** A blank label or blank notes are none. */
function cleanLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? '';
  return trimmed ? trimmed : null;
}

/**
 * The served zone of a typed postcode (D84 format), or a 400: `postcode_invalid` for a malformed code,
 * `postcode_not_served` for one MISK does not serve (the app then offers the waiting list, D76).
 */
async function servedZone(db: Queryable, input: string): Promise<{ code: string; lat: number; lng: number }> {
  const code = normalizePostcode(input);
  if (!isValidPostcode(code)) throw badRequest('postcode_invalid');
  const found = await db.query<{ lat: number; lng: number }>('SELECT lat, lng FROM postcodes WHERE code = $1 AND active', [code]);
  const zone = found.rows[0];
  if (!zone) throw badRequest('postcode_not_served');
  return { code, ...zone };
}

/** The customer's saved addresses, oldest first, so the list does not jump when another one is selected. */
export async function listAddresses(db: Queryable, customerId: string): Promise<SavedAddress[]> {
  const result = await db.query<SavedAddress>(
    `SELECT ${ADDRESS_COLUMNS} FROM ${ADDRESS_FROM} WHERE a.customer_id = $1 ORDER BY a.created_at, a.id`,
    [customerId],
  );
  return result.rows;
}

/** The address the customer selected on Home, if they saved any. */
export async function selectedAddress(db: Queryable, customerId: string): Promise<SavedAddress | null> {
  const result = await db.query<SavedAddress>(`SELECT ${ADDRESS_COLUMNS} FROM ${ADDRESS_FROM} WHERE a.customer_id = $1 AND a.is_selected`, [
    customerId,
  ]);
  return result.rows[0] ?? null;
}

/**
 * Saves the address of a customer's first booking as their selected address, so Home shows it straight
 * away. Does nothing once they have saved any address. Call inside the booking's transaction.
 */
export async function saveFirstAddress(db: Queryable, customerId: string, address: string, postcode: string): Promise<void> {
  await db.query(
    `INSERT INTO customer_addresses (customer_id, label, address, postcode, lat, lng, is_selected)
     SELECT $1, NULL, $2, pc.code, pc.lat, pc.lng, true FROM postcodes pc
     WHERE pc.code = $3 AND NOT EXISTS (SELECT 1 FROM customer_addresses WHERE customer_id = $1)
     ON CONFLICT DO NOTHING`,
    [customerId, address, postcode],
  );
}

async function loadOwn(db: Queryable, customerId: string, id: string): Promise<SavedAddress> {
  const found = await db.query<SavedAddress>(`SELECT ${ADDRESS_COLUMNS} FROM ${ADDRESS_FROM} WHERE a.id = $1 AND a.customer_id = $2`, [
    id,
    customerId,
  ]);
  // Another customer's address answers like one that does not exist.
  const row = found.rows[0];
  if (!row) throw notFound();
  return row;
}

/** Locks the customer's address book, so two requests at once cannot pass the limit or select two addresses. */
async function lockBook(db: Queryable, customerId: string): Promise<void> {
  await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [customerId]);
}

async function selectOnly(db: Queryable, customerId: string, id: string): Promise<void> {
  await db.query('UPDATE customer_addresses SET is_selected = false, updated_at = now() WHERE customer_id = $1 AND is_selected AND id <> $2', [
    customerId,
    id,
  ]);
  await db.query('UPDATE customer_addresses SET is_selected = true, updated_at = now() WHERE id = $1 AND customer_id = $2', [id, customerId]);
}

/** Saved addresses of the signed-in customer (D89): add, edit, remove and select the one Home uses. */
export async function addressRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/addresses', { preHandler: guards.customer }, async (request) => ({
    addresses: await listAddresses(pool, currentUser(request).id),
    max: MAX_ADDRESSES,
  }));

  app.post<{ Body: AddressBody & { address: string; postcode: string } }>(
    '/addresses',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['address', 'postcode'],
          additionalProperties: false,
          properties: { ...addressProperties, select: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const body = request.body;
      const zone = await servedZone(pool, body.postcode);
      const saved = await withTransaction(pool, async (client) => {
        await lockBook(client, customerId);
        const count = onlyRow(await client.query<{ n: number }>('SELECT count(*)::int AS n FROM customer_addresses WHERE customer_id = $1', [customerId])).n;
        if (count >= MAX_ADDRESSES) throw conflict('address_limit');
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO customer_addresses (customer_id, label, address, postcode, lat, lng, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [customerId, cleanLabel(body.label), body.address.trim(), zone.code, zone.lat, zone.lng, cleanLabel(body.notes)],
        );
        const id = onlyRow(inserted).id;
        if (count === 0 || body.select) await selectOnly(client, customerId, id);
        return loadOwn(client, customerId, id);
      });
      request.log.info({ event: 'address_added', addressId: saved.id });
      return reply.code(201).send({ address: saved });
    },
  );

  app.patch<{ Params: { id: string }; Body: AddressBody }>(
    '/addresses/:id',
    {
      preHandler: guards.customer,
      schema: {
        params: uuidParams,
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: addressProperties },
      },
    },
    async (request) => {
      const customerId = currentUser(request).id;
      const body = request.body;
      const zone = body.postcode === undefined ? null : await servedZone(pool, body.postcode);
      const saved = await withTransaction(pool, async (client) => {
        await loadOwn(client, customerId, request.params.id);
        await client.query(
          `UPDATE customer_addresses SET
             label = CASE WHEN $3 THEN $4 ELSE label END,
             address = COALESCE($5, address),
             postcode = COALESCE($6, postcode), lat = COALESCE($7, lat), lng = COALESCE($8, lng),
             notes = CASE WHEN $9 THEN $10 ELSE notes END,
             updated_at = now()
           WHERE id = $1 AND customer_id = $2`,
          [
            request.params.id,
            customerId,
            body.label !== undefined,
            cleanLabel(body.label),
            body.address?.trim() ?? null,
            zone?.code ?? null,
            zone?.lat ?? null,
            zone?.lng ?? null,
            body.notes !== undefined,
            cleanLabel(body.notes),
          ],
        );
        return loadOwn(client, customerId, request.params.id);
      });
      request.log.info({ event: 'address_edited', addressId: saved.id });
      return { address: saved };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/addresses/:id/select',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const saved = await withTransaction(pool, async (client) => {
        await lockBook(client, customerId);
        await loadOwn(client, customerId, request.params.id);
        await selectOnly(client, customerId, request.params.id);
        return loadOwn(client, customerId, request.params.id);
      });
      request.log.info({ event: 'address_selected', addressId: saved.id });
      return { address: saved };
    },
  );

  // Removing the selected address selects the newest one left, so Home always has one while any exist.
  app.delete<{ Params: { id: string } }>(
    '/addresses/:id',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        await lockBook(client, customerId);
        const removed = await loadOwn(client, customerId, request.params.id);
        await client.query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [removed.id, customerId]);
        if (removed.selected) {
          await client.query(
            `UPDATE customer_addresses SET is_selected = true, updated_at = now()
             WHERE id = (SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)`,
            [customerId],
          );
        }
      });
      request.log.info({ event: 'address_removed', addressId: request.params.id });
      return reply.code(204).send();
    },
  );
}
