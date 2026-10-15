const test = require('node:test');
const assert = require('node:assert/strict');
const { entryAction } = require('../sync/login-entry');
test('the mini program opens directly on focus and has no custom login page', () => {
  const pages = require('../app.json').pages;
  assert.equal(pages[0], 'pages/focus/focus');
  assert.ok(!pages.includes('pages/login/login'));
});
test('first entry identifies a guest through WeChat; existing accounts retain offline access', () => {
  assert.equal(entryAction({ status:'guest' }), 'login');
  assert.equal(entryAction({ account:{userId:'saved'}, status:'offline' }), 'continue');
  assert.equal(entryAction({ account:{userId:'saved'}, status:'auth-required' }), 'login');
});
test('explicit guest choice and ongoing timers prevent automatic account replacement', () => {
  assert.equal(entryAction({ status:'guest', guestSession:true }), 'continue');
  assert.equal(entryAction({ status:'guest', activeTimer:true }), 'continue');
});
