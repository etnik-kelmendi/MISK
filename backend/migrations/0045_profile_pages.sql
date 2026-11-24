-- Up Migration
-- D92: the customer Profile pages.

-- Notes for the pro about a saved address, e.g. a gate code or where the key is. They fill in a new booking's
-- notes together with the address. Older addresses have none.
ALTER TABLE customer_addresses ADD COLUMN notes text CHECK (char_length(notes) BETWEEN 1 AND 200);

-- The language the person chose on Personal information. The app checks the code against the languages it
-- has texts for; the database only keeps it well formed.
ALTER TABLE users ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}$');

-- What a customer switched off on the Notifications page. A topic without a row has its default (every topic
-- on except offers). A switched-off topic is still written to the inbox in the app, and messages about
-- payments, safety and the account are always sent whatever is here.
CREATE TABLE user_notification_prefs (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  topic text NOT NULL CHECK (topic IN ('booking_updates', 'pro_on_the_way', 'reminders', 'plan_changes', 'offers')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);

-- Down Migration
DROP TABLE user_notification_prefs;
ALTER TABLE users DROP COLUMN language;
ALTER TABLE customer_addresses DROP COLUMN notes;
