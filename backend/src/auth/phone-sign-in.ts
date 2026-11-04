import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { onlyRow, withTransaction } from '../db.js';
import { clearAttempts, createSession, deleteExpiredRows, recordAttempt, type User } from './sessions.js';

export const CODE_LENGTH = 6;
export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_GUESSES_PER_CODE = 5;
export const MAX_CODES_PER_PHONE = 3;
export const MAX_CODES_PER_IP = 10;
export const MAX_VERIFICATIONS_PER_IP = 30;

/** Delivers a code to a phone. Throws when it cannot. */
export type CodeDelivery = (phone: string, code: string) => Promise<void>;

function hashCode(codeId: string, code: string): Buffer {
  return createHash('sha256').update(`${codeId}:${code}`).digest();
}

export type StartResult = { outcome: 'sent' } | { outcome: 'too_many_attempts' };

export async function startPhoneSignIn(
  pool: Pool,
  deliver: CodeDelivery,
  input: { phone: string; ip: string },
): Promise<StartResult> {
  await deleteExpiredRows(pool);
  const byPhone = await recordAttempt(pool, `code:${input.phone}`, MAX_CODES_PER_PHONE);
  const byIp = await recordAttempt(pool, `code-ip:${input.ip}`, MAX_CODES_PER_IP);
  if (byPhone.overLimit || byIp.overLimit) {
    return { outcome: 'too_many_attempts' };
  }

  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  await withTransaction(pool, async (client) => {
    // Only the newest code works, so an older text can no longer be used.
    await client.query('UPDATE sign_in_codes SET consumed_at = now() WHERE phone = $1 AND consumed_at IS NULL', [
      input.phone,
    ]);
    const id = randomUUID();
    await client.query(
      `INSERT INTO sign_in_codes (id, phone, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [id, input.phone, hashCode(id, code), CODE_TTL_SECONDS],
    );
  });
  await deliver(input.phone, code);
  return { outcome: 'sent' };
}

export type VerifyResult =
  | { outcome: 'success'; user: User; token: string; isNew: boolean }
  | { outcome: 'invalid_code' }
  | { outcome: 'too_many_attempts' }
  | { outcome: 'account_disabled' };

export async function verifyPhoneSignIn(
  pool: Pool,
  input: { phone: string; code: string; ip: string },
): Promise<VerifyResult> {
  const byIp = await recordAttempt(pool, `verify-ip:${input.ip}`, MAX_VERIFICATIONS_PER_IP);
  if (byIp.overLimit) {
    return { outcome: 'too_many_attempts' };
  }

  // Counting the guess before comparing means parallel guesses cannot exceed the limit.
  const guessed = await pool.query<{ id: string; code_hash: Buffer; attempts: number }>(
    `UPDATE sign_in_codes SET attempts = attempts + 1
     WHERE id = (
       SELECT id FROM sign_in_codes
       WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING id, code_hash, attempts`,
    [input.phone],
  );
  const row = guessed.rows[0];
  if (!row) {
    return { outcome: 'invalid_code' };
  }
  if (row.attempts > MAX_GUESSES_PER_CODE) {
    return { outcome: 'too_many_attempts' };
  }
  if (!timingSafeEqual(row.code_hash, hashCode(row.id, input.code))) {
    return { outcome: 'invalid_code' };
  }

  return withTransaction(pool, async (client) => {
    const consumed = await client.query(
      'UPDATE sign_in_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
      [row.id],
    );
    if (!consumed.rowCount) {
      return { outcome: 'invalid_code' } as const;
    }
    const upserted = await client.query<User & { disabled: boolean; isNew: boolean }>(
      `INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, role, phone, username, first_name AS "firstName",
                 disabled_at IS NOT NULL AS disabled, (xmax = 0) AS "isNew"`,
      [input.phone],
    );
    const { disabled, isNew, ...user } = onlyRow(upserted);
    if (disabled) {
      return { outcome: 'account_disabled' } as const;
    }
    await clearAttempts(client, [`code:${input.phone}`]);
    return { outcome: 'success', user, token: await createSession(client, user.id), isNew } as const;
  });
}
