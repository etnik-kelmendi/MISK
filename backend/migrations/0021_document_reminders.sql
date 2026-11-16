-- Up Migration
-- The automatic reminder 30 days before a pro's document runs out (D59) goes once per cover date: a renewed
-- document gets a new cover date and with it its own reminder later.
CREATE TABLE document_reminders (
  pro_id uuid NOT NULL REFERENCES pro_profiles (user_id) ON DELETE CASCADE,
  kind text NOT NULL,
  valid_until date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pro_id, kind, valid_until)
);

-- An email may say more than a text message: up to 4000 characters; SMS and push stay within 640.
ALTER TABLE notifications DROP CONSTRAINT notifications_body_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_body_check
  CHECK (char_length(body) BETWEEN 1 AND CASE WHEN channel = 'email' THEN 4000 ELSE 640 END);

-- Down Migration
ALTER TABLE notifications DROP CONSTRAINT notifications_body_check;
UPDATE notifications SET body = left(body, 639) || '…' WHERE char_length(body) > 640;
ALTER TABLE notifications ADD CONSTRAINT notifications_body_check CHECK (char_length(body) BETWEEN 1 AND 640);
DROP TABLE document_reminders;
