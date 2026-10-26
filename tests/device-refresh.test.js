const test=require('node:test'),assert=require('node:assert/strict');
const {confirmOtherFocus}=require('../utils/focus-device-check');
const {refreshRecords}=require('../utils/refresh-records');
test('other-device detection explains overlap and never starts or stops either timer',async()=>{
  const old=global.wx;let modal;global.wx={showModal:o=>{modal=o;}};
  try{const waiting=confirmOtherFocus({getCurrent:()=>({userId:'a'}),checkOtherFocus:async()=>({available:true,otherDevices:[{startedAtSec:100}]})});
    await new Promise(r=>setImmediate(r));assert.ok(modal.content.includes('不会替你停止'));modal.success({confirm:false});assert.equal(await waiting,false);
  }finally{global.wx=old;}
});
test('guests require no server check and unavailable detection is clearly optional',async()=>{
  assert.equal(await confirmOtherFocus({getCurrent:()=>null}),true);
  const old=global.wx;global.wx={showModal:o=>{assert.ok(o.content.includes('无法保证'));o.success({confirm:true});}};
  try{assert.equal(await confirmOtherFocus({getCurrent:()=>({}),checkOtherFocus:async()=>({available:false})}),true);}finally{global.wx=old;}
});
test('refresh waits for cloud download before querying records and stops the spinner',async()=>{
  const old=global.wx,events=[];global.wx={showToast:o=>events.push(o.title),stopPullDownRefresh:()=>events.push('stop')};
  const page={data:{},setData(p){Object.assign(this.data,p);}},app={globalData:{readyPromise:Promise.resolve(),accounts:{refreshRecords:async()=>{events.push('download');return{localOnly:false};}}}};
  try{await refreshRecords(page,app,async()=>events.push('read'));assert.deepEqual(events,['download','read','已刷新账号记录','stop']);assert.equal(page.data.syncRefreshing,false);}finally{global.wx=old;}
});
test('failed refresh preserves displayed records and gives an honest failure instead of success',async()=>{
  const old=global.wx;let message;global.wx={showModal:o=>{message=o.content;},stopPullDownRefresh:()=>{}};
  const page={data:{rows:['saved']},setData(p){Object.assign(this.data,p);}};
  try{await refreshRecords(page,{globalData:{accounts:{refreshRecords:async()=>{throw new Error('离线');}}}},()=>{throw new Error('must not reload');});assert.deepEqual(page.data.rows,['saved']);assert.equal(message,'离线');assert.equal(page.data.syncRefreshing,false);}finally{global.wx=old;}
});
