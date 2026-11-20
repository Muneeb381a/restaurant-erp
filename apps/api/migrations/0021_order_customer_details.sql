-- Up Migration
-- A takeaway or delivery order can carry who it is for: a name and phone for the slips (the token, the kitchen
-- ticket, the bill) and, for a delivery, the address the rider needs. All optional, all editable while the order is
-- open; nothing else depends on them.
ALTER TABLE orders
  ADD COLUMN customer_name    text,
  ADD COLUMN customer_phone   text,
  ADD COLUMN delivery_address text,
  ADD CONSTRAINT orders_customer_text_len CHECK (
    length(coalesce(customer_name, '')) <= 80
    AND length(coalesce(customer_phone, '')) <= 30
    AND length(coalesce(delivery_address, '')) <= 300
  );
