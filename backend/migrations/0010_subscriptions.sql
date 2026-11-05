-- Up Migration
-- Drafts may be saved half-finished; only a published plan must be complete.
ALTER TABLE plans ALTER COLUMN name DROP NOT NULL;
ALTER TABLE plans ALTER COLUMN category_id DROP NOT NULL;
ALTER TABLE plans ALTER COLUMN price_cents DROP NOT NULL;
ALTER TABLE plans ALTER COLUMN tasks SET DEFAULT '{}';
ALTER TABLE plans DROP CONSTRAINT plans_tasks_check;
ALTER TABLE plans ADD CONSTRAINT plans_tasks_count CHECK (cardinality(tasks) <= 12);
ALTER TABLE plans DROP CONSTRAINT plans_addon_complete;
ALTER TABLE plans DROP CONSTRAINT plans_price_cents_check;
ALTER TABLE plans ADD CONSTRAINT plans_price_range CHECK (price_cents BETWEEN 0 AND 99900);
ALTER TABLE plans ADD CONSTRAINT plans_published_complete CHECK (
  status = 'draft' OR (
    name IS NOT NULL AND category_id IS NOT NULL AND price_cents >= 500 AND cardinality(tasks) >= 1
    AND (addon_name IS NULL) = (addon_price_cents IS NULL)
  )
);
-- The Stripe product monthly invoices are billed under, created on first subscription.
ALTER TABLE plans ADD COLUMN stripe_product_id text;

-- A customer's monthly plan. Prices, tasks and rules are copied from the plan at subscribing, so later
-- plan changes never alter what the customer agreed to.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users (id),
  plan_id uuid NOT NULL REFERENCES plans (id),
  category_id uuid NOT NULL REFERENCES categories (id),
  plan_name text NOT NULL,
  tasks text[] NOT NULL,
  size text NOT NULL CHECK (size IN ('S', 'M', 'L')),
  frequency text NOT NULL CHECK (frequency IN ('every_2_weeks', 'weekly', 'twice_weekly', 'three_times_weekly')),
  days smallint[] NOT NULL CHECK (cardinality(days) BETWEEN 1 AND 3 AND days <@ '{1,2,3,4,5,6,7}'),
  time_window text NOT NULL CHECK (time_window IN ('morning', 'afternoon')),
  visit_minutes integer NOT NULL,
  address text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 200),
  postcode text NOT NULL REFERENCES postcodes (code),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  with_addon boolean NOT NULL,
  addon_name text,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  pro_share_pct integer NOT NULL CHECK (pro_share_pct BETWEEN 50 AND 90),
  seasonal boolean NOT NULL,
  season_from smallint,
  season_to smallint,
  skips_per_month smallint NOT NULL,
  min_term_months smallint NOT NULL,
  pro_id uuid REFERENCES users (id),
  status text NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'active', 'past_due', 'cancelled')),
  stripe_subscription_id text UNIQUE,
  billing_paused boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  current_period_end timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id, created_at DESC);
CREATE INDEX subscriptions_pro_idx ON subscriptions (pro_id);
CREATE INDEX subscriptions_status_idx ON subscriptions (status);

-- Visits are planned ahead with the regular pro. "pending" holds the pro's time until the first
-- payment goes through.
CREATE TABLE subscription_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('pending', 'planned', 'skipped', 'completed', 'cancelled')),
  tasks_done text[] NOT NULL DEFAULT '{}',
  completed_at timestamptz,
  UNIQUE (subscription_id, starts_at),
  -- A pro can never be in two visits at once.
  CONSTRAINT subscription_visits_no_overlap EXCLUDE USING gist (
    pro_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('pending', 'planned'))
);
CREATE INDEX subscription_visits_pro_idx ON subscription_visits (pro_id, starts_at);

-- The pro's share of each paid month.
CREATE TABLE subscription_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  pro_id uuid NOT NULL REFERENCES users (id),
  invoice_id text NOT NULL UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  transfer_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_payouts_pending_idx ON subscription_payouts (status) WHERE status IN ('pending', 'failed');

-- Down Migration
DROP TABLE subscription_payouts;
DROP TABLE subscription_visits;
DROP TABLE subscriptions;
ALTER TABLE plans DROP COLUMN stripe_product_id;
ALTER TABLE plans DROP CONSTRAINT plans_published_complete;
ALTER TABLE plans DROP CONSTRAINT plans_price_range;
ALTER TABLE plans ADD CONSTRAINT plans_price_cents_check CHECK (price_cents BETWEEN 500 AND 99900);
ALTER TABLE plans ADD CONSTRAINT plans_addon_complete CHECK ((addon_name IS NULL) = (addon_price_cents IS NULL));
ALTER TABLE plans DROP CONSTRAINT plans_tasks_count;
ALTER TABLE plans ADD CONSTRAINT plans_tasks_check CHECK (cardinality(tasks) BETWEEN 1 AND 12);
ALTER TABLE plans ALTER COLUMN tasks DROP DEFAULT;
ALTER TABLE plans ALTER COLUMN price_cents SET NOT NULL;
ALTER TABLE plans ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE plans ALTER COLUMN name SET NOT NULL;
