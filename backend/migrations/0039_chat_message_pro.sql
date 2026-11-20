-- Up Migration
-- Each chat message remembers which pro the booking had when it was sent (D86). When a pro cancels or MISK
-- gives the job to another pro, the new pro sees only the messages from their own time on the job; the
-- customer still sees the whole conversation.
ALTER TABLE booking_messages ADD COLUMN pro_id uuid REFERENCES users (id) ON DELETE SET NULL;
UPDATE booking_messages m SET pro_id = b.pro_id FROM bookings b WHERE b.id = m.booking_id;
CREATE INDEX booking_messages_booking_pro_idx ON booking_messages (booking_id, pro_id);

-- Down Migration
DROP INDEX booking_messages_booking_pro_idx;
ALTER TABLE booking_messages DROP COLUMN pro_id;
