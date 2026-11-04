-- Up Migration
-- Customers and pros may now also register with an email address and password, besides phone codes.
ALTER TABLE users ADD COLUMN last_name text CHECK (char_length(last_name) BETWEEN 1 AND 60);
ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;

ALTER TABLE users DROP CONSTRAINT users_email_admin_only;
ALTER TABLE users DROP CONSTRAINT users_sign_in_method;
ALTER TABLE users ADD CONSTRAINT users_sign_in_method CHECK (
  (role = 'admin' AND username IS NOT NULL AND password_hash IS NOT NULL AND phone IS NULL)
  OR (
    (role IS NULL OR role <> 'admin') AND username IS NULL
    AND (phone IS NOT NULL OR (email IS NOT NULL AND password_hash IS NOT NULL))
    -- A password always belongs to an email address, never to a phone-only account.
    AND (password_hash IS NULL OR email IS NOT NULL)
  )
);

-- Down Migration
ALTER TABLE users DROP CONSTRAINT users_sign_in_method;
ALTER TABLE users ADD CONSTRAINT users_sign_in_method CHECK (
  (role = 'admin' AND username IS NOT NULL AND password_hash IS NOT NULL AND phone IS NULL)
  OR ((role IS NULL OR role <> 'admin') AND phone IS NOT NULL AND username IS NULL AND password_hash IS NULL)
);
ALTER TABLE users ADD CONSTRAINT users_email_admin_only CHECK (email IS NULL OR role = 'admin');
ALTER TABLE users DROP COLUMN terms_accepted_at;
ALTER TABLE users DROP COLUMN last_name;
