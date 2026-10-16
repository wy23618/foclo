const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('reachable pages register only components used in their markup',()=>{
  const root=path.join(__dirname,'..'),app=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8')),seen=new Set();
  function markupWithIncludes(file,visited=new Set()){
    assert.ok(!visited.has(file),'circular WXML include: '+file);visited.add(file);
    const source=fs.readFileSync(file,'utf8');
    const expanded=source.replace(/<include\s+src="([^"]+)"\s*\/?>/g,(_,ref)=>markupWithIncludes(path.resolve(path.dirname(file),ref),new Set(visited)));
    return expanded;
  }
  function visit(base){
    if(seen.has(base))return;seen.add(base);
    const config=JSON.parse(fs.readFileSync(path.join(root,base+'.json'),'utf8')),markup=markupWithIncludes(path.join(root,base+'.wxml'));
    for(const [tag,ref] of Object.entries(config.usingComponents||{})){
      assert.ok(new RegExp('<'+tag+'(?:\\s|/?>)').test(markup),base+': unused '+tag);
      const target=ref.startsWith('/')?ref.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(base),ref));
      visit(target);
    }
  }
  app.pages.forEach(visit);
});
test('declared mini-program package excludes backend, dependencies, tests and docs',()=>{const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../project.config.json'),'utf8')),ignored=config.packOptions.ignore;for(const folder of ['server','tests','docs'])assert.ok(ignored.some(v=>v.type==='folder'&&v.value===folder));assert.equal(config.setting.uploadWithSourceMap,false,'release upload must not include source maps');assert.ok(ignored.some(v=>v.type==='file'&&v.value==='project.private.config.json'));const publicConfig=require('../sync/config');assert.equal(Object.keys(publicConfig).length,1);assert.ok(!/secret|password|token/i.test(JSON.stringify(publicConfig)));});
test('account page uses standalone detail navigation and registered handlers',()=>{const app=JSON.parse(fs.readFileSync(path.join(__dirname,'../app.json'),'utf8'));assert.ok(app.pages.includes('pages/account/account'));const pageConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'../pages/account/account.json'),'utf8'));assert.equal(pageConfig.navigationStyle,undefined);let definition;global.Page=d=>definition=d;delete require.cache[require.resolve('../pages/account/account')];require('../pages/account/account');delete global.Page;const markup=fs.readFileSync(path.join(__dirname,'../pages/account/account.wxml'),'utf8');assert.doesNotMatch(markup,/<main-nav\b|<safe-nav\b|with-tabbar/);for(const match of markup.matchAll(/(?:bindtap|bindinput|bindchange)="([A-Za-z_]+)"/g))assert.equal(typeof definition[match[1]],'function',match[1]);});
