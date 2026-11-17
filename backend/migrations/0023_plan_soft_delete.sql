-- Up Migration
-- D66: a deleted plan is hidden, not erased. Its subscriptions, visits, receipts and payouts keep pointing at
-- it and keep its name; it no longer shows in the Plans list or the apps.
ALTER TABLE plans
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users (id) ON DELETE SET NULL;
-- A deleted plan is never offered: it can only be a draft.
ALTER TABLE plans ADD CONSTRAINT plans_deleted_not_published CHECK (deleted_at IS NULL OR status = 'draft');
CREATE INDEX plans_listed_idx ON plans (status) WHERE deleted_at IS NULL;

-- Plan changes go into the team's activity log.
ALTER TABLE admin_activity DROP CONSTRAINT admin_activity_area_check;
ALTER TABLE admin_activity ADD CONSTRAINT admin_activity_area_check
  CHECK (area IN ('fees', 'zones', 'notifications', 'team', 'catalogue', 'plans'));

-- Down Migration
DELETE FROM admin_activity WHERE area = 'plans';
ALTER TABLE admin_activity DROP CONSTRAINT admin_activity_area_check;
ALTER TABLE admin_activity ADD CONSTRAINT admin_activity_area_check CHECK (area IN ('fees', 'zones', 'notifications', 'team', 'catalogue'));
DROP INDEX plans_listed_idx;
ALTER TABLE plans DROP CONSTRAINT plans_deleted_not_published;
ALTER TABLE plans DROP COLUMN deleted_by, DROP COLUMN deleted_at;
