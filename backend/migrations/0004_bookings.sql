-- Up Migration
ALTER TABLE users ADD COLUMN stripe_customer_id text UNIQUE;

-- A one-off job. Service name, prices and the pros' share are copied at booking time, so later
-- catalogue changes never alter what the customer agreed to.
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users (id),
  service_id uuid NOT NULL REFERENCES services (id),
  category_id uuid NOT NULL REFERENCES categories (id),
  service_name text NOT NULL,
  size text NOT NULL CHECK (size IN ('S', 'M', 'L')),
  address text NOT NULL CHECK (char_length(address) BETWEEN 3 AND 200),
  postcode text NOT NULL REFERENCES postcodes (code),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
    'awaiting_payment', 'searching', 'unassigned', 'accepted', 'on_the_way', 'working', 'completed', 'cancelled'
  )),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  pro_share_pct integer NOT NULL CHECK (pro_share_pct BETWEEN 50 AND 95),
  pro_id uuid REFERENCES users (id),
  payment_intent_id text UNIQUE,
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'held', 'captured', 'released', 'refunded', 'failed')),
  cancelled_by text CHECK (cancelled_by IN ('customer', 'admin', 'system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT bookings_pro_when_assigned CHECK (
    status NOT IN ('accepted', 'on_the_way', 'working', 'completed') OR pro_id IS NOT NULL
  ),
  -- A pro can never hold two jobs at the same time.
  CONSTRAINT bookings_no_double_booking EXCLUDE USING gist (
    pro_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (pro_id IS NOT NULL AND status IN ('accepted', 'on_the_way', 'working'))
);
CREATE INDEX bookings_customer_idx ON bookings (customer_id, starts_at DESC);
CREATE INDEX bookings_pro_idx ON bookings (pro_id, starts_at);
CREATE INDEX bookings_status_idx ON bookings (status, starts_at);
CREATE INDEX bookings_created_idx ON bookings (created_at);

-- Every status a booking passes through, for the customer's timeline and the admins' history.
CREATE TABLE booking_events (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, id);

CREATE TABLE booking_photos (
  upload_id uuid PRIMARY KEY REFERENCES uploads (id),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('customer', 'completion')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_photos_booking_idx ON booking_photos (booking_id, created_at);

-- A job offered to one pro at a time, each with a deadline to accept.
CREATE TABLE booking_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn')),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (booking_id, pro_id)
);
CREATE UNIQUE INDEX booking_offers_one_pending_idx ON booking_offers (booking_id) WHERE status = 'pending';
CREATE INDEX booking_offers_pro_idx ON booking_offers (pro_id, status);
CREATE INDEX booking_offers_expiry_idx ON booking_offers (expires_at) WHERE status = 'pending';

-- Extra work a pro asks for during a job; charged only after the customer approves.
CREATE TABLE extra_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 200),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 100 AND 100000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_payment', 'approved', 'declined', 'cancelled')),
  payment_intent_id text UNIQUE,
  payment_status text NOT NULL DEFAULT 'none'
    CHECK (payment_status IN ('none', 'pending', 'held', 'captured', 'released', 'refunded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX extra_requests_booking_idx ON extra_requests (booking_id, created_at);

CREATE TABLE ratings (
  booking_id uuid PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id),
  customer_id uuid NOT NULL REFERENCES users (id),
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ratings_pro_idx ON ratings (pro_id);

-- Money sent to a pro's Stripe account, one row per captured charge.
CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id),
  pro_id uuid NOT NULL REFERENCES users (id),
  payment_intent_id text NOT NULL UNIQUE,
  charge_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  transfer_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'reversed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_pending_idx ON payouts (status) WHERE status IN ('pending', 'failed');
CREATE INDEX payouts_pro_idx ON payouts (pro_id, created_at);

-- Stripe webhook events already handled, so a redelivered event changes nothing.
CREATE TABLE stripe_events (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE stripe_events;
DROP TABLE payouts;
DROP TABLE ratings;
DROP TABLE extra_requests;
DROP TABLE booking_offers;
DROP TABLE booking_photos;
DROP TABLE booking_events;
DROP TABLE bookings;
ALTER TABLE users DROP COLUMN stripe_customer_id;
