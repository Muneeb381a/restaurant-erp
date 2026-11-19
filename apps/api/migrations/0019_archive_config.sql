-- Up Migration
-- The same "delete archives what history points at" as dishes and tables (0018), for kitchen stations,
-- floor areas and printers. A station that old kitchen tickets point at, an area that old tables sat in
-- or a printer with old print jobs can now be removed from the shop for good: it is hidden from every
-- list and the code is free again, while the old records keep working.

ALTER TABLE stations ADD COLUMN archived_at timestamptz;
ALTER TABLE areas    ADD COLUMN archived_at timestamptz;
ALTER TABLE printers ADD COLUMN archived_at timestamptz;

ALTER TABLE stations DROP CONSTRAINT stations_branch_id_code_key;
CREATE UNIQUE INDEX stations_branch_code_live ON stations (branch_id, code) WHERE archived_at IS NULL;
