-- Up Migration
-- D67: customer and pro write to each other inside a booking (the Chat page), and a rating can carry a
-- written review.
CREATE TABLE booking_messages (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users (id) ON DELETE SET NULL,
  sender_role text NOT NULL CHECK (sender_role IN ('customer', 'pro')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the other side first saw it.
  read_at timestamptz
);
CREATE INDEX booking_messages_booking_idx ON booking_messages (booking_id, id);

ALTER TABLE ratings ADD COLUMN review text CHECK (char_length(review) BETWEEN 1 AND 1000);

-- Down Migration
ALTER TABLE ratings DROP COLUMN review;
DROP TABLE booking_messages;
