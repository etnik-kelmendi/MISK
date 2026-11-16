-- Up Migration
-- D64: a pro may also book as a customer with the same account, but never be the pro on their own job.
ALTER TABLE bookings ADD CONSTRAINT bookings_pro_is_not_customer CHECK (pro_id IS DISTINCT FROM customer_id);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pro_is_not_customer CHECK (pro_id IS DISTINCT FROM customer_id);

-- D65: the team can suspend any account (customer or pro) and close one for good. A suspended account
-- cannot sign in until it is reinstated; a closed account (disabled_at, which already blocks everything)
-- also loses its name, phone and email, while bookings and payments stay for the records.
ALTER TABLE users
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text CHECK (char_length(suspended_reason) <= 500),
  ADD COLUMN deleted_reason text CHECK (char_length(deleted_reason) <= 500);
-- A closed account keeps no way to sign in: no phone, email, username or password.
ALTER TABLE users DROP CONSTRAINT users_sign_in_method;
ALTER TABLE users ADD CONSTRAINT users_sign_in_method CHECK (
  (role = 'admin' AND username IS NOT NULL AND password_hash IS NOT NULL AND phone IS NULL)
  OR (
    (role IS NULL OR role <> 'admin') AND username IS NULL
    AND (phone IS NOT NULL OR (email IS NOT NULL AND password_hash IS NOT NULL))
    -- A password always belongs to an email address, never to a phone-only account.
    AND (password_hash IS NULL OR email IS NOT NULL)
  )
  OR (
    (role IS NULL OR role <> 'admin') AND disabled_at IS NOT NULL
    AND phone IS NULL AND email IS NULL AND username IS NULL AND password_hash IS NULL
  )
);

-- What the team did to an account on the Users page: who, what and when (shown in the activity log).
CREATE TABLE user_admin_actions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  admin_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('messaged', 'suspended', 'reinstated', 'deleted')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_admin_actions_user_idx ON user_admin_actions (user_id, id);

-- Down Migration
DROP TABLE user_admin_actions;
-- Closed accounts cannot meet the old rule, so each gets a placeholder phone that nobody can sign in with
-- (the account stays closed: disabled_at is kept).
UPDATE users SET phone = '+999' || lpad((abs(hashtext(id::text)) % 1000000000)::text, 11, '0')
WHERE disabled_at IS NOT NULL AND phone IS NULL AND email IS NULL AND (role IS NULL OR role <> 'admin');
ALTER TABLE users DROP CONSTRAINT users_sign_in_method;
ALTER TABLE users ADD CONSTRAINT users_sign_in_method CHECK (
  (role = 'admin' AND username IS NOT NULL AND password_hash IS NOT NULL AND phone IS NULL)
  OR (
    (role IS NULL OR role <> 'admin') AND username IS NULL
    AND (phone IS NOT NULL OR (email IS NOT NULL AND password_hash IS NOT NULL))
    AND (password_hash IS NULL OR email IS NOT NULL)
  )
);
ALTER TABLE users DROP COLUMN deleted_reason, DROP COLUMN suspended_reason, DROP COLUMN suspended_at;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pro_is_not_customer;
ALTER TABLE bookings DROP CONSTRAINT bookings_pro_is_not_customer;
