-- Up Migration
-- D83: how long the extra work takes, so the customer sees "About 30 min" on the request. Required for new
-- requests by the API; older requests have none.
ALTER TABLE extra_requests ADD COLUMN duration_minutes smallint CHECK (duration_minutes BETWEEN 5 AND 480);

-- Down Migration
ALTER TABLE extra_requests DROP COLUMN duration_minutes;
