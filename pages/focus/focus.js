// pages/focus/focus.js
const { uuid } = require('../../core/ids.js');
const format = require('../../utils/format.js');
const sound=require('../../utils/sound');const view=require('../../utils/view-data');
const restStore=require('../../utils/rest-break');
const guideWelcome=require('../../utils/guide-welcome');
const {createDefaultAdapter}=require('../../storage/adapter');

// 倒计时预设（D02：UI 固定 15/30/45/60，默认 30；业务层整数秒 ≥60）
const PRESETS = [
  { key: 15 * 60, label: '15分钟' },
  { key: 30 * 60, label: '30分钟' },
  { key: 45 * 60, label: '45分钟' },
  { key: 60 * 60, label: '60分钟' },
  { key: 'custom', label: '自定义' }
];

function flipParts(text){const values=text.split(':');return values.map((value,i)=>({key:i,value,turn:Number(value)%2,unit:(values.length===3?['小时','分钟','秒']:['分钟','秒'])[i]}));}
const app = getApp();
function focusClock(sec,mode){return mode==='stopwatch'?format.pad2(Math.floor(sec/3600))+':'+format.pad2(Math.floor(sec%3600/60))+':'+format.pad2(sec%60):format.clockText(sec);}

Page({
  data: {
    ready: false,
    focusNavHeight: 78,
    activeTab: 0, statsNavHidden: false,
    welcomeOpen: false,
    completionVisible:false,restPrompt:false,restState:null,restRemaining:0,restClock:'00:00',restRound:0,restDuration:0,goalEnabled:false,goalMinutes:120,goalProgress:0,goalProgressStyle:'width:0%;',progress:1,keepScreenOn:false,confirmEnd:true,immersive:false,screenLocked:false,todayOpen:false,todayDate:'',todayText:'0秒',customOpen:false,customMinutes:'30',minuteOptions:[],minuteIndex:29,minuteWheelValue:[29],
    cur: null,
    blocked: null,
    // 表盘
    bigText: '30:00',
    captionText: '计划专注时长',
    pillText: '空闲待命',
    pausedLook: false,
    // 模式与时长（仅 IDLE 可改）
    mode: 'countdown', // 'stopwatch' | 'countdown'
    modeItems: [
      { key: 'stopwatch', label: '正向计时' },
      { key: 'countdown', label: '倒计专注' }
    ],
    presets: PRESETS,
    targetSeconds: 30 * 60,
    activePresetKey: 30 * 60,
    // 非空闲时的副信息
    targetLabel: '30分钟',
    // 页内项目选择
    pickerOpen: false,
    pickerRecent: [],
    pickerTreeRows: [],
    pickerNewName: '',
    pickerParentId: null,
    pickerParentName: '根目录（顶级项目）'
  },

  onLoad(q) {
    // All three main tabs share this page; deeper screens use native navigation.
    this.isShell = true;
    const initialTab = Math.min(2, Math.max(0, Number(q && q.tab) || 0));
    this.setData({ activeTab: initialTab });
    app.globalData.readyPromise.then(() => {
      this.setData({ ready: true });
      if (this.data.activeTab === 0) this.refresh();
    });
  },

  onShow() {
    this.openingShell = false;
    this.visible=true;
    sound.stop();
    require('../../utils/theme').applyPageTheme(this);
    if(this.data.immersive)wx.setKeepScreenOn({keepScreenOn:true});
    if (this.data.activeTab === 0) {
      this.restoreRest();
      if (app.globalData.ready) this.refresh();
    }
    if (this.preservePickerOnHide && this.data.pickerOpen) {
      const sheet = this.selectComponent('#projectSheet');
      if (sheet) sheet.load();
    }
    this.preservePickerOnHide = false;
  },

  onHide() {
    this.visible=false;
    this.stopTick();sound.stop();wx.setKeepScreenOn({keepScreenOn:false});
    if (this.data.pickerOpen && !this.preservePickerOnHide) this.closePicker();
  },

  onUnload() {
    this.visible=false;
    this.stopTick();
    sound.stop();
    wx.setKeepScreenOn({keepScreenOn:false});
    this.stopRestTick();
  },

  stopTick() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  startTick() {
    this.stopTick();
    if (!this.visible || this.data.activeTab !== 0) return;
    this.timer = setInterval(() => {
      const g = getApp().globalData;
      g.tickFires = (g.tickFires || 0) + 1;
      const service = app.globalData.service;
      if (!service) return;
      const env = service.peekCurrent();
      if (!env.ok) return;
      const cur = env.data;
      // 倒计时到期：peek 不做写结算，归零立即走 getCurrent（排队→结算），
      // 随后刷新并弹出完成提示。到期有确定处理，不依赖切后台。
      if (cur.state === 'STUDYING' && cur.mode === 'countdown' &&
        (cur.remainingSeconds || 0) === 0) {
        this.setData({completionVisible:true,progress:0,bigText:'00:00'});
        service.getCurrent().then((settled) => {
          if (settled.ok) {
            this.refresh();
          }
        });
        return;
      }
      // 状态变化（如已在别处结算）走完整刷新；进行中每秒只更新可见计时字段
      if (cur.state !== 'STUDYING') {
        this.applyCur(cur);
        return;
      }
      const mainSeconds = cur.mode === 'countdown'
        ? cur.remainingSeconds
        : cur.elapsedSeconds;
      if(this.todayBase&&this.todayBase.date!==view.today())this.updateToday();
      const todaySeconds=this.todayBase?this.todayBase.seconds+Math.max(0,cur.elapsedSeconds-this.todayBase.elapsed):0;
      const payload = {
        todayText:format.durationText(todaySeconds),goalProgress:this.data.goalEnabled?Math.round(Math.min(100,todaySeconds/(this.data.goalMinutes*60)*100)):0,
        goalProgressStyle:'width:'+(this.data.goalEnabled?Math.round(Math.min(100,todaySeconds/(this.data.goalMinutes*60)*100)):0)+'%;',
        progress:cur.mode==='countdown'?cur.remainingSeconds/cur.targetSeconds:(cur.elapsedSeconds%3600)/3600,
        bigText: focusClock(mainSeconds || 0,cur.mode),
        elapsedText: format.clockText(cur.elapsedSeconds || 0),
        'cur.remainingSeconds': cur.remainingSeconds,
        'cur.elapsedSeconds': cur.elapsedSeconds
      };
      if(this.data.immersive)payload.clockParts=flipParts(payload.bigText);
      const t0 = Date.now();
      this.setData(payload, () => {
        // 仅在 e2e 显式开启时记录（无渲染开销），正常使用无输出
        if (this.perf) {
          getApp().globalData.perfEntries.push({
            k: 'tick',
            newBytes: JSON.stringify(payload).length,
            setDataMs: Date.now() - t0
          });
        }
      });
    }, 1000);
  },

  // e2e 钩子：以 60 秒倒计时开始（自动化在 1 分钟内完成真实到期验证，不改变产品界面）
  async __startShort() {
    const service = app.globalData.service;
    const cur = this.data.cur;
    if (!cur || cur.state !== 'IDLE' || !cur.projectId) return;
    const env = await service.start({
      operationId: uuid(),
      projectId: cur.projectId,
      targetSeconds: 60
    });
    if (env.ok) this.applyCur(env.data);
  },

  // e2e 钩子：执行真实 App.onShow（回前台：恢复/到期结算）
  simAppShow() {
    getApp().onShow();
  },

  // e2e 冷启动重置流程的一部分：清空并 reLaunch 后重新完整 init
  async resetApp() {
    await app.globalData.service.init();
    this.setData({ blocked: null });
    this.refresh();
  },

  // e2e 钩子：开启每秒 setData 实测
  enablePerf() {
    this.perf = true;
    const oldPayload = { cur: this.data.cur || {}, bigText: '00:00:00', elapsedText: '00:00:00' };
    const newPayload = { bigText: '00:00:00', elapsedText: '00:00:00', 'cur.elapsedSeconds': 0 };
    getApp().globalData.perfEntries = [{
      k: 'baseline',
      oldBytes: JSON.stringify(oldPayload).length,
      newBytes: JSON.stringify(newPayload).length
    }];
  },

  async refresh() {
    const service = app.globalData.service;
    const prefs = await service.getPrefs();
    if (prefs) {
      this.setData({ keepScreenOn: !!prefs.keepScreenOn, confirmEnd: prefs.confirmEnd !== false });
    }
    const env = await service.getCurrent();
    if (!env.ok) {
      this.setData({ blocked: env.error });
      return;
    }
    this.setData({ blocked: null });
    if (prefs && env.data.state === 'IDLE') this.applyIdlePrefs(prefs);
    this.applyCur(env.data);
    this.updatePath(env.data.projectId);
    this.consumeNotices();this.updateToday();
    this.maybeShowWelcome();
  },

  async maybeShowWelcome() {
    // The base page below the focus shell must never flash a second welcome.
    if (!this.isShell || !this.visible || this.welcomeChecking || app.globalData.guideWelcomeChecked || !guideWelcome.canPresentWelcome(this.data)) return;
    this.welcomeChecking = true;
    const adapter = app.globalData.adapter;
    try {
      const status = await guideWelcome.readWelcomeStatus(adapter);
      if (status === 'seen' || status === 'existing') {
        app.globalData.guideWelcomeChecked = true;
        if (status === 'existing') await guideWelcome.rememberWelcome(adapter);
        return;
      }
      const pages = getCurrentPages(), current = app.globalData.service.peekCurrent();
      if (status === 'new' && this.visible && pages[pages.length - 1] === this &&
          guideWelcome.canPresentWelcome(this.data) && current.ok && current.data.state === 'IDLE' && !current.data.projectId && !restStore.read()) {
        app.globalData.guideWelcomeChecked = true;
        this.setData({ welcomeOpen: true });
      }
    } catch (e) {
      // Optional onboarding must never block loading or writing timer data.
    } finally { this.welcomeChecking = false; }
  },

  dismissWelcome() {
    this.setData({ welcomeOpen: false });
    app.globalData.guideWelcomeChecked = true;
    guideWelcome.rememberWelcome(app.globalData.adapter).catch(() => {});
  },

  openWelcomeGuide() {
    wx.navigateTo({ url: '/pages/guide/guide', success: () => this.dismissWelcome(),
      fail: () => wx.showToast({ title: '暂时无法打开指南，请重试', icon: 'none' }) });
  },

  applyIdlePrefs(prefs) {
    const rememberedMode = prefs.lastStartMode === 'stopwatch' || prefs.lastStartMode === 'countdown' ? prefs.lastStartMode : 'countdown';
    const mode = prefs.startupMode === 'countdown' ? 'countdown' : prefs.startupMode === 'stopwatch' ? 'stopwatch' : rememberedMode;
    const defaultMinutes = Number.isInteger(prefs.defaultMinutes) && prefs.defaultMinutes >= 1 && prefs.defaultMinutes <= 1440 ? prefs.defaultMinutes : 30;
    const minutes = defaultMinutes, targetSeconds = minutes * 60;
    const validCommon = Array.isArray(prefs.commonMinutes) && prefs.commonMinutes.length === 4 && prefs.commonMinutes.every(m => Number.isInteger(m) && m >= 1 && m <= 1440) && new Set(prefs.commonMinutes).size === 4;
    const common = validCommon ? prefs.commonMinutes : [15,30,45,60];
    const presets = common.slice().sort((a,b)=>a-b).map(m=>({key:m*60,label:m+'分钟'})).concat([{key:'custom',label:'自定义'}]);
    this.setData({ mode, targetSeconds, activePresetKey: common.includes(minutes) ? targetSeconds : 'custom', presets });
  },

  // IDLE 表盘：倒计时显示计划时长；正计时显 00:00
  idleDial() {
    if (this.data.mode === 'countdown') {
      return {
        bigText: this.data.completionVisible?'00:00':format.clockText(this.data.targetSeconds),
        progress:this.data.completionVisible?0:1,
        captionText: this.data.completionVisible?'本轮专注已完成':'计划专注时长',
        pillText: '空闲待命',
        pausedLook: false
      };
    }
    return {
      bigText: '00:00:00',progress:0,
      captionText: '正向计时 · 开始后累计',
      pillText: '空闲待命',
      pausedLook: false
    };
  },

  applyCur(cur) {
    let patch;
    if (cur.state === 'IDLE') {
      patch = this.idleDial();
    } else if (cur.state === 'PAUSED') {
      const main = cur.mode === 'countdown' ? cur.remainingSeconds : cur.elapsedSeconds;
      patch = {
        bigText: focusClock(main || 0,cur.mode),
        captionText: '已暂停 · 点击继续',
        pillText: '已暂停',
        pausedLook: true
      };
    } else {
      const main = cur.mode === 'countdown' ? cur.remainingSeconds : cur.elapsedSeconds;
      patch = {
        bigText: focusClock(main || 0,cur.mode),
        captionText: cur.mode === 'countdown' ? '剩余专注时间' : '已专注时间',
        pillText: cur.mode === 'countdown' ? '倒计专注中' : '正向计时中',
        pausedLook: false,
        targetLabel: cur.targetSeconds ? this.labelOfTarget(cur.targetSeconds) : ''
      };
    }
    if(this.data.immersive)patch.clockParts=flipParts(patch.bigText);
    this.setData(Object.assign({
      cur: cur,
      elapsedText: format.clockText(cur.elapsedSeconds || 0)
    }, patch));
    this.setData({progress:cur.state==='IDLE'?patch.progress:cur.mode==='countdown'?cur.remainingSeconds/cur.targetSeconds:(cur.elapsedSeconds%3600)/3600});
    sound.stop();
    wx.setKeepScreenOn({keepScreenOn:!!(this.data.immersive||(this.data.keepScreenOn&&cur.state==='STUDYING'&&this.visible&&this.data.activeTab===0))});
    if(cur.state==='IDLE'&&(this.data.immersive||this.data.screenLocked)){this.setData({immersive:false,screenLocked:false});this.updateTabVisibility();wx.setKeepScreenOn({keepScreenOn:false});}
    if (cur.state === 'STUDYING' && this.visible && this.data.activeTab === 0) this.startTick();
    else this.stopTick();
  },

  labelOfTarget(seconds) {
    for (let i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].key === seconds) return PRESETS[i].label;
    }
    return format.durationText(seconds);
  },

  async consumeNotices() {
    const service = app.globalData.service;
    const notices = service.takeNotices();
    if (!notices.length) return;
    const n = notices[notices.length - 1];
    this.setData({completionVisible:true,progress:0,bigText:'00:00',captionText:'本轮专注已完成'});
    const prefs = await service.getPrefs();
    let round=await app.globalData.adapter.get('yotick/rest-round-count')||0;
    if(n.durationSeconds>0){round++;await app.globalData.adapter.set('yotick/rest-round-count',round);}
    if (prefs && prefs.restEnabled && n.durationSeconds > 0) {
      const long = round % (prefs.longBreakEvery || 4) === 0;
      const minutes = long ? (prefs.longBreakMinutes || 15) : (prefs.shortBreakMinutes || 5);
      this.setData({ restPrompt: true, restRound: round, restDuration: minutes * 60, restLong: long });
      return;
    }
    wx.showModal({
      title: '专注完成',
      content: '本轮专注 ' + format.durationText(n.durationSeconds) + '，记录已保存。',
      showCancel: false,
      confirmText: '知道了',
      complete:()=>{this.setData({completionVisible:false},()=>{if(this.data.cur&&this.data.cur.state==='IDLE')this.setData(this.idleDial());});}
    });
  },

  onFocusNavHeight(e) {
    const height = Number(e.detail.height);
    if (height > 0 && height !== this.data.focusNavHeight) this.setData({ focusNavHeight: height });
  },

  onSegMode(e) {
    if(this.data.cur && this.data.cur.state !== 'IDLE')return;
    const mode = e.detail.key;
    if (this.data.mode === mode) return;
    this.setData({ mode: mode }, () => this.setData(this.idleDial()));
  },

  // ---------------- 模式与时长 ----------------
  onModeTap(e) {
    const mode = e.currentTarget.dataset.mode;
    if (this.data.cur && this.data.cur.state !== 'IDLE') return;
    this.setData({ mode: mode }, () => {
      this.setData(this.idleDial());
    });
  },

  onPresetTap(e) {
    if (this.data.cur && this.data.cur.state !== 'IDLE') return;
    const key = e.currentTarget.dataset.key;
    if (key === 'custom') { this.askCustom(); return; }
    this.setData({
      activePresetKey: key,
      targetSeconds: key
    }, () => this.setData(this.idleDial()));
  },

  askCustom(){this.setData({customOpen:true,customMinutes:String(this.data.targetSeconds/60),minuteOptions:Array.from({length:1440},(_,i)=>(i+1)+' 分钟'),minuteIndex:this.data.targetSeconds/60-1,minuteWheelValue:[this.data.targetSeconds/60-1]});this.updateTabVisibility();},
  closeCustom(){this.setData({customOpen:false});this.updateTabVisibility();},minuteInput(e){const value=e.detail.value,minutes=Number(value),patch={customMinutes:value};if(Number.isInteger(minutes)&&minutes>=1&&minutes<=1440){patch.minuteIndex=minutes-1;patch.minuteWheelValue=[minutes-1];}this.setData(patch);},minutePick(e){const i=e.detail.value[0];this.setData({minuteIndex:i,customMinutes:String(i+1)});},
  confirmCustom(){const v=Number(this.data.customMinutes);if(!Number.isInteger(v)||v<1||v>1440){wx.showToast({title:'请选择 1–1440 分钟',icon:'none'});return;}this.setData({customOpen:false,targetSeconds:v*60,activePresetKey:'custom'},()=>this.setData(this.idleDial()));this.updateTabVisibility();},
  noop(){},
  openImmersive(){this.setData({immersive:true,clockParts:flipParts(this.data.bigText)});this.updateTabVisibility();wx.setKeepScreenOn({keepScreenOn:true});},closeImmersive(){this.setData({immersive:false});this.updateTabVisibility();wx.setKeepScreenOn({keepScreenOn:!!(this.data.keepScreenOn&&this.data.cur&&this.data.cur.state==='STUDYING')});},
  lockScreen(){this.setData({screenLocked:true});this.updateTabVisibility();},unlockScreen(){this.setData({screenLocked:false});this.updateTabVisibility();},
  async openToday(){this.setData({todayOpen:true,todayDate:view.today()});this.updateTabVisibility();},
  closeToday(){this.setData({todayOpen:false});this.updateTabVisibility();},
  async onRecordDeleted(){await this.updateToday();const panel=this.selectComponent('#statsPanel');if(panel&&panel.load)await panel.load();},
  async updateToday(){const e=await app.globalData.service.getStatistics({preset:'today',mode:'realtime'});const prefs=await app.globalData.service.getPrefs();if(prefs)this.setData({goalEnabled:!!prefs.dailyGoalEnabled,goalMinutes:prefs.dailyGoalMinutes||120});if(e.ok){const current=app.globalData.service.peekCurrent();this.todayBase={date:view.today(),seconds:e.data.totalSeconds,elapsed:current.ok?current.data.elapsedSeconds:0};const progress=this.data.goalEnabled?Math.round(Math.min(100,e.data.totalSeconds/(this.data.goalMinutes*60)*100)):0;this.setData({todayText:format.durationText(e.data.totalSeconds),goalProgress:progress,goalProgressStyle:'width:'+progress+'%;'});}},
  // ---------------- 页内项目选择 ----------------
  goPicker() {
    if (this.data.pickerOpen) return;
    if (this.data.cur && this.data.cur.state !== 'IDLE') { wx.showToast({title:'本轮专注已锁定，结束后可切换项目',icon:'none'}); return; }
    this.setData({ pickerOpen: true });
    wx.setNavigationBarTitle({ title: '选择项目/科目' });
    this.updateTabVisibility();
  },

  closePicker() {
    this.pickerLoadToken = (this.pickerLoadToken || 0) + 1;
    this.setData({ pickerOpen: false });
    this.updateTabVisibility();
    wx.setNavigationBarTitle({ title: '专注' });
  },

  openPickerAppearance(e) {
    this.preservePickerOnHide = true;
    wx.navigateTo({
      url: '/pages/project-appearance/project-appearance?id=' + encodeURIComponent(e.detail.projectId),
      fail: () => { this.preservePickerOnHide = false; }
    });
  },
  openPickerManage() {
    this.preservePickerOnHide = true;
    wx.navigateTo({ url: '/pages/manage/manage', fail: () => { this.preservePickerOnHide = false; } });
  },

  async loadPicker() {
    const token = this.pickerLoadToken = (this.pickerLoadToken || 0) + 1;
    const env = await app.globalData.service.getPickerData();
    if (!env.ok || !this.data.pickerOpen || token !== this.pickerLoadToken) return;
    this.pickerRowsById = {};
    env.data.treeRows.forEach((row) => { this.pickerRowsById[row.projectId] = row; });
    // 图标在 JS 侧预算，避免 WXML 表达式内字符串字面量的兼容问题
    const pickerTreeRows = env.data.treeRows.map((r) => ({
      ...r,
      icon: r.startable ? '◦' : '▸'
    }));
    this.setData({ pickerRecent: env.data.recent, pickerTreeRows: pickerTreeRows });
  },

  pickerPath(row) {
    const names = [];
    const visited = {};
    while (row && !visited[row.projectId]) {
      visited[row.projectId] = true;
      names.unshift(row.name);
      row = row.parentId && this.pickerRowsById[row.parentId];
    }
    return names.join(' / ');
  },

  onPickerNameInput(e) {
    this.setData({ pickerNewName: e.detail.value });
  },

  onPickerTreeTap(e) {
    const row = this.pickerRowsById && this.pickerRowsById[e.currentTarget.dataset.id];
    if (!row) return;
    if (row.startable) this.selectPickerProject(row.projectId);
    else this.setData({ pickerParentId: row.projectId, pickerParentName: this.pickerPath(row) });
  },

  onPickerParentTap(e) {
    const row = this.pickerRowsById && this.pickerRowsById[e.currentTarget.dataset.id];
    if (row) this.setData({ pickerParentId: row.projectId, pickerParentName: this.pickerPath(row) });
  },

  clearPickerParent() {
    this.setData({ pickerParentId: null, pickerParentName: '根目录（顶级项目）' });
  },

  async createPickerProject() {
    const name = (this.data.pickerNewName || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入项目名称', icon: 'none' });
      return;
    }
    const env = await app.globalData.service.createProject({
      operationId: uuid(), name, parentId: this.data.pickerParentId
    });
    if (!env.ok) {
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    wx.showToast({ title: '已创建', icon: 'success' });
    this.setData({
      pickerNewName: '', pickerParentId: null,
      pickerParentName: '根目录（顶级项目）'
    });
    this.loadPicker();
  },

  onPickerRecentTap(e) {
    this.selectPickerProject(e.currentTarget.dataset.id);
  },

  async selectPickerProject(id) {
    const env = await app.globalData.service.savePrefs({ lastProjectId: id });
    if (!env.ok) {
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    this.closePicker();
    this.refresh();
  },

  goStats() {
    this.switchMainTab({ detail: { tab: 1 } });
  },

  switchMainTab(e) {
    const tab = Number(e.detail.tab);
    if (!Number.isInteger(tab) || tab < 0 || tab > 2 || tab === this.data.activeTab) return;
    this.stopTick();
    this.stopRestTick();
    this.setData({ activeTab: tab, statsNavHidden: tab === 1 && this.data.statsNavHidden }, () => {
      if (tab === 0) { this.restoreRest(); this.refresh(); }
    });
  },
  onStatsNavHiddenChange(e) {
    this.setData({ statsNavHidden: !!e.detail.hidden });
  },

  // ---------------- 计时操作 ----------------
  async onStart() {
    const existingRest = restStore.read();
    if (existingRest) {
      wx.showModal({ title: '结束休息并开始专注？', content: '当前休息计时将结束。', confirmText: '开始专注', success: r => { if (r.confirm) { restStore.clear(); this.stopRestTick(); this.setData({ restState: null, restRemaining: 0 }); this.startFocus(); } } });
      return;
    }
    this.startFocus();
  },

  async startFocus() {
    const service = app.globalData.service;
    const cur = this.data.cur;
    if (!cur || cur.state !== 'IDLE') return;
    const projectId = cur.projectId;
    if(projectId){const picker=await service.getPickerData();if(!picker.ok){wx.showToast({title:picker.error.message,icon:'none'});return;}if(!picker.data.treeRows.some(r=>r.projectId===projectId&&r.startable)){this.goPicker();return;}}
    if (!projectId) {
      this.goPicker();
      return;
    }
    const targetSeconds = this.data.mode === 'countdown' ? this.data.targetSeconds : null;
    const env = await service.start({
      operationId: uuid(),
      projectId: projectId,
      targetSeconds: targetSeconds
    });
    if (!env.ok) {
      if (env.error.code === 'PROJECT_NOT_FOUND' || env.error.code === 'PROJECT_ARCHIVED') {
        this.goPicker();
      } else {
        wx.showToast({ title: env.error.message, icon: 'none' });
      }
      return;
    }
    const prefEnv = await service.savePrefs({ lastStartMode: this.data.mode });
    if (!prefEnv.ok) wx.showToast({ title: '本轮已开始，但启动习惯未能保存', icon: 'none' });
    this.applyCur(env.data);
  },

  startRest() {
    const seconds = this.data.restDuration;
    if (!seconds) return;
    const state = { status: 'RUNNING', durationSeconds: seconds, endsAtMs: Date.now() + seconds * 1000, startedAtMs: Date.now() };
    restStore.write(state);
    this.setData({ restPrompt: false, restState: 'RUNNING', restRemaining: seconds, restClock: format.clockText(seconds), completionVisible: false });
    this.startRestTick();
  },
  skipRest() { restStore.clear(); this.stopRestTick(); this.setData({ restPrompt: false, restState: null, restRemaining: 0, completionVisible: false }, () => { if(this.data.cur&&this.data.cur.state==='IDLE')this.setData(this.idleDial()); }); },
  pauseRest() {
    const value = restStore.read(); if (!value) return;
    const remainingSeconds = restStore.remaining(value);
    restStore.write(Object.assign({}, value, { status: 'PAUSED', remainingSeconds }));
    this.stopRestTick(); this.setData({ restState: 'PAUSED', restRemaining: remainingSeconds, restClock: format.clockText(remainingSeconds) });
  },
  resumeRest() {
    const value = restStore.read(); if (!value) return;
    const remainingSeconds = restStore.remaining(value);
    restStore.write(Object.assign({}, value, { status: 'RUNNING', endsAtMs: Date.now() + remainingSeconds * 1000 }));
    this.setData({ restState: 'RUNNING', restRemaining: remainingSeconds, restClock: format.clockText(remainingSeconds) }); this.startRestTick();
  },
  stopRestTick() { if (this.restTimer) { clearInterval(this.restTimer); this.restTimer = null; } },
  startRestTick() { this.stopRestTick(); this.restTimer = setInterval(() => this.tickRest(), 1000); this.tickRest(); },
  tickRest() {
    const value = restStore.read(); if (!value) { this.stopRestTick(); this.setData({ restState: null, restRemaining: 0 }); return; }
    const remaining = restStore.remaining(value);
    if (remaining <= 0) { restStore.clear(); this.stopRestTick(); this.setData({ restState: null, restRemaining: 0 }); wx.showModal({ title: '休息结束', content: '准备好开始下一轮专注了吗？', showCancel: false }); return; }
    this.setData({ restRemaining: remaining, restClock: format.clockText(remaining) });
  },
  restoreRest() {
    const value = restStore.read();
    if (!value) { this.setData({ restState: null, restRemaining: 0 }); return; }
    const remaining = restStore.remaining(value);
    if (remaining <= 0) { restStore.clear(); this.setData({ restState: null, restRemaining: 0 }); wx.showToast({ title: '休息时间已结束', icon: 'none' }); return; }
    this.setData({ restState: value.status, restRemaining: remaining, restClock: format.clockText(remaining) }, () => { if (value.status === 'RUNNING') this.startRestTick(); });
  },

  async onPause() {
    const cur = this.data.cur;
    const env = await app.globalData.service.pause({ operationId: uuid(), sessionId: cur.sessionId });
    if (!env.ok) wx.showToast({ title: env.error.message, icon: 'none' });
    else this.applyCur(env.data);
  },

  async onResume() {
    const cur = this.data.cur;
    const env = await app.globalData.service.resume({ operationId: uuid(), sessionId: cur.sessionId });
    if (!env.ok) wx.showToast({ title: env.error.message, icon: 'none' });
    else this.applyCur(env.data);
  },

  updateTabVisibility(){},
  projectSelected(){this.closePicker();this.refresh();},
  async updatePath(id){this.pathProjectId=id;if(!id){this.setData({projectPath:'',projectParentPath:'',projectLeafName:'',projectSelectColor:'#58785b',canStartSelected:false});return;}const e=await app.globalData.service.getPickerData();if(!e.ok||this.pathProjectId!==id)return;const rows=e.data.treeRows;const names=[];let r=rows.find(r=>r.projectId===id);while(r){names.unshift(r.name);r=rows.find(p=>p.projectId===r.parentId);}const selected=rows.find(r=>r.projectId===id);this.setData({projectPath:names.join(' › '),projectParentPath:names.length>1?names[names.length-2]:'',projectLeafName:names[names.length-1]||'',projectSelectColor:selected&&selected.color||'#58785b',canStartSelected:!!(selected&&selected.startable)});},
  confirmStop(){const e=app.globalData.service.peekCurrent();if(!e.ok||e.data.state==='IDLE')return;if(!this.data.confirmEnd){this.onStop();return;}wx.showModal({title:'结束本轮专注？',content:'将保存已经学习的时间 '+format.durationText(e.data.elapsedSeconds)+'。',confirmText:'结束',cancelText:'继续专注',success:r=>{if(r.confirm)this.onStop();},fail:()=>wx.showToast({title:'未能打开结束提醒，请重试',icon:'none'})});},
  async onStop() {
    const cur = this.data.cur;
    const env = await app.globalData.service.stop({ operationId: uuid(), sessionId: cur.sessionId });
    if (!env.ok) {
      wx.showToast({ title: env.error.message, icon: 'none' });
      return;
    }
    this.applyCur(env.data);
    this.refresh();
  }
});
