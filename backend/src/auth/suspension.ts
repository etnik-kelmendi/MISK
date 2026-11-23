import type { SupportContact } from '../config.js';
import type { Queryable } from '../db.js';

/**
 * The answer for a suspended account (D87): the app shows a full-page "Your account is suspended" screen
 * with what the team chose to tell the person and how to reach the team. It is only given after the
 * person proved who they are (the right password or code, or a session of theirs), so it never reveals
 * anything about an account to a stranger. The internal reason is never part of it.
 */
export interface SuspendedAnswer {
  error: 'account_suspended';
  message: string | null;
  support: SupportContact;
}

export async function suspendedAnswer(db: Queryable, support: SupportContact, userId: string): Promise<SuspendedAnswer> {
  const found = await db.query<{ message: string | null }>('SELECT suspended_message AS message FROM users WHERE id = $1', [userId]);
  return { error: 'account_suspended', message: found.rows[0]?.message ?? null, support };
}
