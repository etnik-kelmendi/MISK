-- Up Migration
-- D83: chat messages can be a photo (with or without text). A message needs text, a photo or both. Deleting
-- the upload (only when its owner's account is deleted) deletes the message with it.
ALTER TABLE booking_messages ADD COLUMN photo_id uuid REFERENCES uploads (id) ON DELETE CASCADE;
ALTER TABLE booking_messages ALTER COLUMN body DROP NOT NULL;
ALTER TABLE booking_messages ADD CONSTRAINT booking_messages_has_content CHECK (body IS NOT NULL OR photo_id IS NOT NULL);
CREATE INDEX booking_messages_photo_idx ON booking_messages (photo_id) WHERE photo_id IS NOT NULL;

-- Where a message in the app (and its push notification) leads when tapped, e.g. the chat of a booking.
-- Only paths inside the app.
ALTER TABLE inbox ADD COLUMN link text CHECK (link ~ '^/[A-Za-z0-9/_-]{0,200}$');
ALTER TABLE notifications ADD COLUMN link text CHECK (link ~ '^/[A-Za-z0-9/_-]{0,200}$');

-- Down Migration
ALTER TABLE notifications DROP COLUMN link;
ALTER TABLE inbox DROP COLUMN link;
DROP INDEX booking_messages_photo_idx;
DELETE FROM booking_messages WHERE body IS NULL;
ALTER TABLE booking_messages DROP CONSTRAINT booking_messages_has_content;
ALTER TABLE booking_messages ALTER COLUMN body SET NOT NULL;
ALTER TABLE booking_messages DROP COLUMN photo_id;
