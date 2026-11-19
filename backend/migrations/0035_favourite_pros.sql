-- Up Migration
-- D83: customers save pros who did a job for them as favourites.
CREATE TABLE customer_favourite_pros (
  customer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pro_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, pro_id)
);
CREATE INDEX customer_favourite_pros_pro_idx ON customer_favourite_pros (pro_id);

-- Down Migration
DROP TABLE customer_favourite_pros;
