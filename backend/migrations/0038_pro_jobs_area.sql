-- Up Migration
-- D86: the Jobs area of the pro app.

-- Online switch. Offline pros get no new job offers; their accepted jobs and plan visits stay. Existing pros
-- start online, so nothing changes for them until they switch.
ALTER TABLE pro_profiles
  ADD COLUMN online boolean NOT NULL DEFAULT true,
  ADD COLUMN online_changed_at timestamptz NOT NULL DEFAULT now();

-- The tasks a pro ticks off for a service, set by the team in the Catalogue. A service without tasks is one
-- task: the service itself.
ALTER TABLE services ADD COLUMN tasks text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(tasks) <= 8 AND array_position(tasks, NULL) IS NULL);
-- Copied onto the booking with the service, so later catalogue changes never change a booked job.
ALTER TABLE booking_services ADD COLUMN tasks text[] NOT NULL DEFAULT '{}';

-- Tasks the pro has ticked off during a job. `task_key` is "t<n>" for the n-th service task, or "x-<extra id>"
-- for approved extra work.
CREATE TABLE booking_task_checks (
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  task_key text NOT NULL CHECK (task_key ~ '^(t[0-9]{1,3}|x-[0-9a-f-]{36})$'),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, task_key)
);

-- Extra work picked from the MISK price list, with an optional note for the customer.
ALTER TABLE extra_requests
  ADD COLUMN price_item text CHECK (char_length(price_item) <= 60),
  ADD COLUMN note text CHECK (char_length(note) BETWEEN 1 AND 300);

-- A problem on site that the pro reports to MISK support. One open report per job at a time.
CREATE TABLE booking_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (reason IN ('customer_not_home', 'no_access', 'bigger_job', 'unsafe', 'other')),
  details text CHECK (char_length(details) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK (reason <> 'other' OR details IS NOT NULL)
);
CREATE INDEX booking_issues_booking_idx ON booking_issues (booking_id, created_at);
CREATE UNIQUE INDEX booking_issues_one_open_idx ON booking_issues (booking_id) WHERE resolved_at IS NULL;

-- A pro giving back a job they accepted. The job goes back to other pros; a late one (under 24 hours before
-- the start) counts against the pro: three in 30 days pause new offers for a week.
CREATE TABLE pro_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL CHECK (reason IN ('ill', 'vehicle', 'family', 'double_booked', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 300),
  late boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'other' OR note IS NOT NULL)
);
CREATE INDEX pro_cancellations_pro_idx ON pro_cancellations (pro_id, created_at);

-- The pro's private rating of the customer after a job. Only MISK sees it.
CREATE TABLE customer_ratings (
  booking_id uuid PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id),
  customer_id uuid NOT NULL REFERENCES users (id),
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 4),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_ratings_customer_idx ON customer_ratings (customer_id);

-- The booking log also shows what the pro did: a cancellation and on-site issues, and the team resolving one.
ALTER TABLE booking_admin_actions DROP CONSTRAINT booking_admin_actions_action_check;
ALTER TABLE booking_admin_actions ADD CONSTRAINT booking_admin_actions_action_check CHECK (action IN (
  'assigned', 'restarted_search', 'rescheduled', 'cancelled', 'refunded', 'charged_after_problem',
  'pro_cancelled', 'issue_reported', 'issue_resolved'
));

-- Down Migration
DELETE FROM booking_admin_actions WHERE action IN ('pro_cancelled', 'issue_reported', 'issue_resolved');
ALTER TABLE booking_admin_actions DROP CONSTRAINT booking_admin_actions_action_check;
ALTER TABLE booking_admin_actions ADD CONSTRAINT booking_admin_actions_action_check CHECK (action IN (
  'assigned', 'restarted_search', 'rescheduled', 'cancelled', 'refunded', 'charged_after_problem'
));
DROP TABLE customer_ratings;
DROP TABLE pro_cancellations;
DROP TABLE booking_issues;
ALTER TABLE extra_requests DROP COLUMN note, DROP COLUMN price_item;
DROP TABLE booking_task_checks;
ALTER TABLE booking_services DROP COLUMN tasks;
ALTER TABLE services DROP COLUMN tasks;
ALTER TABLE pro_profiles DROP COLUMN online_changed_at, DROP COLUMN online;
