-- Up Migration
-- D70: the Choose time page.

-- A customer waiting for a full time (starts_at) or for any time on a day (starts_at NULL) in one trade.
-- They are told once a pro is free; nothing is held for them, the first to book gets it.
CREATE TABLE time_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  service_ids uuid[] NOT NULL CHECK (cardinality(service_ids) BETWEEN 1 AND 10),
  postcode text NOT NULL,
  -- The local day the customer wants.
  day date NOT NULL,
  starts_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
-- One entry per customer, trade and time (or whole day).
CREATE UNIQUE INDEX time_waitlist_once_idx
  ON time_waitlist (customer_id, category_id, day, COALESCE(starts_at, '-infinity'::timestamptz));
CREATE INDEX time_waitlist_waiting_idx ON time_waitlist (day) WHERE notified_at IS NULL;

-- A flexible booking: the customer gives a window on a day and the first free pro picks the start time.
-- Until then starts_at/ends_at cover the whole window.
ALTER TABLE bookings ADD COLUMN flexible_window text CHECK (flexible_window IN ('morning', 'afternoon', 'any'));
-- When the pro picked the time; NULL while a flexible booking still waits for one.
ALTER TABLE bookings ADD COLUMN time_confirmed_at timestamptz;
-- A pro has to confirm a flexible booking by 18:00 the evening before; after that the team takes over.
ALTER TABLE bookings ADD COLUMN confirm_by timestamptz;

-- Down Migration
ALTER TABLE bookings DROP COLUMN confirm_by;
ALTER TABLE bookings DROP COLUMN time_confirmed_at;
ALTER TABLE bookings DROP COLUMN flexible_window;
DROP TABLE time_waitlist;
