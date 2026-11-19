-- Up Migration
-- D83: while a pro is on the way to a job, the app shares their latest position so the customer sees it on a
-- map with the expected arrival time. Only the latest position is kept, on the booking itself, and only while
-- the booking is on the way: any change of status clears it (privacy), enforced by the trigger and checks.
ALTER TABLE bookings
  ADD COLUMN pro_lat double precision CHECK (pro_lat BETWEEN -90 AND 90),
  ADD COLUMN pro_lng double precision CHECK (pro_lng BETWEEN -180 AND 180),
  ADD COLUMN pro_location_at timestamptz,
  ADD CONSTRAINT bookings_pro_location_complete CHECK (
    (pro_lat IS NULL) = (pro_lng IS NULL) AND (pro_lat IS NULL) = (pro_location_at IS NULL)
  ),
  ADD CONSTRAINT bookings_pro_location_on_the_way CHECK (pro_lat IS NULL OR status = 'on_the_way');

CREATE FUNCTION clear_pro_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'on_the_way' THEN
    NEW.pro_lat := NULL;
    NEW.pro_lng := NULL;
    NEW.pro_location_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bookings_clear_pro_location
  BEFORE UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION clear_pro_location();

-- Down Migration
DROP TRIGGER bookings_clear_pro_location ON bookings;
DROP FUNCTION clear_pro_location();
ALTER TABLE bookings
  DROP CONSTRAINT bookings_pro_location_on_the_way,
  DROP CONSTRAINT bookings_pro_location_complete,
  DROP COLUMN pro_location_at,
  DROP COLUMN pro_lng,
  DROP COLUMN pro_lat;
