-- Up Migration
-- Every message to a customer or pro is also kept in their inbox in the app, so it reaches them even
-- without text messages or push, and they can read it again later.
CREATE TABLE inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 640),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_user_idx ON inbox (user_id, created_at DESC);
CREATE INDEX inbox_unread_idx ON inbox (user_id) WHERE read_at IS NULL;

-- A cancelled job also goes out by push, like the other job messages.
INSERT INTO notification_settings (kind, push, sms, email) VALUES ('booking_cancelled', true, true, false)
ON CONFLICT (kind) DO NOTHING;

-- Down Migration
DELETE FROM notification_settings WHERE kind = 'booking_cancelled';
DROP TABLE inbox;
