#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
archive=${1:?archive}; expected=${2:?sha256}; release=${3:?new release directory}
[[ "$archive" == /root/YoTick-backend-*.zip && -f "$archive" && "$expected" =~ ^[0-9a-f]{64}$ && "$release" =~ ^/opt/yotick/releases/[a-zA-Z0-9-]+$ && -d /opt/yotick && ! -L /opt/yotick && -d /opt/yotick/releases && ! -L /opt/yotick/releases && ! -e "$release" && ! -L "$release" ]] || exit 1
printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status
created=0
staged=0
cleanup_failed_release() {
  if [[ "$created" == 1 && "$staged" == 0 ]]; then rm -rf -- "$release"; fi
}
trap cleanup_failed_release EXIT
mkdir -m 0755 -- "$release"
created=1
python3 - "$archive" "$release" <<'PY'
import zipfile,sys,pathlib,json,hashlib
archive, release=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    for entry in z.infolist():
        p=pathlib.PurePosixPath(entry.filename)
        if '\\' in entry.filename or p.is_absolute() or '..' in p.parts: raise RuntimeError('Unsafe archive path')
    z.extractall(release)
root=pathlib.Path(release)
manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8-sig'))
for entry in manifest:
    name=entry.get('path')
    if not isinstance(name,str) or '\\' in name: raise RuntimeError('Unsafe manifest path')
    relative=pathlib.PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts: raise RuntimeError('Unsafe manifest path')
    candidate=root.joinpath(*relative.parts)
    if not candidate.is_file() or candidate.is_symlink() or root not in candidate.resolve().parents: raise RuntimeError('Invalid manifest file')
    raw=candidate.read_bytes()
    if len(raw)!=entry['bytes'] or hashlib.sha256(raw).hexdigest()!=entry['sha256']: raise RuntimeError('File integrity failure')
print('MANIFEST_VERIFIED',len(manifest))
PY
chown -R root:root "$release"
chmod -R go-w "$release"
cd "$release"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm ls --omit=dev
staged=1
trap - EXIT
