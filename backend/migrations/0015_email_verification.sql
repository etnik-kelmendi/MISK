-- Up Migration
-- Customers and pros who sign up with an email address confirm it before they can sign in.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
-- Accounts made before this step keep working: their email counts as confirmed.
UPDATE users SET email_verified_at = COALESCE(terms_accepted_at, created_at)
WHERE email IS NOT NULL AND (role IS NULL OR role <> 'admin');

-- Single-use confirmation links. Only a hash of the token is stored.
CREATE TABLE email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);

-- Down Migration
DROP TABLE email_verifications;
ALTER TABLE users DROP COLUMN email_verified_at;
