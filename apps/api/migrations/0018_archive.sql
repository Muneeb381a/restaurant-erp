-- Up Migration
-- "Delete" for something history points at. A dish, a size or a table that appears on past orders and
-- bills cannot be removed (those records must stay complete), but the shop must be able to get rid of it.
-- Deleting such a row now ARCHIVES it: it is switched off and hidden from every list for good, while the
-- old bills keep its name. Its code or name becomes free again for a new dish or table.

ALTER TABLE items          ADD COLUMN archived_at timestamptz;
ALTER TABLE item_variants  ADD COLUMN archived_at timestamptz;
ALTER TABLE dining_tables  ADD COLUMN archived_at timestamptz;

-- the code is unique only among the live rows
ALTER TABLE items         DROP CONSTRAINT items_branch_id_code_key;
CREATE UNIQUE INDEX items_branch_code_live ON items (branch_id, code) WHERE archived_at IS NULL;
ALTER TABLE dining_tables DROP CONSTRAINT dining_tables_branch_id_code_key;
CREATE UNIQUE INDEX dining_tables_branch_code_live ON dining_tables (branch_id, code) WHERE archived_at IS NULL;
