// Obtain one real DevTools wx.login code without changing its account/endpoint.
// The short-lived code is written to a protected transfer file, never printed.
const path=require('node:path'),fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const automator=require(path.join(process.env.LOCALAPPDATA,'YoTick','AcceptanceTools','node_modules','miniprogram-automator'));
const deadline=setTimeout(()=>{console.error('DevTools login-code preparation unavailable');process.exit(1);},30000);
(async()=>{
 const mp=await automator.connect({wsEndpoint:'ws://127.0.0.1:9421'});
 try{
  const result=await mp.evaluate(async()=>{
   const app=getApp(); await app.globalData.readyPromise;
   const current=app.globalData.accounts.getCurrent();
   if(!current?.userId)throw new Error('An existing authenticated DevTools account is required');
   const login=await new Promise((resolve,reject)=>wx.login({success:resolve,fail:reject}));
   if(!login.code)throw new Error('No real WeChat login code');
   return {code:login.code,expectedUserId:current.userId};
  });
  result.deviceId=randomUUID();
  fs.writeFileSync(path.join(process.env.LOCALAPPDATA,'YoTick','CloudServer','wechat-once.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
  console.log('Real short-lived WeChat code prepared privately');
 }finally{mp.disconnect();clearTimeout(deadline);}
})().catch(()=>{clearTimeout(deadline);console.error('Real DevTools WeChat code preparation failed; no code printed');process.exitCode=1;});
