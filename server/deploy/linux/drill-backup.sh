#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
archive=${1:?exact encrypted archive}
[[ "$archive" =~ ^/var/lib/yotick-backups/yotick-[0-9TZ]+\.dump\.enc$ && -f "$archive" ]] || exit 1
db="yotick_restore_drill_$(openssl rand -hex 6)"
clear="/root/${db}.dump"
umask 077
/usr/local/bin/node /opt/yotick/current/deploy/linux/backup/decrypt-backup.mjs "$archive" "$clear"
/usr/local/bin/node /opt/yotick/current/deploy/linux/backup-manifest.mjs "$clear" "$clear.manifest.json"
install -o postgres -g postgres -m 600 "$clear" "/var/lib/postgresql/${db}.dump"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $db TEMPLATE template0;"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d "$db" -c "REVOKE ALL ON DATABASE $db FROM PUBLIC, yotick_app;"
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges -d "$db" "/var/lib/postgresql/${db}.dump"
runuser -u postgres -- /usr/local/bin/node /opt/yotick/current/deploy/linux/verify-isolated-restore.mjs "$db" < "$clear.manifest.json" > "/root/${db}.json"
cat "/root/${db}.json"
# Database remains offline until newest independent deletion records are checked.
/usr/local/bin/node /opt/yotick/current/deploy/linux/reconcile-deletions.mjs "$db" > "/root/${db}-deletion-gate.json"
cat "/root/${db}-deletion-gate.json"
# Remove only this invocation's disposable plaintext; isolated DB/evidence remain.
rm "$clear" "/var/lib/postgresql/${db}.dump"
