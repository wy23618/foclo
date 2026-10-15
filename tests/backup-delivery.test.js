const test=require('node:test');
const assert=require('node:assert/strict');
test('backup waits for file creation and explicitly offers sending; write failure is reported',async()=>{
  const previous={Page:global.Page,getApp:global.getApp,wx:global.wx};
  let page,write,events=[];
  global.getApp=()=>({globalData:{service:{createBackup:async()=>({ok:true,data:{projects:[],sessions:[]}})}}});
  global.Page=value=>{page=value;};
  global.wx={env:{USER_DATA_PATH:'/mock'},getFileSystemManager:()=>({writeFile:args=>{write=args;}}),
    hideLoading:()=>{},showLoading:()=>{},showToast:args=>events.push(args.title),
    showModal:args=>{events.push(args.title);args.success?.({confirm:true});},
    shareFileMessage:args=>{events.push('share');args.success();}};
  try {
    delete require.cache[require.resolve('../pages/settings-detail/settings-detail')];
    require('../pages/settings-detail/settings-detail');
    const task=page.exportBackup.call(page);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(page.fileBusy,true);assert.deepEqual(events,[]);
    write.success();await task;
    assert.deepEqual(events,['文件已生成','share','备份文件已发送']);assert.equal(page.fileBusy,false);
    events=[];
    const failed=page.exportBackup.call(page);await new Promise(resolve=>setImmediate(resolve));
    write.fail();await failed;
    assert.deepEqual(events,['备份尚未完成']);assert.equal(page.fileBusy,false);
  }finally{Object.assign(global,previous);}
});
