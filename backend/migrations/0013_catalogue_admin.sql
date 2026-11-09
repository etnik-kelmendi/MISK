-- Up Migration
-- The Catalogue page: services paid per hour, and a log of every catalogue change.

-- 'hourly' services have one price per hour and no sizes; a booking costs that rate times the duration.
ALTER TABLE services ADD COLUMN pricing text NOT NULL DEFAULT 'fixed' CHECK (pricing IN ('fixed', 'hourly'));

-- A trade that is not active is a draft: the team is still setting it up, and customers never see it.
ALTER TABLE categories ALTER COLUMN active SET DEFAULT false;

CREATE TABLE catalogue_changes (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES users (id) ON DELETE SET NULL,
  category_id uuid NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  service_id uuid REFERENCES services (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'trade_added', 'trade_published', 'trade_unpublished', 'trade_edited',
    'service_added', 'service_edited', 'price_changed', 'service_hidden', 'service_shown')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalogue_changes_category_idx ON catalogue_changes (category_id, id DESC);

-- Down Migration
DROP TABLE catalogue_changes;
ALTER TABLE categories ALTER COLUMN active SET DEFAULT true;
ALTER TABLE services DROP COLUMN pricing;
