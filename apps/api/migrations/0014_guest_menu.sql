-- Guest-facing menu information: what the QR menu shows beyond name and price.
-- Everything here is optional and display-only; it never touches orders, bills or prices.
ALTER TABLE items
  ADD COLUMN description        text,
  ADD COLUMN description_ur     text,
  -- an item the owner does not want guests to see (staff meals, off-menu specials): still sold at the till
  ADD COLUMN hidden_from_guests boolean NOT NULL DEFAULT false,
  ADD COLUMN guest_tags         text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN allergens          text[]  NOT NULL DEFAULT '{}',
  ADD CONSTRAINT items_guest_tags_known
    CHECK (guest_tags <@ ARRAY['HALAL', 'VEGETARIAN', 'SPICY', 'CHEF', 'NEW']::text[]),
  ADD CONSTRAINT items_allergens_known
    CHECK (allergens <@ ARRAY['MILK', 'GLUTEN', 'NUTS', 'EGG', 'SOY', 'FISH', 'SESAME', 'SHELLFISH']::text[]),
  ADD CONSTRAINT items_description_len CHECK (length(description) <= 300 AND length(description_ur) <= 300);

-- One small photo per item, stored in the database so the till needs no file server or internet.
-- The app shrinks every upload to ~800 px JPEG first; the cap is a backstop.
CREATE TABLE item_images (
  item_id      uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  content_type text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data         bytea       NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 600000),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
