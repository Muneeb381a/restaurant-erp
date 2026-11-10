-- Up Migration
-- Urdu receipts (bitmap): the restaurant's Urdu name. Item names already have name_ur / name_ur_snapshot.
ALTER TABLE branches ADD COLUMN name_ur text;
