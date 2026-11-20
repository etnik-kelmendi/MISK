-- Up Migration
-- D85: the pause rules get new ranges. Most paused weeks a year is 0 to 8 (0 means the plan cannot be paused);
-- the notice before a pause starts is 0 to 30 days. Defaults stay 4 weeks and 7 days.

-- Clamp existing values first, so the new checks cannot fail on real data (on plans and on the terms
-- subscriptions copied at sign-up). Pauses that are already planned are not touched.
ALTER TABLE plans DROP CONSTRAINT plans_max_pause_weeks_check;
ALTER TABLE plans DROP CONSTRAINT plans_pause_notice_days_check;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_max_pause_weeks_check;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pause_notice_days_check;

UPDATE plans SET max_pause_weeks = LEAST(max_pause_weeks, 8), pause_notice_days = LEAST(pause_notice_days, 30)
WHERE max_pause_weeks > 8 OR pause_notice_days > 30;
UPDATE subscriptions SET max_pause_weeks = LEAST(max_pause_weeks, 8), pause_notice_days = LEAST(pause_notice_days, 30)
WHERE max_pause_weeks > 8 OR pause_notice_days > 30;

ALTER TABLE plans
  ADD CONSTRAINT plans_max_pause_weeks_check CHECK (max_pause_weeks BETWEEN 0 AND 8),
  ADD CONSTRAINT plans_pause_notice_days_check CHECK (pause_notice_days BETWEEN 0 AND 30);
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_max_pause_weeks_check CHECK (max_pause_weeks BETWEEN 0 AND 8),
  ADD CONSTRAINT subscriptions_pause_notice_days_check CHECK (pause_notice_days BETWEEN 0 AND 30);

-- Down Migration
-- Values the old ranges do not allow move to their nearest allowed value first (0 weeks to 1, 0 days to 1).
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pause_notice_days_check;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_max_pause_weeks_check;
ALTER TABLE plans DROP CONSTRAINT plans_pause_notice_days_check;
ALTER TABLE plans DROP CONSTRAINT plans_max_pause_weeks_check;
UPDATE plans SET max_pause_weeks = GREATEST(max_pause_weeks, 1), pause_notice_days = GREATEST(pause_notice_days, 1);
UPDATE subscriptions SET max_pause_weeks = GREATEST(max_pause_weeks, 1), pause_notice_days = GREATEST(pause_notice_days, 1);
ALTER TABLE plans
  ADD CONSTRAINT plans_max_pause_weeks_check CHECK (max_pause_weeks BETWEEN 1 AND 10),
  ADD CONSTRAINT plans_pause_notice_days_check CHECK (pause_notice_days BETWEEN 1 AND 60);
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_max_pause_weeks_check CHECK (max_pause_weeks BETWEEN 1 AND 10),
  ADD CONSTRAINT subscriptions_pause_notice_days_check CHECK (pause_notice_days BETWEEN 1 AND 60);
