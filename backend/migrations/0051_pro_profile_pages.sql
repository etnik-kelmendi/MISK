-- Up Migration
-- D100: the pro Profile and its pages. Work information (years of experience, an "About you" customers see), new
-- trades checked by MISK before they bring jobs, replies to reviews, a second document reminder 7 days before, the
-- pro's notification switches and "Download my data".

ALTER TABLE pro_profiles
  ADD COLUMN years_experience smallint CHECK (years_experience BETWEEN 0 AND 60),
  -- Plain text shown to customers on the booking page; never HTML.
  ADD COLUMN about text CHECK (char_length(about) BETWEEN 1 AND 400);

-- A trade an approved pro adds later waits for the team's check: no jobs in it until it is approved. Every trade
-- chosen until now was checked with the application, so existing rows count as approved.
ALTER TABLE pro_trades
  ADD COLUMN approved boolean NOT NULL DEFAULT true,
  ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX pro_trades_pending_idx ON pro_trades (requested_at) WHERE NOT approved;

-- The pro's one reply to a review, shown to the customer under their review and to the team. No edits.
ALTER TABLE ratings
  ADD COLUMN reply text CHECK (char_length(reply) BETWEEN 1 AND 500),
  ADD COLUMN replied_at timestamptz,
  ADD CONSTRAINT ratings_reply_complete CHECK ((reply IS NULL) = (replied_at IS NULL));
CREATE INDEX ratings_pro_created_idx ON ratings (pro_id, created_at DESC);

-- Reminders now go 30 days and 7 days before a document runs out, each once per cover date (D59 had only 30).
ALTER TABLE document_reminders ADD COLUMN days_before smallint NOT NULL DEFAULT 30 CHECK (days_before IN (30, 7));
ALTER TABLE document_reminders DROP CONSTRAINT document_reminders_pkey;
ALTER TABLE document_reminders ADD PRIMARY KEY (pro_id, kind, valid_until, days_before);

-- The team approves or declines a trade a pro added.
ALTER TABLE pro_admin_actions DROP CONSTRAINT pro_admin_actions_action_check;
ALTER TABLE pro_admin_actions ADD CONSTRAINT pro_admin_actions_action_check CHECK (action IN (
  'approved', 'info_requested', 'rejected', 'document_accepted', 'document_rejected', 'reminder_sent',
  'watch_list_on', 'watch_list_off', 'coaching_booked', 'jobs_paused', 'jobs_resumed', 'suspended',
  'reinstated', 'moved_to_pending', 'back_to_active', 'info_provided', 'trade_approved', 'trade_declined'));

-- The pro's Notifications switches (D100), next to the customers' topics (D92).
ALTER TABLE user_notification_prefs DROP CONSTRAINT user_notification_prefs_topic_check;
ALTER TABLE user_notification_prefs ADD CONSTRAINT user_notification_prefs_topic_check CHECK (topic IN (
  'booking_updates', 'pro_on_the_way', 'reminders', 'plan_changes', 'offers',
  'job_offers', 'offer_sound', 'schedule_changes', 'payouts', 'tips_news'));

-- "Download my data" (D100): one request a day; a worker emails the person's own data as a JSON file.
CREATE TABLE data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  requested_at timestamptz NOT NULL DEFAULT now(),
  attempts smallint NOT NULL DEFAULT 0,
  last_error text CHECK (char_length(last_error) <= 500),
  sent_at timestamptz,
  failed_at timestamptz
);
CREATE INDEX data_exports_user_idx ON data_exports (user_id, requested_at DESC);
CREATE INDEX data_exports_open_idx ON data_exports (requested_at) WHERE sent_at IS NULL AND failed_at IS NULL;

-- Down Migration
DROP TABLE data_exports;
DELETE FROM user_notification_prefs WHERE topic IN ('job_offers', 'offer_sound', 'schedule_changes', 'payouts', 'tips_news');
ALTER TABLE user_notification_prefs DROP CONSTRAINT user_notification_prefs_topic_check;
ALTER TABLE user_notification_prefs ADD CONSTRAINT user_notification_prefs_topic_check CHECK (topic IN (
  'booking_updates', 'pro_on_the_way', 'reminders', 'plan_changes', 'offers'));
DELETE FROM pro_admin_actions WHERE action IN ('trade_approved', 'trade_declined');
ALTER TABLE pro_admin_actions DROP CONSTRAINT pro_admin_actions_action_check;
ALTER TABLE pro_admin_actions ADD CONSTRAINT pro_admin_actions_action_check CHECK (action IN (
  'approved', 'info_requested', 'rejected', 'document_accepted', 'document_rejected', 'reminder_sent',
  'watch_list_on', 'watch_list_off', 'coaching_booked', 'jobs_paused', 'jobs_resumed', 'suspended',
  'reinstated', 'moved_to_pending', 'back_to_active', 'info_provided'));
DELETE FROM document_reminders WHERE days_before = 7;
ALTER TABLE document_reminders DROP CONSTRAINT document_reminders_pkey;
ALTER TABLE document_reminders ADD PRIMARY KEY (pro_id, kind, valid_until);
ALTER TABLE document_reminders DROP COLUMN days_before;
DROP INDEX ratings_pro_created_idx;
ALTER TABLE ratings DROP CONSTRAINT ratings_reply_complete, DROP COLUMN replied_at, DROP COLUMN reply;
DROP INDEX pro_trades_pending_idx;
DELETE FROM pro_trades WHERE NOT approved;
ALTER TABLE pro_trades DROP COLUMN requested_at, DROP COLUMN approved;
ALTER TABLE pro_profiles DROP COLUMN about, DROP COLUMN years_experience;
