-- Up Migration
-- Invitation links for the team (D51). An admin creates a link for a role and shares it however they like;
-- the person who opens it signs up and joins with that role. Each link works once, for a limited time, and
-- can be withdrawn. Only a hash of the token is stored, like password reset links.
CREATE TABLE team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'operations', 'support', 'finance')),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX team_invites_open_idx ON team_invites (expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Down Migration
DROP TABLE team_invites;
