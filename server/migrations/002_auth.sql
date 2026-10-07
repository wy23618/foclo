BEGIN;
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  space_id uuid NOT NULL REFERENCES spaces(id),
  family_id uuid NOT NULL,
  access_token_hash bytea NOT NULL UNIQUE,
  refresh_token_hash bytea NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);
ALTER TABLE spaces ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX auth_sessions_family_active ON auth_sessions(family_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_user_active ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE auth_session_refresh_history (
  session_id uuid NOT NULL REFERENCES auth_sessions(id),
  token_hash bytea NOT NULL,
  rotated_at timestamptz NOT NULL,
  replay_until timestamptz NOT NULL,
  response_ciphertext bytea NOT NULL,
  response_nonce bytea NOT NULL,
  response_tag bytea NOT NULL,
  PRIMARY KEY(session_id, token_hash)
);
CREATE UNIQUE INDEX auth_session_refresh_history_token ON auth_session_refresh_history(token_hash);
INSERT INTO schema_migrations(version) VALUES(2);
COMMIT;
