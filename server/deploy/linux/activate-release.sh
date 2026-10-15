#!/usr/bin/env bash
# Atomically activate a staged release; restore the previous release if readiness fails.
set -euo pipefail

[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
exec 9>/run/lock/yotick-release.lock
flock -n 9 || { echo 'Another release operation is already running' >&2; exit 1; }
requested=${1:?usage: activate-release.sh /opt/yotick/releases/<version>}
[[ -d /opt/yotick && ! -L /opt/yotick && -d /opt/yotick/releases && ! -L /opt/yotick/releases && "$requested" =~ ^/opt/yotick/releases/[a-zA-Z0-9-]+$ && -d "$requested" && ! -L "$requested" ]] || {
  echo 'Release must be an existing versioned directory under /opt/yotick/releases' >&2
  exit 1
}
release=$(readlink -f -- "$requested")
[[ "$release" == "$requested" && -f "$release/dist/src/index.js" ]] || {
  echo 'Release path or API entry point is invalid' >&2
  exit 1
}

current=/opt/yotick/current
previous=
if [[ -L "$current" ]]; then
  previous=$(readlink -f -- "$current")
  [[ "$previous" =~ ^/opt/yotick/releases/[a-zA-Z0-9-]+$ && -d "$previous" ]] || {
    echo 'Current release link points outside the managed release directory' >&2
    exit 1
  }
elif [[ -e "$current" ]]; then
  echo 'Current release selector exists but is not a symlink' >&2
  exit 1
fi
if [[ "$release" == "$previous" ]]; then
  echo 'Requested release is already active' >&2
  exit 1
fi

swap_current() {
  local target=$1 temporary=/opt/yotick/.current.$$
  if [[ -z "$target" ]]; then rm -f -- "$current"; return; fi
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$current"
}

swap_current "$release"
if systemctl restart yotick.service; then
  for _ in {1..30}; do
    if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3000/health/ready >/dev/null 2>&1; then
      echo "YOTICK_RELEASE_READY $release"
      exit 0
    fi
    sleep 1
  done
fi

echo 'New release failed readiness; restoring previous release' >&2
swap_current "$previous"
if [[ -n "$previous" ]]; then
  systemctl restart yotick.service || true
  for _ in {1..30}; do
    if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3000/health/ready >/dev/null 2>&1; then
      echo "YOTICK_ROLLBACK_READY $previous" >&2
      exit 1
    fi
    sleep 1
  done
  echo "Rollback release did not become ready: $previous" >&2
else
  systemctl stop yotick.service || true
  echo 'No prior release existed; failed service stopped and release selector removed' >&2
fi
exit 2
