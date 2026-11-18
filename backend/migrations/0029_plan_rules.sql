-- Up Migration
-- D77: new monthly plan rules.

-- The minimum term is one of 1, 3, 6 or 12 months; 0 is no longer possible. Existing values move to the
-- nearest allowed term at or above them (0 and 1 become 1, 2 becomes 3, 4 to 6 become 6, 7 to 12 become 12),
-- on plans and on the terms subscriptions copied at sign-up.
ALTER TABLE plans DROP CONSTRAINT plans_min_term_months_check;
UPDATE plans SET min_term_months = CASE
  WHEN min_term_months <= 1 THEN 1 WHEN min_term_months <= 3 THEN 3 WHEN min_term_months <= 6 THEN 6 ELSE 12 END;
ALTER TABLE plans ADD CONSTRAINT plans_min_term_months_check CHECK (min_term_months IN (1, 3, 6, 12));
UPDATE subscriptions SET min_term_months = CASE
  WHEN min_term_months <= 1 THEN 1 WHEN min_term_months <= 3 THEN 3 WHEN min_term_months <= 6 THEN 6 ELSE 12 END;

-- Pause rules: the notice needed before a pause starts and the most paused weeks in a year. They are shown
-- to customers; a customer Pause action is not built yet. Subscriptions copy them like the other terms.
ALTER TABLE plans
  ADD COLUMN pause_notice_days smallint NOT NULL DEFAULT 7 CHECK (pause_notice_days BETWEEN 1 AND 60),
  ADD COLUMN max_pause_weeks smallint NOT NULL DEFAULT 4 CHECK (max_pause_weeks BETWEEN 1 AND 10);
ALTER TABLE subscriptions
  ADD COLUMN pause_notice_days smallint NOT NULL DEFAULT 7 CHECK (pause_notice_days BETWEEN 1 AND 60),
  ADD COLUMN max_pause_weeks smallint NOT NULL DEFAULT 4 CHECK (max_pause_weeks BETWEEN 1 AND 10);
UPDATE subscriptions s SET pause_notice_days = p.pause_notice_days, max_pause_weeks = p.max_pause_weeks
FROM plans p WHERE p.id = s.plan_id;
-- skips_per_month stays on plans and subscriptions for old records, but skipping is no longer offered.

-- Where a moved visit was first planned, so the planner never plans that time again (only that visit moves).
ALTER TABLE subscription_visits ADD COLUMN moved_from timestamptz;

-- A customer's request to move one visit to another day of the same week; the pro confirms or declines.
-- Unanswered requests expire at respond_by: 24 hours before the original time, or the new time if sooner.
CREATE TABLE subscription_visit_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES subscription_visits (id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users (id),
  pro_id uuid NOT NULL REFERENCES users (id),
  from_starts_at timestamptz NOT NULL,
  from_ends_at timestamptz NOT NULL CHECK (from_ends_at > from_starts_at),
  to_starts_at timestamptz NOT NULL,
  to_ends_at timestamptz NOT NULL CHECK (to_ends_at > to_starts_at),
  respond_by timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);
-- At most one open request per visit.
CREATE UNIQUE INDEX subscription_visit_moves_one_pending ON subscription_visit_moves (visit_id) WHERE status = 'pending';
CREATE INDEX subscription_visit_moves_pro_idx ON subscription_visit_moves (pro_id) WHERE status = 'pending';
CREATE INDEX subscription_visit_moves_due_idx ON subscription_visit_moves (respond_by) WHERE status = 'pending';

-- Down Migration
DROP TABLE subscription_visit_moves;
ALTER TABLE subscription_visits DROP COLUMN moved_from;
ALTER TABLE subscriptions DROP COLUMN max_pause_weeks, DROP COLUMN pause_notice_days;
ALTER TABLE plans DROP COLUMN max_pause_weeks, DROP COLUMN pause_notice_days;
ALTER TABLE plans DROP CONSTRAINT plans_min_term_months_check;
ALTER TABLE plans ADD CONSTRAINT plans_min_term_months_check CHECK (min_term_months BETWEEN 0 AND 12);
