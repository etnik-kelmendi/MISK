-- Up Migration
-- Files people send: pro documents and job photos. Stored under random keys, read through checked routes.
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('document', 'photo')),
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_owner_idx ON uploads (owner_id);

CREATE TABLE pro_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'suspended')),
  home_postcode text REFERENCES postcodes (code),
  radius_km integer NOT NULL DEFAULT 12 CHECK (radius_km BETWEEN 3 AND 30),
  -- ISO weekdays, 1 = Monday.
  working_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}' CHECK (working_days <@ '{1,2,3,4,5,6,7}'),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users (id),
  review_note text CHECK (char_length(review_note) <= 500),
  stripe_account_id text UNIQUE,
  payouts_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pro_profiles_status_idx ON pro_profiles (status);

CREATE TABLE pro_trades (
  pro_id uuid NOT NULL REFERENCES pro_profiles (user_id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories (id),
  PRIMARY KEY (pro_id, category_id)
);
CREATE INDEX pro_trades_category_idx ON pro_trades (category_id);

CREATE TABLE pro_documents (
  pro_id uuid NOT NULL REFERENCES pro_profiles (user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('id', 'certificate', 'insurance')),
  upload_id uuid NOT NULL REFERENCES uploads (id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_id, kind)
);

-- Down Migration
DROP TABLE pro_documents;
DROP TABLE pro_trades;
DROP TABLE pro_profiles;
DROP TABLE uploads;
