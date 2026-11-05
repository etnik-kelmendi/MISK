-- Up Migration
-- People can ask for an admin account on the control panel. Until an existing admin approves the
-- request, the account cannot sign in.
ALTER TABLE users ADD COLUMN admin_requested_at timestamptz;
ALTER TABLE users ADD COLUMN admin_approved_at timestamptz;
ALTER TABLE users ADD COLUMN admin_approved_by uuid REFERENCES users (id);
ALTER TABLE users ADD CONSTRAINT users_admin_request_admin_only CHECK (admin_requested_at IS NULL OR role = 'admin');

-- Down Migration
ALTER TABLE users DROP CONSTRAINT users_admin_request_admin_only;
ALTER TABLE users DROP COLUMN admin_approved_by;
ALTER TABLE users DROP COLUMN admin_approved_at;
ALTER TABLE users DROP COLUMN admin_requested_at;
