-- Up Migration
-- D99: the pro Week, Availability and Earnings pages. Days off on single dates (besides the weekly working days),
-- MISK's record of each payout to a pro's bank account, and plan visits a pro hands to a stand-in.

-- A single day off, e.g. a doctor's appointment. Like a holiday: no offers come in and no jobs are offered for it.
CREATE TABLE pro_days_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pro_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pro_id, day)
);

-- One payout to the pro's bank on a payout day (weekly, every other Friday or monthly, from Settings), with the
-- bank account's last 4 digits at that moment. The earnings it holds point to it, so they read "Paid".
CREATE TABLE pro_bank_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pro_id uuid NOT NULL REFERENCES users (id),
  paid_on date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  bank_last4 text CHECK (bank_last4 ~ '^[0-9]{4}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pro_id, paid_on)
);
CREATE INDEX pro_bank_payouts_pro_idx ON pro_bank_payouts (pro_id, paid_on DESC);

ALTER TABLE payouts ADD COLUMN bank_payout_id uuid REFERENCES pro_bank_payouts (id);
CREATE INDEX payouts_bank_payout_idx ON payouts (bank_payout_id) WHERE bank_payout_id IS NOT NULL;
CREATE INDEX payouts_unpaid_idx ON payouts (pro_id) WHERE bank_payout_id IS NULL;

ALTER TABLE subscription_visits
  -- The payout to the bank that included this visit's per-visit amount.
  ADD COLUMN bank_payout_id uuid REFERENCES pro_bank_payouts (id),
  -- The regular pro this visit was handed from, when a stand-in does it (their day off or holiday).
  ADD COLUMN stand_in_for uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The pro asked for a stand-in and none was free: the visit is under Needs action until it is sorted.
  ADD COLUMN handover_requested_at timestamptz;
CREATE INDEX subscription_visits_bank_payout_idx ON subscription_visits (bank_payout_id) WHERE bank_payout_id IS NOT NULL;
CREATE INDEX subscription_visits_handover_idx ON subscription_visits (starts_at) WHERE handover_requested_at IS NOT NULL;

-- A plan visit done by a stand-in pays the stand-in: their own payout row for that one visit (visit_id), and the
-- visit's amount is taken off the regular pro's next monthly payout (deducted_cents, stand_in_deducted_by).
ALTER TABLE subscription_payouts
  ADD COLUMN visit_id uuid UNIQUE REFERENCES subscription_visits (id),
  ADD COLUMN deducted_cents integer NOT NULL DEFAULT 0 CHECK (deducted_cents >= 0);
ALTER TABLE subscription_visits ADD COLUMN stand_in_deducted_by uuid REFERENCES subscription_payouts (id);

-- Down Migration
ALTER TABLE subscription_visits DROP COLUMN stand_in_deducted_by;
ALTER TABLE subscription_payouts DROP COLUMN deducted_cents, DROP COLUMN visit_id;
DROP INDEX subscription_visits_handover_idx;
DROP INDEX subscription_visits_bank_payout_idx;
ALTER TABLE subscription_visits DROP COLUMN handover_requested_at, DROP COLUMN stand_in_for, DROP COLUMN bank_payout_id;
DROP INDEX payouts_unpaid_idx;
DROP INDEX payouts_bank_payout_idx;
ALTER TABLE payouts DROP COLUMN bank_payout_id;
DROP TABLE pro_bank_payouts;
DROP TABLE pro_days_off;
