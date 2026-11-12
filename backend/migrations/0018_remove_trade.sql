-- Up Migration
-- Removing a trade deletes its own change log with it, so the removal is kept in the team's activity log.
ALTER TABLE admin_activity DROP CONSTRAINT admin_activity_area_check;
ALTER TABLE admin_activity ADD CONSTRAINT admin_activity_area_check CHECK (area IN ('fees', 'zones', 'notifications', 'team', 'catalogue'));

-- Down Migration
DELETE FROM admin_activity WHERE area = 'catalogue';
ALTER TABLE admin_activity DROP CONSTRAINT admin_activity_area_check;
ALTER TABLE admin_activity ADD CONSTRAINT admin_activity_area_check CHECK (area IN ('fees', 'zones', 'notifications', 'team'));
