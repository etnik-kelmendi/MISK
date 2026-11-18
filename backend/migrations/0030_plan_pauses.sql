-- Up Migration
-- D78: customers pause a monthly plan for whole weeks.

-- One pause of a subscription: whole local days from starts_on for `weeks` weeks, i.e. the instants
-- [starts_at, ends_at) (local midnight to local midnight in the market time zone). Visits starting inside
-- are called off and their value credited to the customer's next bill. A pause called off before it starts
-- is 'withdrawn': it no longer counts against the yearly allowance, and the credit for visits that came back
-- is taken back (reversed_cents).
CREATE TABLE subscription_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users (id),
  starts_on date NOT NULL,
  weeks smallint NOT NULL CHECK (weeks BETWEEN 1 AND 10),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  -- What one visit is worth: the monthly price divided by the visits a month of the plan's frequency.
  visit_value_cents integer NOT NULL DEFAULT 0 CHECK (visit_value_cents >= 0),
  visits_called_off integer NOT NULL DEFAULT 0 CHECK (visits_called_off >= 0),
  credit_cents integer NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  -- The payment provider's balance transaction for the credit.
  credit_ref text,
  visits_restored integer NOT NULL DEFAULT 0 CHECK (visits_restored >= 0),
  -- Credit taken back: for visits that came back when the pause was called off, or for paused visits after
  -- the plan's end when the plan was cancelled later.
  reversed_cents integer NOT NULL DEFAULT 0 CHECK (reversed_cents >= 0 AND reversed_cents <= credit_cents),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  -- Two pauses of one plan never overlap.
  CONSTRAINT subscription_pauses_no_overlap EXCLUDE USING gist (
    subscription_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'active')
);
CREATE INDEX subscription_pauses_subscription_idx ON subscription_pauses (subscription_id, starts_on);

-- The pause that called a visit off. Cleared when the visit comes back.
ALTER TABLE subscription_visits ADD COLUMN paused_by uuid REFERENCES subscription_pauses (id) ON DELETE SET NULL;
CREATE INDEX subscription_visits_paused_by_idx ON subscription_visits (paused_by) WHERE paused_by IS NOT NULL;

-- Down Migration
ALTER TABLE subscription_visits DROP COLUMN paused_by;
DROP TABLE subscription_pauses;
