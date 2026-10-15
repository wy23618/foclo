const test=require('node:test');
const assert=require('node:assert/strict');
const {createRequest}=require('../sync/request');
const {LAN_DEBUG_API_HOST,TEMP_CLOUD_DEBUG_API_HOST}=require('../sync/environment');
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
test('API address is selected for development/trial phones and remains absent in release', () => {
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
    assert.equal(load('devtools', 'develop'), `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1`);
    assert.equal(load('android', 'develop'), `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1`);
    assert.equal(load('ios', 'develop'), `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1`);
    assert.equal(load('android', 'trial'), `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1`);
    assert.equal(load('ios', 'trial'), `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1`);
    assert.equal(load('devtools', 'trial'), '');
    assert.equal(load('android', 'release'), '');
    assert.equal(load('ios', 'release'), '');
    assert.equal(load('android', undefined), '');
  } finally {
    delete require.cache[environmentPath];
    delete require.cache[configPath];
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('phone LAN requests wait for debugging to be enabled; release HTTPS does not change debugging', async () => {
  const previousWx = global.wx;
  try {
    for (const envVersion of ['develop', 'release']) {
      const events = [];
      global.wx = {
        getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
        getSystemInfoSync: () => ({ platform: 'android' }),
        setEnableDebug: options => {
          assert.equal(options.enableDebug, true);
          events.push('debug-start');
          setTimeout(() => { events.push('debug-ready'); options.success(); }, 5);
        },
        request: options => {
          events.push('request');
          queueMicrotask(() => options.success({ statusCode: 200, data: { ok: true } }));
          return { abort() {} };
        },
      };
      const request = createRequest({ baseUrl: envVersion === 'develop' ? `http://${LAN_DEBUG_API_HOST}:3000/api/v1` : 'https://test.invalid/api/v1' });
      await request('GET', '/me');
      await request('GET', '/me');
      assert.deepEqual(events, envVersion === 'develop' ? ['debug-start', 'debug-ready', 'request', 'request'] : ['request', 'request']);
      request.cancel();
    }
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('phone cloud test requests wait for WeChat debugging before using the HTTPS IP endpoint', async () => {
  const previousWx = global.wx;
  try {
    const events = [];
    global.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      getSystemInfoSync: () => ({ platform: 'android' }),
      setEnableDebug: options => {
        events.push('debug-start');
        queueMicrotask(() => { events.push('debug-ready'); options.success(); });
      },
      request: options => {
        events.push(options.url);
        queueMicrotask(() => options.success({ statusCode: 200, data: { ok: true } }));
        return { abort() {} };
      },
    };
    const request = createRequest({ baseUrl: `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1` });
    assert.deepEqual(await request('GET', '/health'), { ok: true });
    assert.deepEqual(events, ['debug-start', 'debug-ready', `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1/health`]);
    request.cancel();
    const ordinaryEvents = [];
    global.wx.request = options => {
      ordinaryEvents.push(options.url);
      queueMicrotask(() => options.success({ statusCode: 200, data: { ok: true } }));
      return { abort() {} };
    };
    const unrelated = createRequest({ baseUrl: `https://${TEMP_CLOUD_DEBUG_API_HOST}.example/api/v1` });
    await unrelated('GET', '/health');
    assert.deepEqual(ordinaryEvents, [`https://${TEMP_CLOUD_DEBUG_API_HOST}.example/api/v1/health`]);
    unrelated.cancel();
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('trial HTTPS requests share debug preparation, authenticate, and sanitize network errors', async () => {
  const previousWx = global.wx;
  try {
    for (const platform of ['android', 'ios']) {
      let debugCalls = 0, debugReady = false, fail = false;
      const seen = [];
      global.wx = {
        getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }),
        getSystemInfoSync: () => ({ platform }),
        setEnableDebug: options => {
          debugCalls++;
          queueMicrotask(() => { debugReady = true; options.success(); });
        },
        request: options => {
          assert.equal(debugReady, true, 'domain-dependent request must wait for debug');
          assert.equal(options.header.Authorization, 'Bearer test-token');
          seen.push(options.url);
          queueMicrotask(() => fail
            ? options.fail({ errMsg: 'request:fail url not in domain list https://test.invalid/?token=secret' })
            : options.success({ statusCode: 200, data: { ok: true } }));
          return { abort() {} };
        },
      };
      const request = createRequest({ baseUrl: `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1`, credentials: { accessToken: 'test-token' } });
      await Promise.all([request('GET', '/me'), request('GET', '/sync/pull')]);
      assert.equal(debugCalls, 1);
      assert.equal(seen.length, 2);
      fail = true;
      await assert.rejects(request('GET', '/me'), error => {
        assert.equal(error.code, 'NETWORK_ERROR');
        assert.match(error.message, /右上角打开调试/);
        assert.doesNotMatch(error.message, /secret|https:\/\//);
        return true;
      });
      request.cancel();
    }
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});

test('trial cancellation while enabling debug never sends an authenticated request', async () => {
  const previousWx = global.wx;
  let debug;
  try {
    global.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }),
      getSystemInfoSync: () => ({ platform: 'android' }),
      setEnableDebug: options => { debug = options; },
      request: () => { throw new Error('Cancelled trial request was sent'); },
    };
    const request = createRequest({ baseUrl: `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1` });
    const pending = request('GET', '/me');
    request.cancel();
    debug.success();
    await assert.rejects(pending, error => error.code === 'CANCELLED');
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});

test('release and unknown environments reject explicit temporary ECS URL without enabling debug', () => {
  const previousWx = global.wx;
  try {
    for (const envVersion of ['release', undefined]) {
      global.wx = {
        getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
        getSystemInfoSync: () => ({ platform: 'android' }),
        setEnableDebug: () => { throw new Error('Production debugging must not be enabled'); },
      };
      assert.throws(() => createRequest({ baseUrl: `https://${TEMP_CLOUD_DEBUG_API_HOST}/api/v1` }), /正式 HTTPS/);
      assert.doesNotThrow(() => createRequest({ baseUrl: 'https://test.invalid/api/v1' }));
    }
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});

test('phone LAN debugging exposes platform failure without request URLs; released builds keep the generic message', async () => {
  const previousWx = global.wx;
  try {
    for (const envVersion of ['develop', 'release']) {
      global.wx = {
        getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
        getSystemInfoSync: () => ({ platform: 'android' }),
        request: options => {
          queueMicrotask(() => options.fail({ errMsg: 'request:fail url not in domain list https://test.invalid/?token=secret' }));
          return { abort() {} };
        },
      };
      const request = createRequest({ baseUrl: envVersion === 'develop' ? `http://${LAN_DEBUG_API_HOST}:3000/api/v1` : 'https://test.invalid/api/v1' });
      await assert.rejects(request('GET', '/me'), e => {
        assert.equal(e.code, 'NETWORK_ERROR');
        assert.equal(e.message.includes('secret'), false);
        if (envVersion === 'develop') assert.match(e.message, /url not in domain list/);
        else assert.equal(e.message, '网络未连接或请求超时');
        return true;
      });
      request.cancel();
    }
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
test('HTTP remains blocked on unrelated phones, trial/release and lookalike loopback hostnames', () => {
  const previousWx = global.wx;
  try {
    for (const [platform, envVersion] of [['ios', 'develop'], ['android', 'develop'], ['android', 'trial'], ['ios', 'trial'], ['devtools', 'trial'], ['devtools', 'release']]) {
      global.wx = {
        getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
        getSystemInfoSync: () => ({ platform }),
      };
      assert.throws(() => createRequest({ baseUrl: 'http://127.0.0.1:3000/api/v1' }), /HTTPS/);
      if (envVersion === 'trial')
        assert.throws(() => createRequest({ baseUrl: `http://${LAN_DEBUG_API_HOST}:3000/api/v1` }), /HTTPS/);
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
