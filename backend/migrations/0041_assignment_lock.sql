-- Up Migration
-- D88: when the team assigns a pro and confirms it, the assignment is final. The lock belongs to that pro's
-- assignment: it is cleared when the pro leaves the booking (the booking goes back to the search).
ALTER TABLE bookings
  ADD COLUMN assignment_locked_at timestamptz,
  ADD COLUMN assignment_locked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT bookings_assignment_lock_pair CHECK (assignment_locked_at IS NOT NULL OR assignment_locked_by IS NULL);

-- Down Migration
ALTER TABLE bookings
  DROP CONSTRAINT bookings_assignment_lock_pair,
  DROP COLUMN assignment_locked_by,
  DROP COLUMN assignment_locked_at;
