-- Up Migration
-- Customers can add photos when they report a problem with a finished job. Only the customer and the
-- MISK team see them; the pro does not.
ALTER TABLE booking_photos DROP CONSTRAINT booking_photos_kind_check;
ALTER TABLE booking_photos ADD CONSTRAINT booking_photos_kind_check CHECK (kind IN ('customer', 'completion', 'problem'));

-- Down Migration
DELETE FROM booking_photos WHERE kind = 'problem';
ALTER TABLE booking_photos DROP CONSTRAINT booking_photos_kind_check;
ALTER TABLE booking_photos ADD CONSTRAINT booking_photos_kind_check CHECK (kind IN ('customer', 'completion'));
