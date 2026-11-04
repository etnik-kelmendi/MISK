-- Up Migration
-- Monthly subscription plans built by admins (Phase 2). Prices are euro cents for a medium-sized
-- home or garden; small is 15% less and large 35% more, as in the product demo.
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  category_id uuid NOT NULL REFERENCES categories (id),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 500 AND 99900),
  frequency text NOT NULL CHECK (frequency IN ('every_2_weeks', 'weekly', 'twice_weekly', 'three_times_weekly')),
  visit_minutes integer NOT NULL CHECK (visit_minutes BETWEEN 15 AND 600 AND visit_minutes % 15 = 0),
  tasks text[] NOT NULL CHECK (cardinality(tasks) BETWEEN 1 AND 12),
  addon_name text CHECK (char_length(addon_name) BETWEEN 1 AND 80),
  addon_price_cents integer CHECK (addon_price_cents BETWEEN 0 AND 99900),
  seasonal boolean NOT NULL DEFAULT false,
  season_from smallint CHECK (season_from BETWEEN 1 AND 12),
  season_to smallint CHECK (season_to BETWEEN 1 AND 12),
  skips_per_month smallint NOT NULL DEFAULT 2 CHECK (skips_per_month BETWEEN 0 AND 8),
  min_term_months smallint NOT NULL DEFAULT 3 CHECK (min_term_months BETWEEN 0 AND 12),
  pro_share_pct smallint NOT NULL DEFAULT 70 CHECK (pro_share_pct BETWEEN 50 AND 90),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_addon_complete CHECK ((addon_name IS NULL) = (addon_price_cents IS NULL)),
  CONSTRAINT plans_season_complete CHECK (NOT seasonal OR (season_from IS NOT NULL AND season_to IS NOT NULL))
);
CREATE INDEX plans_status_idx ON plans (status, name);

-- Down Migration
DROP TABLE plans;
