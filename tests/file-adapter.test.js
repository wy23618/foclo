const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryAdapter } = require('../storage/adapter');
const { createFileTierAdapter, DEFAULT_MAX_BYTES } = require('../storage/file-adapter');

function error(code, message) {
  const result = new Error(message || code);
  result.code = code;
  return result;
}

class FakeFileSystem {
  constructor(root) {
    this.root = root;
    this.dirs = new Set([root]);
    this.files = new Map();
    this.faults = [];
  }

  failNext(method, err, afterApply) { this.faults.push({ method, err, afterApply: !!afterApply }); }
  children(path) { return path.replace(/\/$/, '').split('/').filter(Boolean); }

  finish(method, options, apply) {
    const index = this.faults.findIndex((item) => item.method === method);
    const fault = index >= 0 ? this.faults.splice(index, 1)[0] : null;
    if (fault && !fault.afterApply) { options.fail(fault.err); return; }
    try {
      const value = apply();
      if (fault) options.fail(fault.err);
      else options.success(value || {});
    } catch (e) { options.fail(e); }
  }

  mkdir(options) {
    this.finish('mkdir', options, () => {
      const parts = this.children(options.dirPath);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        this.dirs.add(current);
      }
      return {};
    });
  }

  readdir(options) {
    this.finish('readdir', options, () => {
      const dir = options.dirPath.replace(/\/$/, '');
      if (!this.dirs.has(dir)) throw error('ENOENT', 'no such file or directory: ' + dir);
      const children = new Set();
      for (const candidate of this.dirs) {
        if (candidate.startsWith(dir + '/')) {
          const tail = candidate.slice(dir.length + 1);
          if (tail && !tail.includes('/')) children.add(tail);
        }
      }
      for (const path of this.files.keys()) {
        if (path.startsWith(dir + '/')) {
          const tail = path.slice(dir.length + 1);
          if (tail && !tail.includes('/')) children.add(tail);
        }
      }
      return { files: Array.from(children) };
    });
  }

  writeFile(options) {
    this.finish('writeFile', options, () => {
      const parent = options.filePath.slice(0, options.filePath.lastIndexOf('/'));
      if (!this.dirs.has(parent)) throw error('ENOENT', 'no such file or directory: ' + parent);
      this.files.set(options.filePath, String(options.data));
      return {};
    });
  }

  readFile(options) {
    this.finish('readFile', options, () => {
      if (!this.files.has(options.filePath)) throw error('ENOENT', 'no such file or directory: ' + options.filePath);
      return { data: this.files.get(options.filePath) };
    });
  }

  stat(options) {
    this.finish('stat', options, () => {
      if (!this.files.has(options.path)) throw error('ENOENT', 'no such file or directory: ' + options.path);
      return { stats: [{ size: Buffer.byteLength(this.files.get(options.path), 'utf8') }] };
    });
  }

  rename(options) {
    this.finish('rename', options, () => {
      if (!this.files.has(options.oldPath)) throw error('ENOENT', 'no such file or directory: ' + options.oldPath);
      const parent = options.newPath.slice(0, options.newPath.lastIndexOf('/'));
      if (!this.dirs.has(parent)) throw error('ENOENT', 'no such file or directory: ' + parent);
      const value = this.files.get(options.oldPath);
      this.files.delete(options.oldPath);
      this.files.set(options.newPath, value);
      return {};
    });
  }

  unlink(options) {
    this.finish('unlink', options, () => {
      if (!this.files.has(options.filePath)) throw error('ENOENT', 'no such file or directory: ' + options.filePath);
      this.files.delete(options.filePath);
      return {};
    });
  }
}

function makeRaw() {
  const raw = createMemoryAdapter();
  raw.getStorageSync = (key) => raw._map.get(key);
  raw.setStorageSync = (key, value) => raw._map.set(key, value);
  raw.removeStorageSync = (key) => raw._map.delete(key);
  return raw;
}

function setup(raw, fs, options) {
  return createFileTierAdapter(raw, { env: { USER_DATA_PATH: '/wx/user' }, getFileSystemManager: () => fs }, options);
}

test('routes only large namespaced facts and legacy snapshots to files', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user'), adapter = setup(raw, fs);
  await adapter.set('yotick-space/space%2F1/yotick/s/session-1', { id: 'session-1' });
  await adapter.set('yotick-legacy-snapshot/yotick%2Fs%2Fold', { value: 2 });
  await adapter.set('yotick-global/current', 'account');
  await adapter.set('yotick-space/space%2F1/yotick/rest-break/v1', { status: 'rest' });
  await adapter.set('yotick-space/space%2F1/yotick/ui-project-colors-v2', { p: '#123456' });

  assert.equal(raw._map.has('yotick-space/space%2F1/yotick/s/session-1'), false);
  assert.equal(raw._map.has('yotick-legacy-snapshot/yotick%2Fs%2Fold'), false);
  assert.equal(raw._map.get('yotick-global/current'), 'account');
  assert.deepEqual(raw._map.get('yotick-space/space%2F1/yotick/rest-break/v1'), { status: 'rest' });
  assert.deepEqual(raw._map.get('yotick-space/space%2F1/yotick/ui-project-colors-v2'), { p: '#123456' });
  assert.deepEqual(await adapter.get('yotick-space/space%2F1/yotick/s/session-1'), { id: 'session-1' });
  assert.deepEqual((await adapter.keys()).sort(), [
    'yotick-global/current',
    'yotick-legacy-snapshot/yotick%2Fs%2Fold',
    'yotick-space/space%2F1/yotick/rest-break/v1',
    'yotick-space/space%2F1/yotick/s/session-1',
    'yotick-space/space%2F1/yotick/ui-project-colors-v2'
  ].sort());
});

test('rebuilds file keys and app-budget accounting after restart', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user');
  const first = setup(raw, fs, { maxBytes: 1000 });
  await first.set('yotick-space/ns/yotick/meta', { a: '中文' });
  await first.set('yotick-space/ns/yotick/s/one', { id: 'one' });
  raw._map.set('yotick-global/device', 'd');

  const restarted = setup(raw, fs, { maxBytes: 1000 });
  assert.deepEqual((await restarted.keys()).sort(), [
    'yotick-global/device', 'yotick-space/ns/yotick/meta', 'yotick-space/ns/yotick/s/one'
  ].sort());
  const expected = Buffer.byteLength(JSON.stringify({ a: '中文' })) + Buffer.byteLength(JSON.stringify({ id: 'one' }));
  assert.deepEqual(await restarted.capacity(), { tier: 'files', usedBytes: expected, limitBytes: 1000, availableBytes: 1000 - expected });
  assert.equal(DEFAULT_MAX_BYTES, 96 * 1024 * 1024);
});

test('rejects traversal, absolute-looking, empty, and control-character path segments', async () => {
  const adapter = setup(makeRaw(), new FakeFileSystem('/wx/user'));
  for (const key of [
    'yotick-space/../yotick/meta',
    'yotick-space/ns//yotick/meta',
    'yotick-space/ns/./yotick/meta',
    'yotick-space/ns/yotick/..',
    'yotick-space/ns/C:/outside',
    'yotick-space/ns/yotick/line\nfeed'
  ]) await assert.rejects(adapter.set(key, 1), { code: 'FILE_KEY_INVALID' });
});

test('missing files are empty, while permissions and corrupt JSON surface', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user'), adapter = setup(raw, fs);
  assert.equal(await adapter.get('yotick-space/ns/yotick/missing'), undefined);
  fs.failNext('readFile', error(1300002, 'file missing'));
  assert.equal(await adapter.get('yotick-space/ns/yotick/also-missing'), undefined);
  fs.failNext('readFile', { errMsg: 'readFile:fail [path] not found' });
  assert.equal(await adapter.get('yotick-space/ns/yotick/wechat-missing'), undefined);
  fs.failNext('readFile', { errMsg: 'readFile:fail\n[path] not found' });
  assert.equal(await adapter.get('yotick-space/ns/yotick/wechat-missing-newline'), undefined);
  const key = 'yotick-space/ns/yotick/value';
  await adapter.set(key, { valid: true });
  const path = Array.from(fs.files.keys()).find((p) => p.endsWith('/value.json'));
  fs.files.set(path, '{broken');
  await assert.rejects(adapter.get(key), SyntaxError);
  fs.files.set(path, '{"valid":true}');
  fs.failNext('readFile', error('EACCES', 'permission denied'));
  await assert.rejects(adapter.get(key), { code: 'EACCES' });
});

test('falls back to old raw scoped values, then writes verified file copy before clearing fallback', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user'), adapter = setup(raw, fs);
  const key = 'yotick-space/ns/yotick/meta';
  raw._map.set(key, { old: true });
  assert.deepEqual(await adapter.get(key), { old: true });
  await adapter.set(key, { new: true });
  assert.deepEqual(await adapter.get(key), { new: true });
  assert.equal(raw._map.has(key), false);
});

test('failed write or rename preserves the previous file and removes owned temporary files', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user'), adapter = setup(raw, fs);
  const key = 'yotick-space/ns/yotick/meta';
  await adapter.set(key, { version: 1 });
  fs.failNext('writeFile', error('ENOSPC', 'storage full'));
  await assert.rejects(adapter.set(key, { version: 2 }), { code: 'ENOSPC' });
  assert.deepEqual(await adapter.get(key), { version: 1 });
  fs.failNext('rename', error('EACCES', 'permission denied'));
  await assert.rejects(adapter.set(key, { version: 3 }), { code: 'EACCES' });
  assert.deepEqual(await adapter.get(key), { version: 1 });
  assert.equal(Array.from(fs.files.keys()).some((path) => path.indexOf('/.yotick-write-tmp/') >= 0), false);
});

test('reconciles accounting if rename succeeded but its success callback was lost', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user'), adapter = setup(raw, fs);
  const key = 'yotick-space/ns/yotick/meta';
  await adapter.set(key, { v: 1 });
  fs.failNext('rename', error('EIO', 'callback lost'), true);
  await assert.rejects(adapter.set(key, { v: 2 }), { code: 'EIO' });
  assert.deepEqual(await adapter.get(key), { v: 2 });
  assert.equal((await adapter.capacity()).usedBytes, Buffer.byteLength('{"v":2}'));
});

test('quota refusal leaves existing facts intact and actual filesystem exhaustion propagates', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user');
  const adapter = setup(raw, fs, { maxBytes: Buffer.byteLength('{"v":1}') });
  const key = 'yotick-space/ns/yotick/meta';
  await adapter.set(key, { v: 1 });
  await assert.rejects(adapter.set(key, { value: 'too large' }), { code: 'FILE_TIER_QUOTA' });
  assert.deepEqual(await adapter.get(key), { v: 1 });

  const unbounded = setup(raw, fs, { maxBytes: 10000 });
  fs.failNext('writeFile', error('ENOSPC', 'device file storage exhausted'));
  await assert.rejects(unbounded.set(key, { v: 2 }), { code: 'ENOSPC' });
  assert.deepEqual(await unbounded.get(key), { v: 1 });
});

test('serializes concurrent writes and keeps synchronous access on the raw tier', async () => {
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user'), adapter = setup(raw, fs, { maxBytes: 200 });
  await Promise.all(Array.from({ length: 12 }, (_, i) => adapter.set('yotick-space/ns/yotick/s/' + i, { id: i })));
  const used = Array.from({ length: 12 }, (_, i) => Buffer.byteLength(JSON.stringify({ id: i }))).reduce((a, b) => a + b, 0);
  assert.equal((await adapter.capacity()).usedBytes, used);

  adapter.setStorageSync('yotick-global/device', 'd');
  assert.equal(adapter.getStorageSync('yotick-global/device'), 'd');
  assert.throws(() => adapter.getStorageSync('yotick-space/ns/yotick/meta'), { code: 'FILE_SYNC_UNSUPPORTED' });
  adapter.removeStorageSync('yotick-global/device');
  assert.equal(raw._map.has('yotick-global/device'), false);
});

test('file tier recovers a fact/outbox journal after a restart and rename failure', async () => {
  const { createAccountAdapter } = require('../storage/account-adapter');
  const { createService } = require('../core/service');
  const { uuid } = require('../core/ids');
  const local = require('../sync/local');
  const raw = makeRaw(), fs = new FakeFileSystem('/wx/user');
  let scoped = createAccountAdapter(setup(raw, fs), 'account');
  await scoped.set(local.STATE, { spaceId: uuid(), userId: uuid(), generation: '1', nextOrder: 0 });
  let service = createService(scoped, { clock: () => 1800000000 });
  assert.equal((await service.init()).ok, true);
  // First rename installs the journal, second failure interrupts the fact write.
  const rename = fs.rename.bind(fs);
  let calls = 0;
  fs.rename = options => {
    if (++calls === 2) fs.failNext('rename', error('EIO', 'interrupted fact write'));
    return rename(options);
  };
  const result = await service.createProject({ operationId: uuid(), name: '文件持久化' });
  assert.equal(result.ok, true);
  scoped = createAccountAdapter(setup(raw, fs), 'account');
  service = createService(scoped, { clock: () => 1800000000 });
  assert.equal((await service.init()).ok, true);
  const facts = await scoped.get('yotick/projects');
  assert.equal(Object.keys(facts).length, 1);
  const tasks = await local.pending(scoped);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].payload.name, '文件持久化');
  assert.equal((await scoped.keys()).some(k => k.startsWith('yotick/c/')), false);
});
