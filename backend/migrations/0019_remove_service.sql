-- Up Migration
-- A service can be removed from the catalogue. One that was never booked is deleted; one with bookings
-- is kept (bookings point at it) but marked removed, so it no longer shows anywhere.
ALTER TABLE services ADD COLUMN removed_at timestamptz;
ALTER TABLE services ADD CONSTRAINT services_removed_is_hidden CHECK (removed_at IS NULL OR NOT active);
ALTER TABLE catalogue_changes DROP CONSTRAINT catalogue_changes_action_check;
ALTER TABLE catalogue_changes ADD CONSTRAINT catalogue_changes_action_check CHECK (action IN (
  'trade_added', 'trade_published', 'trade_unpublished', 'trade_edited',
  'service_added', 'service_edited', 'price_changed', 'service_hidden', 'service_shown', 'service_removed'));

-- Down Migration
DELETE FROM catalogue_changes WHERE action = 'service_removed';
ALTER TABLE catalogue_changes DROP CONSTRAINT catalogue_changes_action_check;
ALTER TABLE catalogue_changes ADD CONSTRAINT catalogue_changes_action_check CHECK (action IN (
  'trade_added', 'trade_published', 'trade_unpublished', 'trade_edited',
  'service_added', 'service_edited', 'price_changed', 'service_hidden', 'service_shown'));
ALTER TABLE services DROP CONSTRAINT services_removed_is_hidden;
ALTER TABLE services DROP COLUMN removed_at;
