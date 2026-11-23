-- Up Migration
-- D89: the customer Home page.

-- Saved addresses. A customer keeps up to 10 (checked by the API); exactly one is selected while any exist,
-- and the selected one drives Home ("Top rated near you") and pre-fills a new booking. The postcode is a
-- served zone when the address is saved; its centre point is copied for distance checks.
CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label text CHECK (char_length(label) BETWEEN 1 AND 30),
  address text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 200),
  postcode text NOT NULL REFERENCES postcodes (code),
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  is_selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (customer_id, created_at);
CREATE UNIQUE INDEX customer_addresses_one_selected_idx ON customer_addresses (customer_id) WHERE is_selected;

-- Every customer who booked or subscribed before starts with the address of their latest booking or plan.
INSERT INTO customer_addresses (customer_id, label, address, postcode, lat, lng, is_selected, created_at)
SELECT DISTINCT ON (latest.customer_id) latest.customer_id, 'Home', btrim(latest.address), latest.postcode, pc.lat, pc.lng, true, now()
FROM (
  SELECT customer_id, address, postcode, created_at FROM bookings
  UNION ALL
  SELECT customer_id, address, postcode, created_at FROM subscriptions
) latest
JOIN postcodes pc ON pc.code = latest.postcode
JOIN users u ON u.id = latest.customer_id
WHERE char_length(btrim(latest.address)) BETWEEN 3 AND 200
ORDER BY latest.customer_id, latest.created_at DESC;

-- The pro the customer picked on Home: they get the job offer first, then normal dispatch takes over.
ALTER TABLE bookings ADD COLUMN preferred_pro_id uuid REFERENCES users (id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE bookings DROP COLUMN preferred_pro_id;
DROP TABLE customer_addresses;
