-- Up Migration
-- D90: the customer Plans, Plan builder and My plan pages.

-- The day of a plan's first visit, as the customer chose with the builder's Start option ("As soon as
-- possible", "Next week", "In 2 weeks"). Nothing is planned before it, and plans visited every 2 weeks count
-- their weeks from it. Older plans have none: they keep counting from when they started.
ALTER TABLE subscriptions ADD COLUMN first_visit_on date;
-- When the customer ticked "I agree to the subscription terms" (the server refuses a sign-up without it).
ALTER TABLE subscriptions ADD COLUMN terms_accepted_at timestamptz;

-- Skipping visits comes back (reverses that part of D77): when the customer skipped a visit. A skipped visit
-- frees the pro's time (the overlap rule only covers pending and planned visits) and is still part of the
-- monthly price. Visits skipped before D77 keep their status without a time.
ALTER TABLE subscription_visits ADD COLUMN skipped_at timestamptz;
-- Skips are counted per subscription and calendar month.
CREATE INDEX subscription_visits_skipped_idx ON subscription_visits (subscription_id, starts_at) WHERE status = 'skipped';

-- How often taking back pause credit after a plan's end (D78), or giving it again when the customer keeps the
-- plan after all (D90), has changed a pause, so each change goes to the payment provider exactly once.
ALTER TABLE subscription_pauses ADD COLUMN credit_changes integer NOT NULL DEFAULT 0 CHECK (credit_changes >= 0);

-- Down Migration
ALTER TABLE subscription_pauses DROP COLUMN credit_changes;
DROP INDEX subscription_visits_skipped_idx;
ALTER TABLE subscription_visits DROP COLUMN skipped_at;
ALTER TABLE subscriptions DROP COLUMN terms_accepted_at;
ALTER TABLE subscriptions DROP COLUMN first_visit_on;
