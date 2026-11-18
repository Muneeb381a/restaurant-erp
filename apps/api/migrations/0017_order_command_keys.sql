-- Up Migration
-- A till that lost its connection keeps "add this dish" commands and sends them again when the
-- internet is back. If the first attempt reached the server but the answer was lost, the second must
-- not add the dish twice. Each such command carries a random key; the answer is stored with the key
-- IN THE SAME TRANSACTION as the change, so a repeat returns the stored answer and changes nothing.
-- Not financial history: rows are only a replay guard (they may be purged after a few days).

CREATE TABLE order_command_keys (
  key        text PRIMARY KEY CHECK (char_length(key) BETWEEN 8 AND 80),
  order_id   uuid NOT NULL REFERENCES orders(id),
  command    text NOT NULL,
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_command_keys_created_idx ON order_command_keys(created_at);
