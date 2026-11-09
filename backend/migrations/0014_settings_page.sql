-- Up Migration
-- The Settings page: payouts schedule, late cancellation, tips, service zones and their waitlist,
-- notification channels (push, SMS, email), team roles, and one activity log for the team's changes.

-- ---------- Fees & payments ----------
ALTER TABLE settings
  ADD COLUMN payout_interval text NOT NULL DEFAULT 'weekly' CHECK (payout_interval IN ('weekly', 'biweekly', 'monthly'));

-- The schedule last set on the pro's Stripe account, and the last payout MISK started by itself
-- (Stripe has no "every two weeks", so those payouts are started by MISK).
ALTER TABLE pro_profiles
  ADD COLUMN payout_schedule text CHECK (payout_schedule IN ('weekly', 'biweekly', 'monthly')),
  ADD COLUMN last_manual_payout_on date;

ALTER TABLE bookings
  -- Cancelled by the customer less than 24 hours before the start: the full price is charged.
  ADD COLUMN late_cancel boolean NOT NULL DEFAULT false,
  ADD COLUMN reminder_sent_at timestamptz,
  ADD COLUMN rating_requested_at timestamptz;

CREATE TABLE tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 20000),
  -- The commission at the time of the tip decides the split, like for jobs.
  pro_share_pct integer NOT NULL CHECK (pro_share_pct BETWEEN 50 AND 95),
  pro_cents integer NOT NULL CHECK (pro_cents >= 0),
  payment_intent_id text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Service area ----------
-- A served postcode is a zone: active = live (green), not active = waitlist (yellow).
CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  postcode text NOT NULL CHECK (postcode ~ '^[A-Z0-9][A-Z0-9 -]{1,9}$'),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  UNIQUE (postcode, user_id)
);
CREATE INDEX waitlist_postcode_idx ON waitlist (postcode) WHERE notified_at IS NULL;

-- ---------- Notifications ----------
-- Which channels each message goes out on. Messages not listed here go by SMS, or email without a phone.
CREATE TABLE notification_settings (
  kind text PRIMARY KEY,
  push boolean NOT NULL,
  sms boolean NOT NULL,
  email boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_settings (kind, push, sms, email) VALUES
  ('booking_confirmed', true, true, true),
  ('booking_reminder', true, true, false),
  ('pro_on_the_way', true, true, false),
  ('extra_requested', true, true, false),
  ('job_completed', true, true, true),
  ('rating_request', true, true, true),
  ('job_offer', true, true, false),
  ('payout_sent', true, true, true);

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (char_length(endpoint) <= 1000 AND endpoint LIKE 'https://%'),
  p256dh text NOT NULL CHECK (char_length(p256dh) <= 200),
  auth text NOT NULL CHECK (char_length(auth) <= 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- One outbox row per channel. SMS rows have a phone, email rows an address, push rows a subscription.
ALTER TABLE notifications
  ADD COLUMN channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email', 'push')),
  ADD COLUMN email text,
  ADD COLUMN subject text CHECK (char_length(subject) <= 200),
  ADD COLUMN push_subscription_id uuid REFERENCES push_subscriptions (id) ON DELETE CASCADE,
  ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_target CHECK (
  (channel = 'sms' AND phone IS NOT NULL)
  OR (channel = 'email' AND email IS NOT NULL)
  OR (channel = 'push' AND push_subscription_id IS NOT NULL)
);
-- Messages that are not for a customer or pro (an admin's test) have no user.
ALTER TABLE notifications ALTER COLUMN user_id DROP NOT NULL;

-- ---------- Team & access ----------
ALTER TABLE users
  ADD COLUMN admin_role text CHECK (admin_role IN ('admin', 'operations', 'support', 'finance')),
  -- An admin's own phone for test messages; admins sign in with a password, never with a phone.
  ADD COLUMN contact_phone text CHECK (contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  ADD COLUMN invited_at timestamptz;
UPDATE users SET admin_role = 'admin' WHERE role = 'admin';
ALTER TABLE users ADD CONSTRAINT users_admin_role_only CHECK ((role = 'admin') = (admin_role IS NOT NULL));
-- Admins created without a team role (by the sign-up request, the server command or older code) get
-- "admin"; everyone else never has one.
CREATE FUNCTION users_default_admin_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'admin' AND NEW.admin_role IS NULL THEN
    NEW.admin_role := 'admin';
  ELSIF NEW.role IS DISTINCT FROM 'admin' THEN
    NEW.admin_role := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_default_admin_role BEFORE INSERT OR UPDATE OF role, admin_role ON users
  FOR EACH ROW EXECUTE FUNCTION users_default_admin_role();

-- What the team changed on the Settings page, with who and when.
CREATE TABLE admin_activity (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES users (id) ON DELETE SET NULL,
  area text NOT NULL CHECK (area IN ('fees', 'zones', 'notifications', 'team')),
  action text NOT NULL CHECK (char_length(action) <= 60),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_activity_created_idx ON admin_activity (created_at DESC);

-- Down Migration
DROP TABLE admin_activity;
DROP TRIGGER users_default_admin_role ON users;
DROP FUNCTION users_default_admin_role;
ALTER TABLE users DROP CONSTRAINT users_admin_role_only;
ALTER TABLE users DROP COLUMN invited_at, DROP COLUMN contact_phone, DROP COLUMN admin_role;
DELETE FROM notifications WHERE channel <> 'sms' OR user_id IS NULL;
ALTER TABLE notifications ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE notifications DROP CONSTRAINT notifications_channel_target;
ALTER TABLE notifications DROP COLUMN push_subscription_id, DROP COLUMN subject, DROP COLUMN email, DROP COLUMN channel,
  ALTER COLUMN phone SET NOT NULL;
DROP TABLE push_subscriptions;
DROP TABLE notification_settings;
DROP TABLE waitlist;
DROP TABLE tips;
ALTER TABLE bookings DROP COLUMN rating_requested_at, DROP COLUMN reminder_sent_at, DROP COLUMN late_cancel;
ALTER TABLE pro_profiles DROP COLUMN last_manual_payout_on, DROP COLUMN payout_schedule;
ALTER TABLE settings DROP COLUMN payout_interval;
