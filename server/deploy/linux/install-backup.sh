#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && -f /opt/yotick/current/deploy/linux/backup/yotick-backup.mjs ]] || exit 1
install -d -o root -g root -m 700 /var/lib/yotick-backups
if [[ ! -e /etc/yotick/backup.key ]]; then
  umask 077
  openssl rand -out /etc/yotick/backup.key 32
fi
[[ $(stat -c '%U:%a:%s' /etc/yotick/backup.key) == root:600:32 ]] || exit 1
install -o root -g root -m 644 /opt/yotick/current/deploy/linux/backup/yotick-backup.service /etc/systemd/system/yotick-backup.service
install -o root -g root -m 644 /opt/yotick/current/deploy/linux/backup/yotick-backup.timer /etc/systemd/system/yotick-backup.timer
systemd-analyze verify /etc/systemd/system/yotick-backup.service /etc/systemd/system/yotick-backup.timer
systemctl daemon-reload
systemctl start yotick-backup.service
systemctl enable --now yotick-backup.timer
systemctl show yotick-backup.service -p Result -p ExecMainStatus
systemctl list-timers yotick-backup.timer --no-pager
