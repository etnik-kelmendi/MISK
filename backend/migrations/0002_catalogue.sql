-- Up Migration
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 40),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  icon text NOT NULL CHECK (icon IN ('leaf', 'hammer', 'drop', 'bolt', 'sparkle', 'brush', 'wrench', 'sun')),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Prices are euro cents. Size factors are percentages of the base price (D8).
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 100 AND 1000000),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 600 AND duration_minutes % 15 = 0),
  size_small_pct integer NOT NULL DEFAULT 100 CHECK (size_small_pct BETWEEN 50 AND 500),
  size_medium_pct integer NOT NULL DEFAULT 130 CHECK (size_medium_pct BETWEEN 50 AND 500),
  size_large_pct integer NOT NULL DEFAULT 170 CHECK (size_large_pct BETWEEN 50 AND 500),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_category_idx ON services (category_id, sort_order);

-- Postcodes MISK serves, with their centre point for travel-distance checks (D7).
CREATE TABLE postcodes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9 -]{1,9}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  active boolean NOT NULL DEFAULT true
);

-- Great-circle distance in kilometres between two points (haversine).
CREATE FUNCTION distance_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT 6371.0 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;

-- Marketplace settings: exactly one row.
CREATE TABLE settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  service_fee_cents integer NOT NULL DEFAULT 290 CHECK (service_fee_cents BETWEEN 0 AND 10000),
  pro_share_pct integer NOT NULL DEFAULT 82 CHECK (pro_share_pct BETWEEN 50 AND 95),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings DEFAULT VALUES;

-- Down Migration
DROP TABLE settings;
DROP FUNCTION distance_km;
DROP TABLE postcodes;
DROP TABLE services;
DROP TABLE categories;
