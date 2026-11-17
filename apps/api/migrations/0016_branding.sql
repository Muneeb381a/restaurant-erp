-- Up Migration
-- The restaurant's logo and each person's photo, kept in the database (like the dish photos) so the
-- till needs no file server or internet.
--
-- Logo: the app sends the picture three ways, already prepared in the browser: one to show on screen
-- (PNG/JPEG/WebP) and two black-and-white rasters for the thermal printer, one per paper width (58 mm
-- = 384 dots = 48 bytes a row, 80 mm = 576 dots = 72 bytes a row). The server never decodes images,
-- it only stores them and checks the sizes add up.
CREATE TABLE branch_logo (
  branch_id        uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  content_type     text   NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  display          bytea  NOT NULL CHECK (octet_length(display) BETWEEN 1 AND 300000),
  raster_58        bytea  NOT NULL,
  raster_58_height int    NOT NULL CHECK (raster_58_height BETWEEN 1 AND 600),
  raster_80        bytea  NOT NULL,
  raster_80_height int    NOT NULL CHECK (raster_80_height BETWEEN 1 AND 600),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(raster_58) = 48 * raster_58_height),
  CHECK (octet_length(raster_80) = 72 * raster_80_height)
);

CREATE TABLE user_avatars (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type text  NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data         bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 150000),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
