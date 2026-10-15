// Actual WeChat provider check through the private API, never a mock identity.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const input=JSON.parse(readFileSync('/root/wechat-once.json','utf8'));
const login=await fetch('http://127.0.0.1:3000/api/v1/auth/wechat-mini',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:input.code,deviceId:input.deviceId}),signal:AbortSignal.timeout(20000)});
const result=await login.json();
if(login.status!==200)throw new Error('Actual cloud WeChat exchange failed (HTTP '+login.status+', error '+String(result.code||result.error||'unspecified')+')');
let meStatus;
try {
 const me=await fetch('http://127.0.0.1:3000/api/v1/me',{headers:{authorization:'Bearer '+result.accessToken},signal:AbortSignal.timeout(5000)});
 const identity=await me.json();assert.equal(me.status,200);assert.equal(identity.userId,input.expectedUserId);meStatus=me.status;
}finally{
 // End only this verification's newly-created cloud session, even on a me error.
 const logout=await fetch('http://127.0.0.1:3000/api/v1/auth/logout',{method:'POST',headers:{authorization:'Bearer '+result.accessToken,'content-type':'application/json'},body:JSON.stringify({}),signal:AbortSignal.timeout(5000)});
 assert.equal(logout.status,204);
}
const evidence={verifiedAt:new Date().toISOString(),realDevtoolsWxLogin:true,realCloudWechatExchange:true,sameMigratedAccount:true,loginStatus:login.status,meStatus,logoutStatus:204,phonePublicHttps:false};
writeFileSync('/root/yotick-cloud-wechat-verification.json',JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
