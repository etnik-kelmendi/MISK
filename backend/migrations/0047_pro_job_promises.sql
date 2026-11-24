-- Up Migration
-- D94: the pro Jobs area keeps its promises: working hours and holidays, the late warning, the call-out fee,
-- paid waiting time, a stopped job when it is unsafe, and the cancelled-job card.

-- Working hours (the same on every working day) and an override: "Go online" outside them lasts until the end
-- of that day in the market time zone. Days off are the days that are not working days.
ALTER TABLE pro_profiles
  ADD COLUMN work_start time NOT NULL DEFAULT '08:00',
  ADD COLUMN work_end time NOT NULL DEFAULT '18:00',
  ADD COLUMN online_override_until timestamptz,
  ADD CONSTRAINT pro_profiles_work_hours_check CHECK (work_start < work_end);

-- Holidays: whole days, first and last day included. No offers come in and no jobs are offered for those days.
CREATE TABLE pro_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pro_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on AND ends_on - starts_on <= 92)
);
CREATE INDEX pro_holidays_pro_idx ON pro_holidays (pro_id, ends_on);

-- What a customer who is not home pays the pro who came (default €15), and how much waiting at a door the
-- pro is paid for at most.
ALTER TABLE settings
  ADD COLUMN no_show_fee_cents integer NOT NULL DEFAULT 1500 CHECK (no_show_fee_cents BETWEEN 0 AND 10000),
  ADD COLUMN waiting_cap_minutes integer NOT NULL DEFAULT 30 CHECK (waiting_cap_minutes BETWEEN 0 AND 120);

ALTER TABLE bookings
  -- The customer was told once that the pro runs more than 10 minutes late.
  ADD COLUMN late_warned_at timestamptz,
  -- The customer was not home (or did not let the pro in): the pro left with the call-out fee.
  ADD COLUMN no_show_at timestamptz,
  ADD COLUMN no_show_fee_cents integer CHECK (no_show_fee_cents >= 0),
  -- Waiting at the door that was paid with the call-out fee, in cents of the customer's price.
  ADD COLUMN no_show_waiting_cents integer CHECK (no_show_waiting_cents >= 0);

-- Paid waiting time is a line on the booking like extra work, but nobody approves it: it is held on the
-- customer's card, or paid by MISK when that is refused.
ALTER TABLE extra_requests
  ADD COLUMN kind text NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'waiting')),
  ADD COLUMN funded_by text NOT NULL DEFAULT 'customer' CHECK (funded_by IN ('customer', 'misk')),
  ADD COLUMN issue_id uuid REFERENCES booking_issues (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX extra_requests_waiting_once_idx ON extra_requests (issue_id) WHERE kind = 'waiting';

-- A payout MISK funds itself (waiting time the customer's card refused) comes from MISK's balance, not a charge.
ALTER TABLE payouts ALTER COLUMN charge_id DROP NOT NULL;

-- The pro's optional comment with their rating of the customer. Only MISK sees it.
ALTER TABLE customer_ratings ADD COLUMN comment text CHECK (char_length(comment) BETWEEN 1 AND 500);

-- The "You cancelled this job" card on the Jobs page, until the pro closes it (shown for 24 hours).
ALTER TABLE pro_cancellations ADD COLUMN dismissed_at timestamptz;

ALTER TABLE booking_admin_actions DROP CONSTRAINT booking_admin_actions_action_check;
ALTER TABLE booking_admin_actions ADD CONSTRAINT booking_admin_actions_action_check CHECK (action IN (
  'assigned', 'restarted_search', 'rescheduled', 'cancelled', 'refunded', 'charged_after_problem',
  'pro_cancelled', 'issue_reported', 'issue_resolved', 'no_show', 'waiting_paid', 'late_warning'
));

-- Down Migration
DELETE FROM booking_admin_actions WHERE action IN ('no_show', 'waiting_paid', 'late_warning');
ALTER TABLE booking_admin_actions DROP CONSTRAINT booking_admin_actions_action_check;
ALTER TABLE booking_admin_actions ADD CONSTRAINT booking_admin_actions_action_check CHECK (action IN (
  'assigned', 'restarted_search', 'rescheduled', 'cancelled', 'refunded', 'charged_after_problem',
  'pro_cancelled', 'issue_reported', 'issue_resolved'
));
ALTER TABLE pro_cancellations DROP COLUMN dismissed_at;
ALTER TABLE customer_ratings DROP COLUMN comment;
DELETE FROM payouts WHERE charge_id IS NULL;
ALTER TABLE payouts ALTER COLUMN charge_id SET NOT NULL;
DELETE FROM extra_requests WHERE kind = 'waiting';
DROP INDEX extra_requests_waiting_once_idx;
ALTER TABLE extra_requests DROP COLUMN issue_id, DROP COLUMN funded_by, DROP COLUMN kind;
ALTER TABLE bookings DROP COLUMN no_show_waiting_cents, DROP COLUMN no_show_fee_cents, DROP COLUMN no_show_at,
  DROP COLUMN late_warned_at;
ALTER TABLE settings DROP COLUMN waiting_cap_minutes, DROP COLUMN no_show_fee_cents;
DROP TABLE pro_holidays;
ALTER TABLE pro_profiles DROP CONSTRAINT pro_profiles_work_hours_check;
ALTER TABLE pro_profiles DROP COLUMN online_override_until, DROP COLUMN work_end, DROP COLUMN work_start;
