import type { Queryable } from '../db.js';

/** What the team did to an account on the Users page, and the person's own phone (D87) and email changes and closing (D97). */
export type UserAction =
  | 'messaged'
  | 'suspended'
  | 'reinstated'
  | 'deleted'
  | 'phone_added'
  | 'phone_changed'
  | 'phone_removed'
  | 'email_added'
  | 'email_changed'
  | 'closed_own_account';

/** Adds a line to the account's activity log. adminId is null for a change the person made themselves. */
export async function logUserAction(db: Queryable, userId: string, adminId: string | null, action: UserAction, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO user_admin_actions (user_id, admin_id, action, details) VALUES ($1, $2, $3, $4)', [
    userId,
    adminId,
    action,
    JSON.stringify(details),
  ]);
}
