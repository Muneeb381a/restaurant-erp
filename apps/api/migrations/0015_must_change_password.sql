-- Up Migration
-- A temporary password (a new restaurant's owner, or a reset by the platform admin) must be replaced
-- at the first sign-in. While the flag is set the server accepts only "who am I", "change my
-- password" and "sign out"; it is enforced in the API, not just hidden in the screen.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
