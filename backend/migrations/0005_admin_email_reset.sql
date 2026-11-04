-- Up Migration
-- Admins can have an email address for password recovery. Customers and pros sign in by phone code
-- and never have a password, so only admins may have one.
ALTER TABLE users ADD COLUMN email text UNIQUE
  CHECK (email = lower(email) AND char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
ALTER TABLE users ADD CONSTRAINT users_email_admin_only CHECK (email IS NULL OR role = 'admin');

-- Single-use password reset links. Only a hash of the token is stored.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- Down Migration
DROP TABLE password_resets;
ALTER TABLE users DROP CONSTRAINT users_email_admin_only;
ALTER TABLE users DROP COLUMN email;
