#!/usr/bin/env bash
# Isolated WSL integration check for activate-release.sh. Never touches a live host.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run this test as root in isolated WSL' >&2; exit 1; }
[[ ! -e /opt/yotick ]] || { echo 'Refusing: /opt/yotick already exists in this environment' >&2; exit 1; }
activate=${1:?path to activate-release.sh required}
[[ -f "$activate" ]] || { echo 'Activation script not found' >&2; exit 1; }

lock_was_present=0
[[ -e /run/lock/yotick-release.lock ]] && lock_was_present=1
cleanup() {
  rm -f /opt/yotick/current
  rm -rf /opt/yotick/releases/yotick-test-old /opt/yotick/releases/yotick-test-good /opt/yotick/releases/yotick-test-bad
  rmdir /opt/yotick/releases 2>/dev/null || true
  rmdir /opt/yotick 2>/dev/null || true
  if [[ $lock_was_present == 0 ]]; then rm -f /run/lock/yotick-release.lock; fi
  rm -rf "$mockbin"
}
mockbin=$(mktemp -d)
trap cleanup EXIT
mkdir -p /opt/yotick/releases/yotick-test-{old,good,bad}/dist/src
for version in old good bad; do : > "/opt/yotick/releases/yotick-test-$version/dist/src/index.js"; done
ln -s /opt/yotick/releases/yotick-test-old /opt/yotick/current
cat > "$mockbin/systemctl" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  'restart yotick.service') exit 0 ;;
  'stop yotick.service') : > "$MOCKBIN_STOPPED"; exit 0 ;;
  *) exit 1 ;;
esac
MOCK
cat > "$mockbin/curl" <<'MOCK'
#!/usr/bin/env bash
[[ $(readlink -f /opt/yotick/current) != */yotick-test-bad ]]
MOCK
cat > "$mockbin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$mockbin"/*
export PATH="$mockbin:$PATH"
export MOCKBIN_STOPPED="$mockbin/stopped"

bash "$activate" /opt/yotick/releases/yotick-test-good
[[ $(readlink -f /opt/yotick/current) == /opt/yotick/releases/yotick-test-good ]]

set +e
bash "$activate" /opt/yotick/releases/yotick-test-bad >/dev/null 2>&1
failed_status=$?
set -e
[[ $failed_status == 1 && $(readlink -f /opt/yotick/current) == /opt/yotick/releases/yotick-test-good ]]

set +e
flock -n /run/lock/yotick-release.lock bash "$activate" /opt/yotick/releases/yotick-test-old >/dev/null 2>&1
locked_status=$?
set -e
[[ $locked_status == 1 && $(readlink -f /opt/yotick/current) == /opt/yotick/releases/yotick-test-good ]]

rm /opt/yotick/current
set +e
bash "$activate" /opt/yotick/releases/yotick-test-bad >/dev/null 2>&1
first_release_status=$?
set -e
[[ $first_release_status == 2 && ! -e /opt/yotick/current && ! -L /opt/yotick/current && -f "$MOCKBIN_STOPPED" ]]
echo 'RELEASE_ACTIVATION_TESTS_PASSED success_switch failure_rollback concurrent_lock first_release_stop'
