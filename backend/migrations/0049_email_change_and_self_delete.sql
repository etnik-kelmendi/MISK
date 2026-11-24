-- Up Migration
-- D97: a signed-in customer or pro changes (or adds) the email of their account. The new address only
-- replaces the old one once the link sent to it is opened. Only a hash of the link's token is kept; a row
-- is removed when it is confirmed, cancelled or replaced, so each link works once. One open change per account.
CREATE TABLE email_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  new_email text NOT NULL CHECK (char_length(new_email) BETWEEN 3 AND 254),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_changes_one_open_idx ON email_changes (user_id);
CREATE INDEX email_changes_expires_idx ON email_changes (expires_at);

-- The person's own email changes and their own "Delete account" appear in the account's activity log on the
-- Users page (admin_id is null), like their phone changes (D87).
ALTER TABLE user_admin_actions DROP CONSTRAINT user_admin_actions_action_check;
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_actions_action_check
  CHECK (action IN ('messaged', 'suspended', 'reinstated', 'deleted', 'phone_added', 'phone_changed', 'phone_removed',
                    'email_added', 'email_changed', 'closed_own_account'));

-- Down Migration
DELETE FROM user_admin_actions WHERE action IN ('email_added', 'email_changed', 'closed_own_account');
ALTER TABLE user_admin_actions DROP CONSTRAINT user_admin_actions_action_check;
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_actions_action_check
  CHECK (action IN ('messaged', 'suspended', 'reinstated', 'deleted', 'phone_added', 'phone_changed', 'phone_removed'));
DROP TABLE email_changes;
