-- Up Migration
-- D101: customers can book, and join the waiting list for a time, up to this many days ahead (today counts as
-- the first day). It replaces the fixed seven days of D74. The team sets it in Settings, Fees & payments.
ALTER TABLE settings
  ADD COLUMN booking_horizon_days integer NOT NULL DEFAULT 60 CHECK (booking_horizon_days BETWEEN 7 AND 180);

-- Down Migration
ALTER TABLE settings DROP COLUMN booking_horizon_days;
