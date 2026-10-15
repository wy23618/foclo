const test = require('node:test');
const assert = require('node:assert/strict');
const { readInBatches } = require('../core/bounded-read');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('bounded native reads retain order despite different completion times', async () => {
  let active = 0, peak = 0;
  const ids = Array.from({ length: 19 }, (_, i) => i);
  const results = await readInBatches(ids, async id => {
    active++; peak = Math.max(peak, active);
    await delay(id % 3 + 1);
    active--;
    return id * 2;
  });
  assert.deepEqual(results, ids.map(id => id * 2));
  assert.ok(peak > 1 && peak <= 8);
  assert.equal(active, 0);
});

test('read failure drains the current batch and prevents later reads', async () => {
  const began = [], completed = [], failure = new Error('file permission denied');
  await assert.rejects(() => readInBatches(Array.from({ length: 17 }, (_, i) => i), async id => {
    began.push(id);
    if (id === 2) throw failure;
    await delay(5);
    completed.push(id);
    return id;
  }), error => error === failure);
  assert.equal(began.length, 8);
  assert.equal(completed.length, 7);
  assert.ok(began.every(id => id < 8));
});
