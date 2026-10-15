#!/usr/bin/env bash
# Fresh Ubuntu 22.04 host only. Does not initialize YoTick or expose ports.
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 22.04
if command -v node >/dev/null || command -v psql >/dev/null; then
  echo 'Existing Node/PostgreSQL detected; review before installation.' >&2
  exit 1
fi
test ! -e /etc/apt/sources.list.d/yotick-pgdg.sources
test ! -e /usr/local/lib/node-v24.21.0-linux-x64
runtime_work=$(mktemp -d /root/yotick-runtime.XXXXXX)
cd "$runtime_work"
curl --fail --location --retry 2 --max-time 300 -O https://nodejs.org/download/release/v24.21.0/node-v24.21.0-linux-x64.tar.xz
curl --fail --location --retry 2 --max-time 60 -O https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt
awk '$2 == "node-v24.21.0-linux-x64.tar.xz"' SHASUMS256.txt > node.sha256
test -s node.sha256
sha256sum --check node.sha256
tar -xJf node-v24.21.0-linux-x64.tar.xz -C /usr/local/lib
for runtime_binary in node npm npx; do
  test ! -e "/usr/local/bin/$runtime_binary"
  ln -s "/usr/local/lib/node-v24.21.0-linux-x64/bin/$runtime_binary" "/usr/local/bin/$runtime_binary"
done
install -d -m 0755 /usr/share/postgresql-common/pgdg
curl --fail --location --retry 2 --max-time 60 -o /usr/share/postgresql-common/pgdg/yotick-postgresql.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
cat > /etc/apt/sources.list.d/yotick-pgdg.sources <<'PGDG'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: jammy-pgdg
Architectures: amd64
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/yotick-postgresql.asc
PGDG
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-17 postgresql-client-17
node --version
psql --version
pg_lsclusters
echo YOTICK_RUNTIME_READY
