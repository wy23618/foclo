const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmGuestImport } = require('../sync/login-flow');

test('guest choices explain source, destination, both outcomes and overlap without uploading', async () => {
  const old = global.wx; let modal;
  global.wx = { showModal: options => { modal = options; } };
  try {
    const choosing = confirmGuestImport({projectCount:2,sessionCount:3,accountSuffix:'abcd',overlapSessionCount:1});
    assert.equal(modal.confirmText, '存入账号'); assert.equal(modal.cancelText, '留在本机');
    for (const text of ['未登录','尾号 abcd','不上传','原有记录仍正常同步','删除状态为准','原记录仍保留','时间交叠'])
      assert.ok(modal.content.includes(text), text);
    modal.success({confirm:false,cancel:true}); assert.equal(await choosing,false);
  } finally { global.wx = old; }
});

function accountPage() {
  let definition; const before=global.Page;
  global.Page=value=>{definition=value;};
  try {delete require.cache[require.resolve('../pages/account/account')];require('../pages/account/account');}
  finally {global.Page=before;}
  return definition;
}

test('cloud conflict resolution requires an explicit explanation and confirmation', () => {
  const old=global.wx; let sheet,modal; const actions=[];
  global.wx={showActionSheet:options=>{sheet=options;},showModal:options=>{modal=options;}};
  try {
    const page=accountPage(), ctx={data:{conflicts:[{id:'conflict',code:'VERSION_CONFLICT',isDeleted:false}]},runAction:(...args)=>actions.push(args)};
    page.onResolve.call(ctx,{currentTarget:{dataset:{id:'conflict'}}});
    assert.deepEqual(sheet.itemList,['按云端内容更新本机','用本机修改更新账号']);
    sheet.success({tapIndex:0}); assert.equal(actions.length,0);
    assert.ok(modal.content.includes('本机未同步')); assert.ok(modal.content.includes('恢复副本'));
    modal.success({confirm:false}); assert.equal(actions.length,0);
    modal.success({confirm:true}); assert.deepEqual(actions[0].slice(1),['resolveConflict',['conflict','cloud']]);
  } finally {global.wx=old;}
});

test('non-name conflicts explain submitting local edits without asking for a project rename', () => {
  const old=global.wx;let sheet,modal;const actions=[];
  global.wx={showActionSheet:options=>{sheet=options;},showModal:options=>{modal=options;}};
  try {
    const page=accountPage(),ctx={data:{conflicts:[{id:'prefs',code:'VERSION_CONFLICT',isDeleted:false}]},runAction:(...args)=>actions.push(args)};
    page.onResolve.call(ctx,{currentTarget:{dataset:{id:'prefs'}}});sheet.success({tapIndex:1});
    assert.equal(modal.editable,undefined);assert.ok(modal.content.includes('其他设备'));assert.equal(actions.length,0);
    modal.success({confirm:true});assert.deepEqual(actions[0].slice(1),['resolveConflict',['prefs','local',{}]]);
  } finally {global.wx=old;}
});
