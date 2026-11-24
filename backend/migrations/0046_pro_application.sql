-- Up Migration
-- The pro Application and Application status pages (D93).

ALTER TABLE pro_profiles
  -- Street and house number of the pro's home. Private: only the pro and the MISK team see it; jobs are
  -- matched by distance from home_postcode.
  ADD COLUMN home_address text CHECK (char_length(home_address) BETWEEN 3 AND 200),
  -- When the pro ticked "I agree to a background check".
  ADD COLUMN background_consent_at timestamptz,
  -- The documents the team asked for again with "Request info"; uploading all of them sends the
  -- application back to review where it stopped.
  ADD COLUMN requested_documents text[] NOT NULL DEFAULT '{}'
    CHECK (requested_documents <@ ARRAY['id', 'certificate', 'insurance']::text[]),
  -- When the team turned the application down; the pro can apply again 6 months later.
  ADD COLUMN rejected_at timestamptz;

UPDATE pro_profiles SET rejected_at = COALESCE(reviewed_at, updated_at) WHERE status = 'rejected';

-- Pros who already sent a certificate of good conduct agreed to being checked when they sent it.
UPDATE pro_profiles p SET background_consent_at = d.uploaded_at
FROM pro_documents d WHERE d.pro_id = p.user_id AND d.kind = 'background';

-- The background check is no longer a file: agreeing to it starts the check with MISK's partner, and the
-- team records "clear" or "not clear" on the check. Earlier uploaded certificates stay as they are.
ALTER TABLE pro_documents ALTER COLUMN upload_id DROP NOT NULL;
ALTER TABLE pro_documents ADD CONSTRAINT pro_documents_upload_check CHECK (upload_id IS NOT NULL OR kind = 'background');

-- Trades whose pros need no trade certificate (cleaning); every other trade still needs one.
ALTER TABLE categories ADD COLUMN needs_certificate boolean NOT NULL DEFAULT true;
UPDATE categories SET needs_certificate = false WHERE slug = 'cleaning';

-- The pro sent the documents the team asked for.
ALTER TABLE pro_admin_actions DROP CONSTRAINT pro_admin_actions_action_check;
ALTER TABLE pro_admin_actions ADD CONSTRAINT pro_admin_actions_action_check CHECK (action IN (
  'approved', 'info_requested', 'rejected', 'document_accepted', 'document_rejected', 'reminder_sent',
  'watch_list_on', 'watch_list_off', 'coaching_booked', 'jobs_paused', 'jobs_resumed', 'suspended',
  'reinstated', 'moved_to_pending', 'back_to_active', 'info_provided'));

-- Down Migration
DELETE FROM pro_admin_actions WHERE action = 'info_provided';
ALTER TABLE pro_admin_actions DROP CONSTRAINT pro_admin_actions_action_check;
ALTER TABLE pro_admin_actions ADD CONSTRAINT pro_admin_actions_action_check CHECK (action IN (
  'approved', 'info_requested', 'rejected', 'document_accepted', 'document_rejected', 'reminder_sent',
  'watch_list_on', 'watch_list_off', 'coaching_booked', 'jobs_paused', 'jobs_resumed', 'suspended',
  'reinstated', 'moved_to_pending', 'back_to_active'));
ALTER TABLE categories DROP COLUMN needs_certificate;
DELETE FROM pro_documents WHERE upload_id IS NULL;
ALTER TABLE pro_documents DROP CONSTRAINT pro_documents_upload_check;
ALTER TABLE pro_documents ALTER COLUMN upload_id SET NOT NULL;
ALTER TABLE pro_profiles DROP COLUMN rejected_at, DROP COLUMN requested_documents, DROP COLUMN background_consent_at,
  DROP COLUMN home_address;
