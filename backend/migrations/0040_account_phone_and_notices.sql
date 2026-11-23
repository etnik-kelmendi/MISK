-- Up Migration
-- D87: a signed-in customer or pro can add or change their phone number with a texted code. Those codes are
-- kept apart from sign-in codes and belong to one account, so neither kind can be used as the other.
ALTER TABLE sign_in_codes
  ADD COLUMN purpose text NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in', 'add_phone')),
  ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  ADD CONSTRAINT sign_in_codes_purpose_user CHECK ((purpose = 'add_phone') = (user_id IS NOT NULL));

-- What the team chose to tell a suspended person. The reason (suspended_reason) stays internal; this is
-- shown on their "account suspended" screen and sent with the notice.
ALTER TABLE users ADD COLUMN suspended_message text CHECK (char_length(suspended_message) <= 500);

-- The person's own phone changes appear in the account's activity log on the Users page (admin_id is null).
ALTER TABLE user_admin_actions DROP CONSTRAINT user_admin_actions_action_check;
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_actions_action_check
  CHECK (action IN ('messaged', 'suspended', 'reinstated', 'deleted', 'phone_added', 'phone_changed', 'phone_removed'));

-- Down Migration
DELETE FROM user_admin_actions WHERE action IN ('phone_added', 'phone_changed', 'phone_removed');
ALTER TABLE user_admin_actions DROP CONSTRAINT user_admin_actions_action_check;
ALTER TABLE user_admin_actions ADD CONSTRAINT user_admin_actions_action_check
  CHECK (action IN ('messaged', 'suspended', 'reinstated', 'deleted'));
ALTER TABLE users DROP COLUMN suspended_message;
DELETE FROM sign_in_codes WHERE purpose <> 'sign_in';
ALTER TABLE sign_in_codes DROP CONSTRAINT sign_in_codes_purpose_user, DROP COLUMN user_id, DROP COLUMN purpose;
