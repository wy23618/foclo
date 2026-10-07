-- Run as the database administrator after migrations, against the intended DB.
-- Provision the login and secret outside this file. No password is stored here.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='yotick_app' AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Provision yotick_app as a non-administrative role first';
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM yotick_app;
GRANT USAGE ON SCHEMA public TO yotick_app;
REVOKE ALL ON TABLE schema_migrations FROM yotick_app;
GRANT SELECT ON TABLE schema_migrations TO yotick_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users,auth_identities,auth_sessions,auth_session_refresh_history,spaces,projects,study_sessions,pauses,account_preferences,sync_operations,sync_changes,sync_snapshots,snapshot_items,import_jobs,import_items,account_deletion_requests TO yotick_app;
DO $$ BEGIN
  IF has_schema_privilege('yotick_app','public','CREATE') OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND r.rolname='yotick_app'
  ) THEN
    RAISE EXCEPTION 'yotick_app must not own business tables or inherit schema CREATE';
  END IF;
END $$;
COMMIT;
