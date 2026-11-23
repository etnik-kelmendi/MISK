import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { onlyRow, withTransaction, type Queryable } from '../db.js';
import { clearAttempts, createSession, deleteExpiredRows, recordAttempt, type User } from './sessions.js';

export const CODE_LENGTH = 6;
export const CODE_TTL_SECONDS = 10 * 60;
export const MAX_GUESSES_PER_CODE = 5;
export const MAX_CODES_PER_PHONE = 3;
export const MAX_CODES_PER_IP = 10;
export const MAX_VERIFICATIONS_PER_IP = 30;
/** Codes one account may ask for to add or change its phone number, per 15 minutes (D87). */
export const MAX_PHONE_CHANGE_CODES_PER_ACCOUNT = 5;

/** Delivers a code to a phone. Throws when it cannot. */
export type CodeDelivery = (phone: string, code: string) => Promise<void>;

/**
 * What a texted code is for. A sign-in code signs in (or creates) the account of that phone; an add_phone
 * code adds the phone to one signed-in account (D87). Neither works as the other.
 */
type Purpose = { purpose: 'sign_in'; userId: null } | { purpose: 'add_phone'; userId: string };

function hashCode(codeId: string, code: string): Buffer {
  return createHash('sha256').update(`${codeId}:${code}`).digest();
}

export type StartResult = { outcome: 'sent' } | { outcome: 'too_many_attempts' };

/**
 * Texts a new code after the rate limits. The limits per phone and per IP are shared by both purposes, so
 * nobody can text a stranger's phone more often by switching between them.
 */
async function issueCode(
  pool: Pool,
  deliver: CodeDelivery,
  input: { phone: string; ip: string; extraLimit?: { key: string; limit: number } } & Purpose,
): Promise<StartResult> {
  await deleteExpiredRows(pool);
  const byPhone = await recordAttempt(pool, `code:${input.phone}`, MAX_CODES_PER_PHONE);
  const byIp = await recordAttempt(pool, `code-ip:${input.ip}`, MAX_CODES_PER_IP);
  const byExtra = input.extraLimit ? await recordAttempt(pool, input.extraLimit.key, input.extraLimit.limit) : null;
  if (byPhone.overLimit || byIp.overLimit || byExtra?.overLimit) {
    return { outcome: 'too_many_attempts' };
  }

  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
  await withTransaction(pool, async (client) => {
    // Only the newest code of its kind works, so an older text can no longer be used.
    await client.query(
      `UPDATE sign_in_codes SET consumed_at = now()
       WHERE phone = $1 AND purpose = $2 AND user_id IS NOT DISTINCT FROM $3 AND consumed_at IS NULL`,
      [input.phone, input.purpose, input.userId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO sign_in_codes (id, phone, code_hash, expires_at, purpose, user_id)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6)`,
      [id, input.phone, hashCode(id, code), CODE_TTL_SECONDS, input.purpose, input.userId],
    );
  });
  await deliver(input.phone, code);
  return { outcome: 'sent' };
}

type CheckResult = { outcome: 'match'; codeId: string } | { outcome: 'invalid_code' } | { outcome: 'too_many_attempts' };

/** Counts one guess at the newest code of its kind and says whether it matched. */
async function checkCode(pool: Pool, input: { phone: string; code: string; ip: string } & Purpose): Promise<CheckResult> {
  const byIp = await recordAttempt(pool, `verify-ip:${input.ip}`, MAX_VERIFICATIONS_PER_IP);
  if (byIp.overLimit) {
    return { outcome: 'too_many_attempts' };
  }

  // Counting the guess before comparing means parallel guesses cannot exceed the limit.
  const guessed = await pool.query<{ id: string; code_hash: Buffer; attempts: number }>(
    `UPDATE sign_in_codes SET attempts = attempts + 1
     WHERE id = (
       SELECT id FROM sign_in_codes
       WHERE phone = $1 AND purpose = $2 AND user_id IS NOT DISTINCT FROM $3
         AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING id, code_hash, attempts`,
    [input.phone, input.purpose, input.userId],
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
  return { outcome: 'match', codeId: row.id };
}

/** Uses up a matched code; false when a parallel request used it first. */
async function consumeCode(db: Queryable, codeId: string): Promise<boolean> {
  const consumed = await db.query('UPDATE sign_in_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [codeId]);
  return Boolean(consumed.rowCount);
}

export function startPhoneSignIn(pool: Pool, deliver: CodeDelivery, input: { phone: string; ip: string }): Promise<StartResult> {
  return issueCode(pool, deliver, { ...input, purpose: 'sign_in', userId: null });
}

export type VerifyResult =
  | { outcome: 'success'; user: User; token: string; isNew: boolean }
  | { outcome: 'invalid_code' }
  | { outcome: 'too_many_attempts' }
  | { outcome: 'account_disabled' }
  | { outcome: 'account_suspended'; userId: string };

export async function verifyPhoneSignIn(
  pool: Pool,
  input: { phone: string; code: string; ip: string },
): Promise<VerifyResult> {
  const checked = await checkCode(pool, { ...input, purpose: 'sign_in', userId: null });
  if (checked.outcome !== 'match') {
    return checked;
  }

  return withTransaction(pool, async (client) => {
    if (!(await consumeCode(client, checked.codeId))) {
      return { outcome: 'invalid_code' } as const;
    }
    const upserted = await client.query<User & { disabled: boolean; suspended: boolean; isNew: boolean }>(
      `INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING id, role, phone, username, email, first_name AS "firstName", last_name AS "lastName",
                 disabled_at IS NOT NULL AS disabled, suspended_at IS NOT NULL AS suspended, (xmax = 0) AS "isNew"`,
      [input.phone],
    );
    const { disabled, suspended, isNew, ...user } = onlyRow(upserted);
    if (disabled) {
      return { outcome: 'account_disabled' } as const;
    }
    // Said only after the right code, so it never reveals anything about a phone the caller does not hold.
    if (suspended) {
      return { outcome: 'account_suspended', userId: user.id } as const;
    }
    await clearAttempts(client, [`code:${input.phone}`]);
    return { outcome: 'success', user, token: await createSession(client, user.id), isNew } as const;
  });
}

/**
 * Texts a code to a phone number a signed-in account wants to add or change to (D87). The answer does not
 * say whether another account uses the number; that is only said after the right code proves the phone is
 * the caller's.
 */
export function startPhoneChange(
  pool: Pool,
  deliver: CodeDelivery,
  input: { userId: string; phone: string; ip: string },
): Promise<StartResult> {
  return issueCode(pool, deliver, {
    phone: input.phone,
    ip: input.ip,
    purpose: 'add_phone',
    userId: input.userId,
    extraLimit: { key: `phone-change:${input.userId}`, limit: MAX_PHONE_CHANGE_CODES_PER_ACCOUNT },
  });
}

export type PhoneChangeResult =
  | { outcome: 'success'; previous: string | null }
  | { outcome: 'invalid_code' }
  | { outcome: 'too_many_attempts' }
  | { outcome: 'phone_taken' };

/** Puts the phone on the account once the code texted to it is right. */
export async function verifyPhoneChange(
  pool: Pool,
  input: { userId: string; phone: string; code: string; ip: string },
): Promise<PhoneChangeResult> {
  const checked = await checkCode(pool, { phone: input.phone, code: input.code, ip: input.ip, purpose: 'add_phone', userId: input.userId });
  if (checked.outcome !== 'match') {
    return checked;
  }
  return withTransaction(pool, async (client) => {
    if (!(await consumeCode(client, checked.codeId))) {
      return { outcome: 'invalid_code' } as const;
    }
    // Another account already signs in with it (closed accounts keep no phone): the two are never merged,
    // and nothing about the other account is said.
    const other = await client.query('SELECT 1 FROM users WHERE phone = $1 AND id <> $2', [input.phone, input.userId]);
    if (other.rowCount) {
      return { outcome: 'phone_taken' } as const;
    }
    const before = await client.query<{ phone: string | null }>('SELECT phone FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
    const previous = onlyRow(before).phone;
    // The unique index still guards a race with a sign-in creating an account for this phone meanwhile;
    // the route turns that into phone_taken.
    await client.query('UPDATE users SET phone = $2 WHERE id = $1', [input.userId, input.phone]);
    await clearAttempts(client, [`code:${input.phone}`, `phone-change:${input.userId}`]);
    return { outcome: 'success', previous } as const;
  });
}
