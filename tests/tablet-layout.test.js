const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { responsiveMetrics, isTabletLandscape, withLandscapeLayout, pickerMetrics } = require('../utils/window-layout');
const { build, START, TABLET } = require('../scripts/build-tablet-styles');
const root = path.resolve(__dirname, '..');

test('phone portrait and landscape keep native sizing', () => {
  for (const [windowWidth, windowHeight] of [[320,568],[375,667],[390,844],[430,932],[844,390],[932,430]]) {
    const layout = responsiveMetrics({ windowWidth, windowHeight });
    assert.equal(layout.tablet, false);
    assert.equal(layout.unit, windowWidth / 750);
    assert.equal(layout.bottomNavHeight, windowWidth * 92 / 750);
  }
});

test('tablet size stays stable through rotation, keyboard opening and narrow split views', () => {
  for (const [windowWidth, windowHeight] of [[540,810],[810,540],[768,1024],[1024,768],[600,960],[1366,1024]]) {
    assert.deepEqual(responsiveMetrics({ windowWidth, windowHeight }), { tablet:true, unit:.6, bottomNavHeight:64 });
  }
  assert.equal(responsiveMetrics({windowWidth:1024,windowHeight:360,screenWidth:1024,screenHeight:768}).unit,.6);
  assert.equal(responsiveMetrics({windowWidth:480,windowHeight:1000,screenWidth:768,screenHeight:1024}).tablet,false);
  assert.equal(responsiveMetrics({windowWidth:932,windowHeight:430,screenWidth:932,screenHeight:430}).tablet,false);
});

test('project picker reserves the physical tablet nav height and fits its available window', () => {
  for (const width of [600,768,1024,1366]) {
    const info={windowWidth:width,windowHeight:600,screenHeight:600,safeArea:{bottom:580}};
    const m=pickerMetrics(info,78,true);
    const bottom=width>=680?20:84;
    assert.equal(m.overlayBottom,bottom);
    assert.equal(m.pickerScale,.6);
    assert.ok(m.cardHeight<=m.cardMaxHeight);
    assert.ok(m.cardMaxHeight<=600-78-bottom-32);
    assert.ok(m.bodyHeight>0);
  }
  assert.equal(pickerMetrics({windowWidth:390,windowHeight:844},78,true).overlayBottom,390*108/750);
});

test('dedicated landscape UI only activates on a wide tablet window', () => {
  assert.equal(isTabletLandscape({windowWidth:1024,windowHeight:768}),true);
  assert.equal(isTabletLandscape({windowWidth:1366,windowHeight:1024}),true);
  assert.equal(isTabletLandscape({windowWidth:1024,windowHeight:1366}),false);
  assert.equal(isTabletLandscape({windowWidth:932,windowHeight:430,screenWidth:932,screenHeight:430}),false);
  assert.equal(isTabletLandscape({windowWidth:800,windowHeight:700}),true);
  assert.equal(isTabletLandscape({windowWidth:900,windowHeight:1000,screenWidth:1366,screenHeight:1024}),false,'a tall split window keeps its portrait layout');
  assert.equal(isTabletLandscape({windowWidth:1024,windowHeight:700,screenWidth:1024,screenHeight:1366}),false,'a portrait keyboard cannot change the workspace');
  assert.equal(pickerMetrics({windowWidth:1024,windowHeight:768},78,true).overlayBottom,0);
  assert.equal(pickerMetrics({windowWidth:768,windowHeight:1024},78,true).overlayBottom,64);
});

test('landscape lifecycle updates preserve page arguments, results and portrait keyboard state', () => {
  const calls=[],result=Promise.resolve('unchanged');
  const definition=withLandscapeLayout({data:{},onLoad(...args){calls.push(args);return result;}});
  const page={...definition,data:{...definition.data},patches:[],setData(p){this.patches.push(p);Object.assign(this.data,p);}};
  let info={windowWidth:1024,windowHeight:700,screenWidth:1024,screenHeight:1366};
  global.wx={getWindowInfo:()=>info};
  try {
    assert.equal(page.onLoad({projectId:'math'}),result);
    assert.deepEqual(calls,[[{projectId:'math'}]]);assert.equal(page.data.landscapeLayout,false);
    info={windowWidth:1366,windowHeight:1024,screenWidth:1366,screenHeight:1024};
    page.onResize({deviceOrientation:'landscape'});assert.equal(page.data.landscapeLayout,true);
    page.onResize({deviceOrientation:'landscape'});assert.equal(page.patches.length,1);
    info={windowWidth:1024,windowHeight:700,screenWidth:1024,screenHeight:1366};
    page.onShow();assert.equal(page.data.landscapeLayout,false,'returning after rotation discards the old device orientation');
    assert.deepEqual(page.patches,[{landscapeLayout:true},{landscapeLayout:false}]);
  } finally { delete global.wx; }
});

test('original phone style declarations are unchanged', () => {
  const contract=require('./fixtures/phone-style-contract.json');
  for (const [file,hash] of Object.entries(contract)) {
    const base=fs.readFileSync(path.join(root,file),'utf8').split(START)[0]
      .replace(/^@import "(?:\.\.\/\.\.\/)?themes\/tablet(?:-inline)?\.wxss";\r?\n/gm,'').replace(/\r\n/g,'\n');
    assert.equal(createHash('sha256').update(base).digest('hex'),hash,file);
  }
});

test('tablet generation preserves cascade order and non-rpx resets', () => {
  const source='.a{width:500rpx;color:red}@media (orientation:landscape){.a{width:400rpx}}.a{width:66%;padding:0}';
  const output=build(source);
  assert.ok(output.startsWith(source));
  assert.ok(output.includes('@media '+TABLET));
  assert.ok(output.indexOf('.a{width:300px;color:red}')<output.indexOf('.a{width:240px}'));
  assert.ok(output.lastIndexOf('.a{width:66%;padding:0}')>output.indexOf('.a{width:240px}'));
  assert.equal(build(output),output);
  assert.equal(build(build(source.replaceAll('}', '}\r\n'))),build(source.replaceAll('}', '}\r\n')));
});

test('all checked-in tablet style overrides are current', () => {
  function check(dir) {
    for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,item.name);
      if(item.isDirectory())check(file);
      else if(file.endsWith('.wxss')){
        const source=fs.readFileSync(file,'utf8');
        if(source.includes(START))assert.equal(build(source),source,path.relative(root,file));
      }
    }
  }
  check(path.join(root,'pages'));check(path.join(root,'components'));
  const app=fs.readFileSync(path.join(root,'app.wxss'),'utf8');assert.equal(build(app),app);
});

test('focus canvas remeasures after resize and ignores stale measurements', () => {
  let definition;
  global.Component=d=>{definition=d;};
  delete require.cache[require.resolve('../components/focus-ring/focus-ring')];
  require('../components/focus-ring/focus-ring');
  const callbacks=[],ticks=[],scales=[],canvas=()=>({getContext:()=>({scale:(...args)=>scales.push(args)})});
  global.wx={getWindowInfo:()=>({pixelRatio:2}),nextTick:fn=>ticks.push(fn)};
  const component={...definition.methods,isReady:true,syncs:0,cancels:0,
    sync(){this.syncs++;},cancel(){this.cancels++;},
    createSelectorQuery(){return {select(){return this;},fields(){return this;},exec(fn){callbacks.push(fn);}};}};
  try {
    component.measure();
    definition.pageLifetimes.resize.call(component);
    ticks.shift()();
    const face=canvas(),ring=canvas();
    callbacks[1]([{node:face,width:360,height:360},{node:ring,width:360,height:360}]);
    callbacks[0]([{node:canvas(),width:384,height:384},{node:canvas(),width:384,height:384}]);
    assert.equal(component.size.width,360);assert.equal(component.syncs,1);
    assert.equal(face.width,720);assert.equal(ring.height,720);assert.equal(component.faceCountdown,null);
    assert.deepEqual(scales,[[2,2],[2,2]]);
    definition.pageLifetimes.resize.call(component);component.isReady=false;ticks.shift()();
    assert.equal(callbacks.length,2);
  } finally { delete global.Component;delete global.wx; }
});

test('tablet navigation pages share an automatic orientation configuration', () => {
  assert.equal(require('../app.json').resizable,true);
  assert.equal(require('../pages/focus/focus.json').pageOrientation,'auto');
  assert.equal(require('../app.json').window.pageOrientation,undefined);
  for(const name of ['focus','stats','settings','manage','project-stats','day-stats','settings-detail'])assert.equal(require('../pages/'+name+'/'+name+'.json').pageOrientation,'auto',name);
});

test('focus resizing updates tablet geometry without resetting timer or minute selection', () => {
  const definition=require('../pages/focus/focus-definition')({globalData:{}});
  const page={...definition,data:{...definition.data},patches:[],setData(p){this.patches.push(p);Object.assign(this.data,p);}};
  try {
    global.wx={getWindowInfo:()=>({windowWidth:768,windowHeight:1024})};
    page.onResize();assert.equal(page.data.minuteIndicatorStyle,'height:30px');
    page.onResize();assert.equal(page.patches.length,1);
    global.wx.getWindowInfo=()=>({windowWidth:390,windowHeight:844});
    page.onResize();assert.equal(page.data.minuteIndicatorStyle,'height:50rpx');
    assert.deepEqual(Object.keys(page.patches[0]),['minuteIndicatorStyle','tabletLayout','focusLayoutStyle']);
    assert.equal(page.data.tabletLayout,false);assert.equal(page.data.focusLayoutStyle,'');
    assert.equal(page.data.minuteIndex,29);assert.equal(page.data.targetSeconds,1800);
  } finally { delete global.wx; }
});


test('rotation uses event size before the window API catches up', () => {
 const definition=withLandscapeLayout({data:{},onResize(e){this.seen=e;}});
 const page={...definition,data:{...definition.data},setData(p){Object.assign(this.data,p);}};
 global.wx={getWindowInfo:()=>({windowWidth:540,windowHeight:810,screenWidth:540,screenHeight:810})};
 try {
  page.onResize({deviceOrientation:'landscape',size:{windowWidth:810,windowHeight:540}});
  assert.equal(page.data.landscapeLayout,true);assert.equal(page.seen.size.windowWidth,810);
  assert.equal(isTabletLandscape({windowWidth:810,windowHeight:540,screenWidth:540,screenHeight:810}),true);
  assert.equal(isTabletLandscape({windowWidth:540,windowHeight:400,screenWidth:540,screenHeight:810}),false);
 } finally {delete global.wx;}
});

test('rotating an active timer keeps its session, progress and pending picker', () => {
 const definition=require('../pages/focus/focus-definition')({globalData:{}});
 const cur={state:'STUDYING',sessionId:'existing-session',mode:'countdown',elapsedSeconds:742,targetSeconds:1800};
 const page={...definition,data:{...definition.data,cur,progress:.58,pickerOpen:true,targetSeconds:2700},setData(p){Object.assign(this.data,p);}};
 global.wx={getWindowInfo:()=>({windowWidth:540,windowHeight:810,screenWidth:540,screenHeight:810})};
 try {
  page.onResize({deviceOrientation:'landscape',size:{windowWidth:810,windowHeight:540}});
  assert.equal(page.data.landscapeLayout,true);assert.equal(page.data.focusWideLayout,true);
  assert.ok(page.data.focusLayoutStyle.includes('height:462px'));
  assert.equal(page.data.cur,cur);assert.equal(page.data.progress,.58);assert.equal(page.data.pickerOpen,true);assert.equal(page.data.targetSeconds,2700);
 } finally {delete global.wx;}
});

test('tablet focus reserves controls and caps a circular dial across aspect ratios', () => {
 const {focusLayout}=require('../utils/focus-layout');
 for(const [width,height]of [[540,810],[810,540],[540,720],[720,540],[600,960],[960,600],[768,1024],[1024,768],[1024,1366],[1366,1024],[680,520]]){
  for(const mode of ['countdown','stopwatch'])for(const state of ['IDLE','STUDYING']){
   const info={windowWidth:width,windowHeight:height};const result=focusLayout(info,78,{mode,cur:{state}});
   const read=key=>Number(result.focusLayoutStyle.match(new RegExp('--'+key+':([0-9.]+)px'))[1]);
   assert.equal(result.tabletLayout,true);assert.ok(read('tablet-dial-size')>=120&&read('tablet-dial-size')<=280);
   assert.ok(read('tablet-workspace-height')<=height-78-(width>height?0:64)-32);
   if(width>height)assert.ok(read('tablet-dial-size')+read('tablet-controls-width')+64<=width-140);
   assert.ok(read('tablet-dock-max')>=204);
  }
 }
 assert.deepEqual(focusLayout({windowWidth:932,windowHeight:430},78,{}),{tabletLayout:false,focusWideLayout:false,focusLayoutStyle:''});
});

test('short tablet split windows keep primary controls beside the dial without forcing a side nav', () => {
 const {focusLayout}=require('../utils/focus-layout');
 for(const [width,height]of [[500,540],[540,600],[600,600]]){
  const info={windowWidth:width,windowHeight:height,screenWidth:810,screenHeight:540,safeArea:{bottom:520}};
  const layout=focusLayout(info,78,{cur:{state:'IDLE'},mode:'countdown'});
  assert.equal(layout.tabletLayout,true);assert.equal(layout.focusWideLayout,true);
  assert.equal(isTabletLandscape(info),false);assert.ok(layout.focusLayoutStyle.includes('--tablet-bottom-space:84px'));
  const dial=Number(layout.focusLayoutStyle.match(/--tablet-dial-size:([0-9]+)px/)[1]);
  assert.ok(dial+220+64<=width-48,'both columns fit the window');
 }
});

test('focus canvas remeasures when its tablet workspace changes without a window resize', () => {
 let definition;global.Component=d=>{definition=d;};delete require.cache[require.resolve('../components/focus-ring/focus-ring')];require('../components/focus-ring/focus-ring');
 const ticks=[];global.wx={nextTick:fn=>ticks.push(fn)};const component={isReady:true,count:0,measure(){this.count++;}};
 try {
  definition.properties.layoutKey.observer.call(component);assert.equal(component.count,0);ticks.shift()();assert.equal(component.count,1);
  definition.properties.layoutKey.observer.call(component);component.isReady=false;ticks.shift()();assert.equal(component.count,1);
 } finally {delete global.Component;delete global.wx;}
});
