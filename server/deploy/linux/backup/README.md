# Encrypted daily PostgreSQL backup

This is a same-host backup for Ubuntu 22.04, Node.js 24, and PostgreSQL 17. It does **not** provide off-host protection: loss, compromise, or disk failure of this server can take out both the database and every archive. Copy verified archives and the separately protected key to an independent off-host destination as a separately managed operation.

The systemd timer runs daily around 02:30 (with a randomized delay). The service runs as root so it can read the root-managed key, then invokes `pg_dump` as the `postgres` OS account through `runuser`; PostgreSQL's local peer authentication is used, with no database password. It dumps the `yotick` database in custom format and encrypts with AES-256-GCM using the same `YOTICKBK1` archive format as `server/local-dev/backup-crypto.mjs`. Only encrypted archives and JSON summaries are retained. Summaries contain timestamp, archive name, size, SHA-256, format, and database name; they never contain key material. There is no automatic retention deletion.

## Install

The backend release root is `/opt/yotick/current`; install this directory at `/opt/yotick/current/deploy/linux/backup/`. The unit expects Node.js at `/usr/local/bin/node`. Create the key and backup directory as root:

```sh
sudo install -d -o root -g root -m 0700 /etc/yotick /var/lib/yotick-backups
sudo sh -c 'umask 077; head -c 32 /dev/urandom > /etc/yotick/backup.key'
sudo chown root:root /etc/yotick/backup.key
sudo chmod 0600 /etc/yotick/backup.key
```

Keep a separately protected copy of the key outside this host; the encrypted archives cannot be recovered without it. Do not put the key in the application environment, release bundle, source control, archive directory, or summary. Confirm `/usr/sbin/runuser`, `/usr/bin/pg_dump` (PostgreSQL 17), and the `postgres` peer access to database `yotick` are present. The service intentionally fails if the key is not a root-owned regular file with mode `0600` and exactly 32 raw bytes.

Install and enable the units:

```sh
sudo install -o root -g root -m 0644 yotick-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 yotick-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yotick-backup.timer
sudo systemctl start yotick-backup.service
sudo systemctl status yotick-backup.service
sudo journalctl -u yotick-backup.service --no-pager
```

Success creates `yotick-<UTC timestamp>.dump.enc` and a neighboring `.json` summary. A failed dump/encryption exits nonzero and leaves a `.partial` file. A `.partial` file is never a successful archive and must not be selected for restore. Review disk capacity: this configuration never removes old archives. The service writes only within `/var/lib/yotick-backups` and the encrypted archive is mode `0600`.

## Decrypt and isolated restore

First copy the selected `.dump.enc` into a root-only staging location and verify its neighboring JSON SHA-256 before decrypting. Decryption is explicit and uses exclusive file creation, so it will not overwrite an existing dump:

```sh
sudo install -d -o root -g root -m 0700 /var/lib/yotick-restore
sudo /usr/local/bin/node /opt/yotick/current/deploy/linux/backup/decrypt-backup.mjs \
  /var/lib/yotick-backups/yotick-TIMESTAMP.dump.enc \
  /var/lib/yotick-restore/isolated.dump
sudo -u postgres pg_restore --list /var/lib/yotick-restore/isolated.dump
```

For a restore check, create a **new isolated database** and restore there, never over the live `yotick` database. Use a maintenance window or a separate PostgreSQL instance for a true isolation boundary; make sure the test target has no application traffic. For example, after reviewing database ownership and roles:

```sh
sudo -u postgres createdb yotick_restore_check
sudo -u postgres pg_restore --exit-on-error --no-owner --dbname=yotick_restore_check \
  /var/lib/yotick-restore/isolated.dump
sudo -u postgres dropdb yotick_restore_check
sudo rm -- /var/lib/yotick-restore/isolated.dump
```

The example removes only the explicitly named temporary database and dump after the check. Do not use it if that database already exists or contains needed data. A successful `pg_restore --list` checks archive readability; only a successful restore into the isolated target verifies restoration. Neither check makes this single-host arrangement an off-site backup.

## Local format checks

Run with Node.js 24: `node --test server/deploy/linux/backup/backup-crypto.test.mjs`. The tests cover round-trip decryption, ciphertext opacity, tampering, malformed input, and wrong-key rejection. The actual systemd service additionally treats `pg_dump` and encryption errors as failure and preserves an incomplete `.partial` artifact.
