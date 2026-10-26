BEGIN;
CREATE TABLE focus_presence (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  device_id uuid NOT NULL, generation bigint NOT NULL, session_id uuid NOT NULL,
  started_at_sec bigint NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(space_id,device_id)
);
REVOKE ALL ON TABLE focus_presence FROM PUBLIC;
INSERT INTO schema_migrations(version) VALUES(6);
COMMIT;
