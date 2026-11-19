-- Up Migration
-- D83: a pro's profile photo, shown to their customers on the booking, rating and chat pages. Removing the
-- photo deletes the upload, which clears this column.
ALTER TABLE pro_profiles ADD COLUMN photo_upload_id uuid REFERENCES uploads (id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE pro_profiles DROP COLUMN photo_upload_id;
