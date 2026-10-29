const test = require('node:test');
const assert = require('node:assert/strict');
const { present, dispose, EXIT_MS } = require('../utils/overlay-motion');
function surface() {
  return { data: {}, setData(patch, done) { Object.assign(this.data, patch); if (done) done(); } };
}
test('closed surfaces never flash or block the page when initialized', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = surface();
  present(host, 'open', false);
  assert.equal(host.data.openMounted, false);
  assert.deepEqual(host.overlayMotionTimers, {});
});
test('exit closes logical history immediately and removes only the painted surface after fading', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = surface();
  present(host, 'open', true, { history: true, draft: '未保存的名称' });
  present(host, 'open', false, { history: false });
  assert.equal(host.data.open, false);
  assert.equal(host.data.history, false);
  assert.equal(host.data.openMounted, true);
  assert.equal(host.data.openLeaving, true);
  t.mock.timers.tick(EXIT_MS);
  assert.equal(host.data.openMounted, false);
  assert.equal(host.data.draft, '未保存的名称');
});
test('reopening during an exit cancels stale removal and retains the new content', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = surface();
  present(host, 'open', true);
  present(host, 'open', false);
  t.mock.timers.tick(60);
  present(host, 'open', true, { draft: '新的编辑' });
  t.mock.timers.tick(EXIT_MS);
  assert.equal(host.data.openMounted, true);
  assert.equal(host.data.openLeaving, false);
  assert.equal(host.data.draft, '新的编辑');
});
test('leaving the page cancels exit callbacks instead of writing to an unloaded view', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = surface();
  present(host, 'open', true);
  present(host, 'open', false);
  dispose(host);
  host.setData = () => assert.fail('unloaded surface must not be updated');
  t.mock.timers.tick(EXIT_MS);
});
