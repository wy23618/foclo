BEGIN;
ALTER TABLE auth_sessions ADD COLUMN device_id uuid;
INSERT INTO schema_migrations(version) VALUES(4);
COMMIT;
