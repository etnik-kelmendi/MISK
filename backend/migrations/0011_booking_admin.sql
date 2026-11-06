-- Up Migration
-- Short numbers people can read out and search for: B-1001 for one-off jobs, V-1001 for plan visits.
ALTER TABLE bookings ADD COLUMN number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE;
ALTER TABLE subscription_visits ADD COLUMN number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE;

-- The customer is charged 24 hours after the job is done unless they report a problem first.
ALTER TABLE bookings ADD COLUMN problem_reported_at timestamptz;
ALTER TABLE bookings ADD COLUMN problem_note text CHECK (char_length(problem_note) <= 1000);
ALTER TABLE bookings ADD COLUMN problem_resolved_at timestamptz;

-- Every change an admin makes to a booking, for the activity log.
CREATE TABLE booking_admin_actions (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  admin_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('assigned', 'restarted_search', 'rescheduled', 'cancelled', 'refunded', 'charged_after_problem')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_admin_actions_booking_idx ON booking_admin_actions (booking_id, id);

-- Down Migration
DROP TABLE booking_admin_actions;
ALTER TABLE bookings DROP COLUMN problem_resolved_at;
ALTER TABLE bookings DROP COLUMN problem_note;
ALTER TABLE bookings DROP COLUMN problem_reported_at;
ALTER TABLE subscription_visits DROP COLUMN number;
ALTER TABLE bookings DROP COLUMN number;
