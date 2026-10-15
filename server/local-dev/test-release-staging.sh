#!/usr/bin/env bash
# Isolated WSL integration check for stage-release.sh. Never touches a live host.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run this test as root in isolated WSL' >&2; exit 1; }
[[ ! -e /opt/yotick ]] || { echo 'Refusing: /opt/yotick already exists in this environment' >&2; exit 1; }
stage=${1:?path to stage-release.sh required}
[[ -f "$stage" ]] || { echo 'Staging script not found' >&2; exit 1; }
work=$(mktemp -d /tmp/yotick-stage-test.XXXXXX)
mockbin="$work/mockbin"
mkdir -p "$mockbin" "$work/input/dist/src"
archive="/root/YoTick-backend-stage-test-$$.zip"
bad_archive="/root/YoTick-backend-stage-bad-$$.zip"
[[ ! -e "$archive" && ! -e "$bad_archive" ]] || { echo 'Refusing to replace existing test archive' >&2; exit 1; }
cleanup() {
  rm -f -- "$archive" "$bad_archive"
  rm -rf -- /opt/yotick/releases/yotick-stage-success /opt/yotick/releases/yotick-stage-npm-failure /opt/yotick/releases/yotick-stage-bad-manifest /opt/yotick/releases/yotick-stage-dangling-link
  rmdir /opt/yotick/releases 2>/dev/null || true
  rmdir /opt/yotick 2>/dev/null || true
  rm -rf -- "$work"
}
trap cleanup EXIT
printf 'compiled-api\n' > "$work/input/dist/src/index.js"
printf '{"name":"yotick-test","version":"1.0.0"}\n' > "$work/input/package.json"
printf '{"name":"yotick-test","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"yotick-test","version":"1.0.0"}}}\n' > "$work/input/package-lock.json"
python3 - "$work/input" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
manifest=[]
for name in ('dist/src/index.js','package.json','package-lock.json'):
    data=(root/name).read_bytes()
    manifest.append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(root/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
PY
python3 - "$work/input" "$archive" <<'PY'
import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w') as z:
    for p in root.rglob('*'):
        if p.is_file(): z.write(p,p.relative_to(root).as_posix())
PY
archive_hash=$(sha256sum "$archive" | cut -d' ' -f1)
cat > "$mockbin/npm" <<'MOCK'
#!/usr/bin/env bash
[[ ${NPM_FAIL:-0} != 1 ]]
MOCK
chmod +x "$mockbin/npm"
export PATH="$mockbin:$PATH"
mkdir -p /opt/yotick/releases

bash "$stage" "$archive" "$archive_hash" /opt/yotick/releases/yotick-stage-success
[[ -f /opt/yotick/releases/yotick-stage-success/dist/src/index.js ]]

set +e
NPM_FAIL=1 bash "$stage" "$archive" "$archive_hash" /opt/yotick/releases/yotick-stage-npm-failure >/dev/null 2>&1
npm_status=$?
set -e
[[ $npm_status != 0 && ! -e /opt/yotick/releases/yotick-stage-npm-failure && ! -L /opt/yotick/releases/yotick-stage-npm-failure ]]

python3 - "$work/input" "$bad_archive" <<'PY'
import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
manifest=root/'manifest.json'
original=manifest.read_text(encoding='utf-8')
manifest.write_text('[{"path":"../escape","bytes":0,"sha256":"'+'0'*64+'"}]',encoding='utf-8')
with zipfile.ZipFile(sys.argv[2],'w') as z:
    for p in root.rglob('*'):
        if p.is_file(): z.write(p,p.relative_to(root).as_posix())
manifest.write_text(original,encoding='utf-8')
PY
bad_hash=$(sha256sum "$bad_archive" | cut -d' ' -f1)
set +e
bash "$stage" "$bad_archive" "$bad_hash" /opt/yotick/releases/yotick-stage-bad-manifest >/dev/null 2>&1
manifest_status=$?
set -e
[[ $manifest_status != 0 && ! -e /opt/yotick/releases/yotick-stage-bad-manifest && ! -L /opt/yotick/releases/yotick-stage-bad-manifest ]]

ln -s "$work/missing-target" /opt/yotick/releases/yotick-stage-dangling-link
set +e
bash "$stage" "$archive" "$archive_hash" /opt/yotick/releases/yotick-stage-dangling-link >/dev/null 2>&1
link_status=$?
set -e
[[ $link_status != 0 && -L /opt/yotick/releases/yotick-stage-dangling-link && $(readlink /opt/yotick/releases/yotick-stage-dangling-link) == "$work/missing-target" ]]
echo 'RELEASE_STAGING_TESTS_PASSED verified_archive npm_failure_cleanup unsafe_manifest_cleanup dangling_symlink_rejected'
