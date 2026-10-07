BEGIN;
REVOKE ALL ON TABLE users,auth_identities,auth_sessions,auth_session_refresh_history,spaces,projects,study_sessions,pauses,account_preferences,sync_operations,sync_changes,sync_snapshots,snapshot_items,import_jobs,import_items,account_deletion_requests,schema_migrations FROM PUBLIC;
DO $$
DECLARE role_name text;
DECLARE table_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    FOREACH table_name IN ARRAY ARRAY['users','auth_identities','auth_sessions','auth_session_refresh_history','spaces','projects','study_sessions','pauses','account_preferences','sync_operations','sync_changes','sync_snapshots','snapshot_items','import_jobs','import_items','account_deletion_requests','schema_migrations'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name);
    END LOOP;
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(5);
COMMIT;
