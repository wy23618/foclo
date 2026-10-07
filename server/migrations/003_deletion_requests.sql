BEGIN;
CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), requested_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'pending_policy_review');
CREATE UNIQUE INDEX deletion_request_pending ON account_deletion_requests(user_id) WHERE status='pending_policy_review';
INSERT INTO schema_migrations(version) VALUES(3);
COMMIT;
