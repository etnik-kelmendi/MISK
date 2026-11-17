-- Up Migration
-- D73: Review & pay. How the customer chose to pay for a booking, so the next booking starts with the
-- same choice: a saved card (with its provider id), Apple Pay, Google Pay, or a new card.
ALTER TABLE bookings ADD COLUMN payment_choice text CHECK (payment_choice IN ('card', 'new_card', 'apple_pay', 'google_pay'));
ALTER TABLE bookings ADD COLUMN payment_card_id text CHECK (char_length(payment_card_id) <= 255);

-- Down Migration
ALTER TABLE bookings DROP COLUMN payment_card_id;
ALTER TABLE bookings DROP COLUMN payment_choice;
