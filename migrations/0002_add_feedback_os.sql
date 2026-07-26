-- Ordered-run compatibility marker: `os` is part of the table definition in
-- 0001. Production already has this column and has recorded this migration.
-- Keep this migration as a no-op because SQLite has no ADD COLUMN IF NOT EXISTS.
SELECT 1 FROM pragma_table_info('feedback') WHERE name = 'os';
