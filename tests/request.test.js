const test=require('node:test');
const assert=require('node:assert/strict');
const {createRequest}=require('../sync/request');
const {LAN_DEBUG_API_HOST}=require('../sync/environment');
test('DevTools development login requests can reach loopback HTTP through wx.request', async () => {
  const previousWx = global.wx;
  const seen = [];
  try {
    global.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      getSystemInfoSync: () => ({ platform: 'devtools' }),
      request: options => {
        seen.push(options.url);
        queueMicrotask(() => options.success({ statusCode: 200, data: { ok: true } }));
        return { abort() {} };
      },
    };
    const request = createRequest({ baseUrl: 'http://127.0.0.1:3000/api/v1', credentials: null, saveCredentials: async () => {} });
    assert.deepEqual(await request('POST', '/auth/wechat-mini', { code: 'test-code' }), { ok: true });
    assert.deepEqual(seen, ['http://127.0.0.1:3000/api/v1/auth/wechat-mini']);
    request.cancel();
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('LAN HTTP is limited to the configured development phone address', async () => {
  const previousWx = global.wx;
  try {
    global.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      getSystemInfoSync: () => ({ platform: 'android' }),
      request: options => {
        queueMicrotask(() => options.success({ statusCode: 200, data: { ok: true } }));
        return { abort() {} };
      },
    };
    const request = createRequest({ baseUrl: `http://${LAN_DEBUG_API_HOST}:3000/api/v1`, credentials: null, saveCredentials: async () => {} });
    assert.deepEqual(await request('GET', '/health', {}), { ok: true });
    request.cancel();
    assert.throws(() => createRequest({ baseUrl: 'http://10.0.0.1:3000/api/v1' }), /HTTPS/);
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('API address is selected only for the matching development device', () => {
  const previousWx = global.wx;
  const environmentPath = require.resolve('../sync/environment');
  const configPath = require.resolve('../sync/config');
  function load(platform, envVersion) {
    global.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getSystemInfoSync: () => ({ platform }),
    };
    delete require.cache[environmentPath];
    delete require.cache[configPath];
    return require('../sync/config').apiBaseUrl;
  }
  try {
    assert.equal(load('devtools', 'develop'), 'http://127.0.0.1:3000/api/v1');
    assert.equal(load('android', 'develop'), `http://${LAN_DEBUG_API_HOST}:3000/api/v1`);
    assert.equal(load('ios', 'develop'), `http://${LAN_DEBUG_API_HOST}:3000/api/v1`);
    assert.equal(load('android', 'trial'), '');
    assert.equal(load('ios', 'release'), '');
  } finally {
    delete require.cache[environmentPath];
    delete require.cache[configPath];
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('HTTP remains blocked on unrelated phones, trial/release and lookalike loopback hostnames', () => {
  const previousWx = global.wx;
  try {
    for (const [platform, envVersion] of [['ios', 'develop'], ['android', 'develop'], ['devtools', 'trial'], ['devtools', 'release']]) {
      global.wx = {
        getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
        getSystemInfoSync: () => ({ platform }),
      };
      assert.throws(() => createRequest({ baseUrl: 'http://127.0.0.1:3000/api/v1' }), /HTTPS/);
      assert.doesNotThrow(() => createRequest({ baseUrl: 'https://test.invalid/api/v1' }));
    }
    global.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      getSystemInfoSync: () => ({ platform: 'devtools' }),
    };
    for (const url of ['http://127.0.0.1.example.com/api/v1', 'http://127.0.0.10/api/v1', 'http://127.0.0.1@evil.invalid/api/v1', 'http://192.168.1.2:3000/api/v1']) {
      assert.throws(() => createRequest({ baseUrl: url }), /HTTPS/);
    }
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('concurrent 401s coordinate one refresh and persist before retrying business requests',async()=>{let refreshes=0,saved=false;const requests=[];const request=createRequest({baseUrl:'https://test.invalid/api/v1',credentials:{accessToken:'old',refreshToken:'refresh-old'},saveCredentials:async value=>{await new Promise(r=>setTimeout(r,5));saved=true;},transport:async(method,url,data,token)=>{if(url.endsWith('/auth/refresh')){refreshes++;await new Promise(r=>setTimeout(r,5));return {accessToken:'new',refreshToken:'refresh-new'};}if(token==='old')throw Object.assign(new Error('expired'),{status:401,code:'AUTH_REQUIRED'});assert.equal(saved,true);requests.push(url);return {ok:true};}});const responses=await Promise.all([request('GET','/me'),request('GET','/sync/pull',{generation:'1'})]);assert.equal(refreshes,1);assert.equal(responses.length,2);assert.equal(requests.length,2);request.cancel();});
test('credential persistence failure preserves previous token and retries refresh without deleting queue',async()=>{let saves=0;const seen=[];const request=createRequest({baseUrl:'https://test.invalid/api/v1',credentials:{accessToken:'old',refreshToken:'old-refresh'},saveCredentials:async()=>{if(++saves===1)throw new Error('storage full');},transport:async(method,url,data,token)=>{if(url.endsWith('/auth/refresh')){seen.push(data.refreshToken);return {accessToken:'new',refreshToken:'new-refresh'};}if(token==='old')throw Object.assign(new Error('expired'),{status:401});return {ok:true};}});await assert.rejects(()=>request('GET','/me'),/storage full/);await request('GET','/me');assert.deepEqual(seen,['old-refresh','old-refresh']);request.cancel();});
