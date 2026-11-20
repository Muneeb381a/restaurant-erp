-- Up Migration
-- An order that came in through Foodpanda, WhatsApp, the phone or the website carries that platform's own order
-- number, so the kitchen ticket, the token and the bill can show it ("FOODPANDA  #A1B2C3") and the counter can match
-- the rider's order to the paper. The channel itself already exists on orders.
ALTER TABLE orders
  ADD COLUMN external_ref text,
  ADD CONSTRAINT orders_external_ref_len CHECK (length(coalesce(external_ref, '')) <= 40);
