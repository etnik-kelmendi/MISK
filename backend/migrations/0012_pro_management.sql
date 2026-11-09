-- Up Migration
-- The Providers page: four checks per pro, document expiry and review, quality controls, and a log.

-- New pro states: the team asked the applicant for more information, or a required document ran out.
ALTER TABLE pro_profiles DROP CONSTRAINT pro_profiles_status_check;
ALTER TABLE pro_profiles ADD CONSTRAINT pro_profiles_status_check
  CHECK (status IN ('draft', 'submitted', 'info_requested', 'approved', 'pending_approval', 'rejected', 'suspended'));

ALTER TABLE pro_profiles
  -- Set while the team has paused new jobs for this pro; the pro stays active.
  ADD COLUMN jobs_paused_at timestamptz,
  ADD COLUMN watch_list_at timestamptz,
  ADD COLUMN coaching_call_at timestamptz,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text CHECK (char_length(suspended_reason) <= 500);

-- The fourth check: a certificate of good conduct (background check).
ALTER TABLE pro_documents DROP CONSTRAINT pro_documents_kind_check;
ALTER TABLE pro_documents ADD CONSTRAINT pro_documents_kind_check
  CHECK (kind IN ('id', 'certificate', 'insurance', 'background'));

ALTER TABLE pro_documents
  ADD COLUMN file_name text NOT NULL DEFAULT '' CHECK (char_length(file_name) <= 120),
  -- The expiry printed on the document, as the pro entered it; the team can correct it when accepting.
  ADD COLUMN expires_on date,
  ADD COLUMN review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'accepted', 'rejected')),
  ADD COLUMN review_note text CHECK (char_length(review_note) <= 500),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Until when the pro is covered by an accepted copy of this document ('infinity' when it never runs out).
  -- A new copy waiting for review keeps the old cover, so renewing early never stops the pro's jobs.
  ADD COLUMN valid_until date;

-- Documents of pros the team already approved were checked then.
UPDATE pro_documents d SET review_status = 'accepted', valid_until = 'infinity', reviewed_at = p.reviewed_at
FROM pro_profiles p
WHERE p.user_id = d.pro_id AND p.status IN ('approved', 'suspended');

CREATE TABLE pro_admin_actions (
  id bigserial PRIMARY KEY,
  pro_id uuid NOT NULL REFERENCES pro_profiles (user_id) ON DELETE CASCADE,
  -- Null when MISK did it by itself, e.g. moving a pro whose insurance ran out to Pending approval.
  admin_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'approved', 'info_requested', 'rejected', 'document_accepted', 'document_rejected', 'reminder_sent',
    'watch_list_on', 'watch_list_off', 'coaching_booked', 'jobs_paused', 'jobs_resumed', 'suspended',
    'reinstated', 'moved_to_pending', 'back_to_active')),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pro_admin_actions_pro_idx ON pro_admin_actions (pro_id, id DESC);

-- Down Migration
DROP TABLE pro_admin_actions;
ALTER TABLE pro_documents DROP COLUMN valid_until, DROP COLUMN reviewed_by,
  DROP COLUMN reviewed_at, DROP COLUMN review_note, DROP COLUMN review_status, DROP COLUMN expires_on, DROP COLUMN file_name;
DELETE FROM pro_documents WHERE kind = 'background';
ALTER TABLE pro_documents DROP CONSTRAINT pro_documents_kind_check;
ALTER TABLE pro_documents ADD CONSTRAINT pro_documents_kind_check CHECK (kind IN ('id', 'certificate', 'insurance'));
ALTER TABLE pro_profiles DROP COLUMN suspended_reason, DROP COLUMN suspended_at, DROP COLUMN coaching_call_at,
  DROP COLUMN watch_list_at, DROP COLUMN jobs_paused_at;
UPDATE pro_profiles SET status = 'submitted' WHERE status = 'info_requested';
UPDATE pro_profiles SET status = 'approved' WHERE status = 'pending_approval';
ALTER TABLE pro_profiles DROP CONSTRAINT pro_profiles_status_check;
ALTER TABLE pro_profiles ADD CONSTRAINT pro_profiles_status_check
  CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'suspended'));
