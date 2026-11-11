import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { onlyRow, type Queryable } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { currentUser } from '../auth/guard.js';
import type { User } from '../auth/sessions.js';
import { detectMime, type FileStorage, type UploadMime } from './storage.js';

export interface StoredUpload {
  id: string;
  mime: UploadMime;
}

/** Reads the one file in a multipart request. Oversized files are refused by the multipart limits. */
export async function readSingleFile(request: FastifyRequest): Promise<Buffer> {
  return (await readNamedFile(request)).content;
}

/** Keeps a file name safe to show: no folders, no control characters, at most 120 characters. */
export function cleanFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(-120);
}

/** The one file in a multipart request, with the name it had on the sender's device. */
export async function readNamedFile(request: FastifyRequest): Promise<{ content: Buffer; fileName: string }> {
  const file = await request.file();
  if (!file) {
    throw badRequest('file_missing');
  }
  const content = await file.toBuffer();
  if (content.length === 0) {
    throw badRequest('file_missing');
  }
  return { content, fileName: cleanFileName(file.filename) };
}

export async function storeUpload(
  db: Queryable,
  storage: FileStorage,
  input: { ownerId: string; kind: 'document' | 'photo'; content: Buffer },
): Promise<StoredUpload> {
  const mime = detectMime(input.content);
  const allowed: UploadMime[] = input.kind === 'photo' ? ['image/jpeg', 'image/png'] : ['image/jpeg', 'image/png', 'application/pdf'];
  if (!mime || !allowed.includes(mime)) {
    throw badRequest('file_type_not_allowed');
  }
  const key = await storage.save(input.content);
  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO uploads (owner_id, kind, mime, size_bytes, storage_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.ownerId, input.kind, mime, input.content.length, key],
    );
    return { id: onlyRow(inserted).id, mime };
  } catch (error) {
    await storage.remove(key);
    throw error;
  }
}

/**
 * Who may see a file: its owner and admins always; for a job photo also the booking's customer,
 * its assigned pro, and a pro who currently has the job on offer.
 */
async function findReadableUpload(db: Queryable, user: User, uploadId: string) {
  const result = await db.query<{ mime: string; storage_key: string }>(
    `SELECT u.mime, u.storage_key FROM uploads u
     WHERE u.id = $1 AND (
       $3 = 'admin'
       OR u.owner_id = $2
       OR EXISTS (
         SELECT 1 FROM booking_photos p JOIN bookings b ON b.id = p.booking_id
         WHERE p.upload_id = u.id AND (
           b.customer_id = $2
           -- Pros see the job's photos, but not the customer's photos of a problem they reported.
           OR (p.kind <> 'problem' AND (
             b.pro_id = $2
             OR EXISTS (SELECT 1 FROM booking_offers o WHERE o.booking_id = b.id AND o.pro_id = $2 AND o.status = 'pending')
           ))
         )
       )
     )`,
    [uploadId, user.id, user.role],
  );
  return result.rows[0] ?? null;
}

export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { id: string } }>(
    '/files/:id',
    {
      preHandler: ctx.guards.signedIn,
      schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    },
    async (request, reply) => {
      const upload = await findReadableUpload(ctx.pool, currentUser(request), request.params.id);
      if (!upload) {
        throw notFound();
      }
      const content = await ctx.storage.read(upload.storage_key);
      return reply
        .header('Content-Type', upload.mime)
        .header('Cache-Control', 'private, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'inline')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(content);
    },
  );
}
