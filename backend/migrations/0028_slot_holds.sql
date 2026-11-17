-- Up Migration
-- D74: Choose time, second version.

-- A time that freed up, held for the customer who waited for it: for 15 minutes nobody else can book it.
CREATE TABLE slot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  postcode text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  expires_at timestamptz NOT NULL,
  waitlist_id uuid REFERENCES time_waitlist (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slot_holds_live_idx ON slot_holds (category_id, expires_at);
CREATE INDEX slot_holds_customer_idx ON slot_holds (customer_id);

-- When the money for a booking was last reserved on the card. A card reservation lasts about 7 days, so
-- one for a job further ahead is renewed before it runs out (bookings can be made 7 days ahead).
ALTER TABLE bookings ADD COLUMN hold_placed_at timestamptz;
UPDATE bookings SET hold_placed_at = updated_at WHERE payment_status = 'held';
-- A renewal the bank refused; tried again at most once a day, and the team is told.
ALTER TABLE bookings ADD COLUMN hold_renew_failed_at timestamptz;

-- Down Migration
ALTER TABLE bookings DROP COLUMN hold_renew_failed_at;
ALTER TABLE bookings DROP COLUMN hold_placed_at;
DROP TABLE slot_holds;
