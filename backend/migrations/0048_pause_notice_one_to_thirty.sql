-- Up Migration
-- D95: the notice before a pause starts is now 1 to 30 days (it was 0 to 30). The admin picks it with a
-- number stepper that stops at 1. Existing rows with 0 days move to 1 first, on plans and on the terms
-- subscriptions copied at sign-up, so the new checks cannot fail on real data.
ALTER TABLE plans DROP CONSTRAINT plans_pause_notice_days_check;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pause_notice_days_check;

UPDATE plans SET pause_notice_days = 1 WHERE pause_notice_days = 0;
UPDATE subscriptions SET pause_notice_days = 1 WHERE pause_notice_days = 0;

ALTER TABLE plans
  ADD CONSTRAINT plans_pause_notice_days_check CHECK (pause_notice_days BETWEEN 1 AND 30);
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_pause_notice_days_check CHECK (pause_notice_days BETWEEN 1 AND 30);

-- Down Migration
-- Back to 0 to 30 (the rows that moved from 0 to 1 stay at 1).
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pause_notice_days_check;
ALTER TABLE plans DROP CONSTRAINT plans_pause_notice_days_check;
ALTER TABLE plans
  ADD CONSTRAINT plans_pause_notice_days_check CHECK (pause_notice_days BETWEEN 0 AND 30);
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_pause_notice_days_check CHECK (pause_notice_days BETWEEN 0 AND 30);
