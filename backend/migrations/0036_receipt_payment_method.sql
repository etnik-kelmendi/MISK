-- Up Migration
-- D83: how the customer paid, shown on the receipt ("Visa •••• 4242", "Apple Pay · Visa •••• 4242"). Read
-- from the payment provider once and kept here, so receipts do not ask the provider every time.
ALTER TABLE bookings
  ADD COLUMN payment_method_brand text CHECK (char_length(payment_method_brand) BETWEEN 1 AND 40),
  ADD COLUMN payment_method_last4 text CHECK (payment_method_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN payment_method_wallet text CHECK (char_length(payment_method_wallet) BETWEEN 1 AND 40);

-- Down Migration
ALTER TABLE bookings
  DROP COLUMN payment_method_wallet,
  DROP COLUMN payment_method_last4,
  DROP COLUMN payment_method_brand;
