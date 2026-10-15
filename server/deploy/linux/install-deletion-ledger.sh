#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
install -d -o root -g root -m 700 /var/lib/yotick-deletion-ledger
if [[ ! -e /var/lib/yotick-deletion-ledger/initialized ]]; then
  # Initialize only for this audited development deployment, before any purge.
  [[ $(find /var/lib/yotick-deletion-ledger -mindepth 1 | wc -l) == 0 ]] || exit 1
  umask 077
  printf '%s\n' YOTICK_DELETION_LEDGER_V1 > /var/lib/yotick-deletion-ledger/initialized
  sync -f /var/lib/yotick-deletion-ledger/initialized
  sync -f /var/lib/yotick-deletion-ledger
fi
[[ -f /root/yotick-before-admin-pg_ident.conf ]] || cp --preserve=mode /etc/postgresql/17/main/pg_ident.conf /root/yotick-before-admin-pg_ident.conf
[[ -f /root/yotick-before-admin-pg_hba.conf ]] || cp --preserve=mode /etc/postgresql/17/main/pg_hba.conf /root/yotick-before-admin-pg_hba.conf
grep -q '^yotick_admin root postgres$' /etc/postgresql/17/main/pg_ident.conf || printf '\nyotick_admin root postgres\nyotick_admin postgres postgres\n' >> /etc/postgresql/17/main/pg_ident.conf
sed -i 's/^local all postgres peer$/local all postgres peer map=yotick_admin/' /etc/postgresql/17/main/pg_hba.conf
chown root:postgres /etc/postgresql/17/main/pg_ident.conf /etc/postgresql/17/main/pg_hba.conf
chmod 640 /etc/postgresql/17/main/pg_ident.conf /etc/postgresql/17/main/pg_hba.conf
chmod 600 /root/yotick-before-admin-pg_ident.conf /root/yotick-before-admin-pg_hba.conf
systemctl reload postgresql@17-main
# Both approved OS identities must still work; the API OS user is not mapped.
psql -X -U postgres -d postgres -Atc 'SELECT current_user'
runuser -u postgres -- psql -X -d postgres -Atc 'SELECT current_user'
