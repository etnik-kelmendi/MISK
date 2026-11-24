-- Up Migration
-- D91: a plan's billing starts on the day of its first visit, not on the day the customer subscribes.

-- When the plan's billing starts: midnight (market time) of the first visit day, or the moment of sign-up when
-- the first visit is less than 24 hours away and the first month is charged at once. The first month runs from
-- here, and the minimum term, the end of a cancelled plan and "Keep my plan" are counted from here.
ALTER TABLE subscriptions ADD COLUMN billing_starts_at timestamptz;
-- Plans from before were billed from their first payment, or from sign-up while still unpaid.
UPDATE subscriptions SET billing_starts_at = COALESCE(started_at, created_at);

-- Down Migration
ALTER TABLE subscriptions DROP COLUMN billing_starts_at;
