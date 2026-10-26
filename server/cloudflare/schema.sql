-- Cloudflare schema v1; empty cloud store only. Legacy PostgreSQL migrations are retained.
CREATE TABLE IF NOT EXISTS focus_presence(space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,device_id TEXT NOT NULL,generation INTEGER NOT NULL,session_id TEXT NOT NULL,started_at_sec INTEGER NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(space_id,device_id));

CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS auth_identities(provider text NOT NULL, app_id text NOT NULL, subject text NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(provider,app_id,subject));
CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0), change_seq INTEGER NOT NULL DEFAULT 0, next_order INTEGER NOT NULL DEFAULT 1, restore_epoch TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS projects(space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, generation INTEGER NOT NULL, name text NOT NULL, parent_id TEXT, order_key INTEGER NOT NULL, server_version INTEGER NOT NULL CHECK(server_version>0), data TEXT NOT NULL, deleted_at TEXT, PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,parent_id) REFERENCES projects(space_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE UNIQUE INDEX IF NOT EXISTS project_live_name ON projects(space_id,name COLLATE BINARY) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS study_sessions(space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, generation INTEGER NOT NULL, project_id TEXT NOT NULL, origin_device_id TEXT NOT NULL, server_version INTEGER NOT NULL, data TEXT NOT NULL, deleted_at TEXT, received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,project_id) REFERENCES projects(space_id,id));
CREATE TABLE IF NOT EXISTS pauses(space_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,session_id) REFERENCES study_sessions(space_id,id));
CREATE TABLE IF NOT EXISTS account_preferences(space_id TEXT PRIMARY KEY REFERENCES spaces(id), generation INTEGER NOT NULL, server_version INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_operations(space_id TEXT NOT NULL REFERENCES spaces(id), generation INTEGER NOT NULL, operation_id TEXT NOT NULL, request_hash text NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(space_id,generation,operation_id));
CREATE TABLE IF NOT EXISTS sync_changes(space_id TEXT NOT NULL REFERENCES spaces(id), generation INTEGER NOT NULL, seq INTEGER NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, server_version INTEGER NOT NULL, data TEXT, deleted boolean NOT NULL DEFAULT false, PRIMARY KEY(space_id,generation,seq));
CREATE TABLE IF NOT EXISTS sync_snapshots(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), generation INTEGER NOT NULL, upper_seq INTEGER NOT NULL, restore_epoch TEXT NOT NULL, expires_at TEXT NOT NULL, kind text NOT NULL CHECK(kind IN ('snapshot','export')));
CREATE TABLE IF NOT EXISTS snapshot_items(snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE, ordinal integer NOT NULL, data TEXT NOT NULL, PRIMARY KEY(snapshot_id,ordinal));
CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), generation INTEGER NOT NULL, source_id text NOT NULL, chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 1000), status text NOT NULL DEFAULT 'uploading', mapping TEXT NOT NULL DEFAULT '{}', result TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')));
CREATE TABLE IF NOT EXISTS import_items(job_id TEXT NOT NULL REFERENCES import_jobs(id), chunk_index integer NOT NULL, digest text NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,chunk_index));
INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);



CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  family_id TEXT NOT NULL,
  access_token_hash BLOB NOT NULL UNIQUE,
  refresh_token_hash BLOB NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_agent text, device_id TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_family_active ON auth_sessions(family_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_user_active ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS auth_session_refresh_history (
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  token_hash BLOB NOT NULL,
  rotated_at TEXT NOT NULL,
  replay_until TEXT NOT NULL,
  response_ciphertext BLOB NOT NULL,
  response_nonce BLOB NOT NULL,
  response_tag BLOB NOT NULL,
  PRIMARY KEY(session_id, token_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_session_refresh_history_token ON auth_session_refresh_history(token_hash);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(2);



CREATE TABLE IF NOT EXISTS account_deletion_requests(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), status text NOT NULL DEFAULT 'pending_policy_review');
CREATE UNIQUE INDEX IF NOT EXISTS deletion_request_pending ON account_deletion_requests(user_id) WHERE status='pending_policy_review';
INSERT OR IGNORE INTO schema_migrations(version) VALUES(3);




INSERT OR IGNORE INTO schema_migrations(version) VALUES(4);


INSERT OR IGNORE INTO schema_migrations(version) VALUES(5);
