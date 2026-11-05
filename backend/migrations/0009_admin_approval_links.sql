-- Up Migration
-- One-click approval links in the email admins get about an account request. Only a hash of each
-- link's token is stored; a link works once and expires.
CREATE TABLE admin_approval_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_approval_links_user_idx ON admin_approval_links (user_id);

-- Down Migration
DROP TABLE admin_approval_links;
