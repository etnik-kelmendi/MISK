-- Up Migration
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Customers and pros sign in with a phone number; admins with a username and password.
-- A phone user has no role until they choose one on first sign-in.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text CHECK (role IN ('customer', 'pro', 'admin')),
  phone text UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  username text UNIQUE CHECK (username = lower(username) AND char_length(username) BETWEEN 3 AND 254),
  password_hash text,
  first_name text CHECK (char_length(first_name) BETWEEN 1 AND 60),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_sign_in_method CHECK (
    (role = 'admin' AND username IS NOT NULL AND password_hash IS NOT NULL AND phone IS NULL)
    OR ((role IS NULL OR role <> 'admin') AND phone IS NOT NULL AND username IS NULL AND password_hash IS NULL)
  )
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Rate limiting for every sign-in path, keyed by phone, account or IP address.
CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_key_idx ON login_attempts (key, attempted_at);
CREATE INDEX login_attempts_attempted_at_idx ON login_attempts (attempted_at);

-- One-time sign-in codes. Only a hash is stored; each code allows a few guesses and then dies.
CREATE TABLE sign_in_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash bytea NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_codes_phone_idx ON sign_in_codes (phone, created_at DESC);

-- Every text message is queued here first, so nothing is lost when sending fails.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  phone text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 640),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'not_configured')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_pending_idx ON notifications (status, updated_at)
  WHERE status IN ('queued', 'sending', 'failed');

-- Down Migration
DROP TABLE notifications;
DROP TABLE sign_in_codes;
DROP TABLE login_attempts;
DROP TABLE sessions;
DROP TABLE users;
