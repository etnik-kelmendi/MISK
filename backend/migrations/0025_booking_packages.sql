-- Up Migration
-- D68: a booking can hold several services of one trade, done by one pro in one visit (a package). The
-- booking keeps its first service in service_id and all names in service_name; this table keeps each
-- service with its own price and length at the time of booking. Package bookings get 10% off the job.
CREATE TABLE booking_services (
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  service_id uuid NOT NULL REFERENCES services (id),
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  PRIMARY KEY (booking_id, position),
  UNIQUE (booking_id, service_id)
);

-- What the package discount took off the job price; 0 for a single service.
ALTER TABLE bookings ADD COLUMN package_discount_cents integer NOT NULL DEFAULT 0 CHECK (package_discount_cents >= 0);

-- Bookings made before packages have their one service.
INSERT INTO booking_services (booking_id, position, service_id, name, price_cents, duration_minutes)
SELECT b.id, 0, b.service_id, b.service_name, b.price_cents,
  GREATEST(1, (extract(epoch FROM (b.ends_at - b.starts_at)) / 60)::int)
FROM bookings b;

-- Down Migration
ALTER TABLE bookings DROP COLUMN package_discount_cents;
DROP TABLE booking_services;
