const { THEME_COLORS } = require('../../utils/theme');
// Settings detail page. Native navigation keeps settings home in the page stack.
const app = getApp();
const { uuid } = require('../../core/ids');
const { SCALE_MINUTES, SCALE_LABELS } = require('../../utils/time-slot-chart');
const { LIGHT_THEMES, isLightTheme } = require('../../utils/light-theme-options');
const DEFAULTS = {
  startupMode: 'remember', lastStartMode: null, defaultMinutes: 30,
  commonMinutes: [15, 30, 45, 60], confirmEnd: true,
  keepScreenOn: false, statsPreset: 'today', dailyGoalEnabled: false, dailyGoalMinutes: 120, weekStartsSunday: false, theme: 'system', lightTheme: 'forest', timeSlotScaleMinutes: 0,
  restEnabled: false, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4
};
const SECTIONS = {
  focus: { title: '专注与休息', rows: ['计时习惯', '默认倒计时', '常用时长', '结束确认', '休息安排'] },
  display: { title: '外观与屏幕', rows: ['外观主题', '屏幕常亮', '极简模式与锁定'] },
  stats: { title: '目标与统计', rows: ['统计默认范围', '显示今日目标', '时段图满格', '每周起始日'] },
  data: { title: '数据与备份', rows: ['项目管理', '恢复默认设置'] },
  help: { title: '帮助与关于', rows: ['使用帮助', '关于 Foclo', '隐私政策'] }
};
Page({
  data: { loading: true, moreDataOpen: false, page: 'focus', title: '专注与休息', prefs: DEFAULTS, lightThemes: LIGHT_THEMES, minuteOptions: [], commonIndexes: [14,29,44,59], defaultMinuteIndex: 29, shortOptions: [], longOptions: [], cycleOptions: [], slotScaleOptions:SCALE_LABELS, slotScaleIndex:0 },
  onLoad(options) {
    const page = options && SECTIONS[options.section] ? options.section : 'focus';
    const title = SECTIONS[page].title;
    this.setData({ page, title });
    wx.setNavigationBarTitle({ title });
  },
  onShow() {
    this.loadPrefs();
  },
  async loadPrefs() {
    if (!app.globalData.ready) await app.globalData.readyPromise;
    let appVersion = '';
    try { const account = wx.getAccountInfoSync(); appVersion = account && account.miniProgram && account.miniProgram.version || ''; } catch (e) {}
    const raw = await app.globalData.service.getPrefs();
    const prefs = Object.assign({}, DEFAULTS, raw || {});
    if (!['remember', 'countdown', 'stopwatch'].includes(prefs.startupMode)) prefs.startupMode = DEFAULTS.startupMode;
    if (!Number.isInteger(prefs.defaultMinutes) || prefs.defaultMinutes < 1 || prefs.defaultMinutes > 1440) prefs.defaultMinutes = 30;
    if (!Array.isArray(prefs.commonMinutes) || prefs.commonMinutes.length !== 4 || prefs.commonMinutes.some(n => !Number.isInteger(n) || n < 1 || n > 1440) || new Set(prefs.commonMinutes).size !== 4) prefs.commonMinutes = DEFAULTS.commonMinutes.slice();
    prefs.commonMinutes.sort((a, b) => a - b);
    if (!['today', 'last7', 'last30'].includes(prefs.statsPreset)) prefs.statsPreset = 'today';
    if (!SCALE_MINUTES.includes(prefs.timeSlotScaleMinutes)) prefs.timeSlotScaleMinutes = 0;
    if (!['system', 'light', 'dark'].includes(prefs.theme)) prefs.theme = 'system';
    if (!isLightTheme(prefs.lightTheme)) prefs.lightTheme = 'forest';
    if (!Number.isInteger(prefs.dailyGoalMinutes) || prefs.dailyGoalMinutes < 1 || prefs.dailyGoalMinutes > 1440) prefs.dailyGoalMinutes = 120;
    if (!Number.isInteger(prefs.shortBreakMinutes) || prefs.shortBreakMinutes < 1 || prefs.shortBreakMinutes > 60) prefs.shortBreakMinutes = 5;
    if (!Number.isInteger(prefs.longBreakMinutes) || prefs.longBreakMinutes < 1 || prefs.longBreakMinutes > 120) prefs.longBreakMinutes = 15;
    if (!Number.isInteger(prefs.longBreakEvery) || prefs.longBreakEvery < 2 || prefs.longBreakEvery > 8) prefs.longBreakEvery = 4;
    const themeClass=require('../../utils/theme').resolveTheme(prefs.theme||'system',prefs.lightTheme);
    const options = {};
    // Only pages with duration pickers need these arrays, and only on first load.
    if (['focus', 'stats'].includes(this.data.page) && !this.data.minuteOptions.length) {
      options.minuteOptions = Array.from({ length: 1440 }, (_, i) => (i + 1) + ' 分钟');
    }
    if (this.data.page === 'focus' && !this.data.shortOptions.length) {
      options.shortOptions = Array.from({ length: 60 }, (_, i) => (i + 1) + ' 分钟');
      options.longOptions = Array.from({ length: 120 }, (_, i) => (i + 1) + ' 分钟');
      options.cycleOptions = Array.from({ length: 7 }, (_, i) => (i + 2) + ' 轮');
    }
    const hasAccount = !!(app.globalData.accounts && app.globalData.accounts.getCurrent());
    const patch = Object.assign({ loading: false, prefs, appVersion, hasAccount, defaultMinuteIndex: prefs.defaultMinutes - 1, commonIndexes: prefs.commonMinutes.map(n => n - 1), slotScaleIndex:SCALE_MINUTES.indexOf(prefs.timeSlotScaleMinutes) }, require('../../utils/theme').pageThemeData(themeClass), options);
    Object.keys(patch).forEach(key => {
      if (JSON.stringify(patch[key]) === JSON.stringify(this.data[key])) delete patch[key];
    });
    if (Object.keys(patch).length) this.setData(patch);
    const tab=this.getTabBar&&this.getTabBar();if(tab)tab.setData({themeClass});
    try{wx.setNavigationBarColor(require('../../utils/theme').navigationBarOptions(themeClass));}catch(e){}
  },
  async save(patch) {
    const before = this.data.prefs;
    const request = this.saveRequest = (this.saveRequest || 0) + 1;
    this.prefKeyVersion = this.prefKeyVersion || {};
    Object.keys(patch).forEach(key => { this.prefKeyVersion[key] = request; });
    const next = Object.assign({}, before, patch);
    const derived = {};
    if (Number.isInteger(next.defaultMinutes)) derived.defaultMinuteIndex = next.defaultMinutes - 1;
    if (Array.isArray(next.commonMinutes)) derived.commonIndexes = next.commonMinutes.map(n => n - 1);
    if (SCALE_MINUTES.includes(next.timeSlotScaleMinutes)) derived.slotScaleIndex = SCALE_MINUTES.indexOf(next.timeSlotScaleMinutes);
    this.setData(Object.assign({ prefs: next }, derived));
    const env = await app.globalData.service.savePrefs(patch);
    if (!env.ok) {
      const rollback = {};
      Object.keys(patch).forEach(key => { if (this.prefKeyVersion[key] === request) rollback[key] = before[key]; });
      const restored = Object.assign({}, this.data.prefs, rollback);
      this.setData({ prefs: restored, defaultMinuteIndex: restored.defaultMinutes - 1, commonIndexes: restored.commonMinutes.map(n => n - 1), slotScaleIndex:SCALE_MINUTES.indexOf(restored.timeSlotScaleMinutes||0) });
      wx.showToast({ title: env.error.message || '保存失败，已恢复原设置', icon: 'none' });
      return false;
    }
    if(Object.prototype.hasOwnProperty.call(patch,'theme')||Object.prototype.hasOwnProperty.call(patch,'lightTheme')){const theme=require('../../utils/theme'),themeClass=theme.resolveTheme(this.data.prefs.theme,this.data.prefs.lightTheme);this.setData(theme.pageThemeData(themeClass));const tab=this.getTabBar&&this.getTabBar();if(tab)tab.setData({themeClass});try{wx.setNavigationBarColor(theme.navigationBarOptions(themeClass));}catch(e){}}
    return true;
  },
  goBack() { wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: '/pages/focus/focus' }) }); },
  noop() {},
  onRow(e) {
    const row = e.currentTarget.dataset.row;
    if (row === '隐私政策') return wx.navigateTo({ url: '/pages/privacy/privacy' });
    if (row === '数据维护') return wx.navigateTo({ url:'/pages/account/account?tools=1' });
    if (row === '项目管理') { wx.navigateTo({ url: '/pages/manage/manage' }); return; }
    if (row === '恢复默认设置') { this.resetDefaults(); return; }
    if (row === '备份本机数据') return this.exportBackup();
    if (row === '从备份恢复') return this.importBackup();
    if (row === '导出统计表') return this.exportCsv();
    if (row === '清空全部数据') return this.clearAllData();
    if (row === '复制反馈信息') return this.copyFeedback();
    if (row === '计时习惯') return this.choose('startupMode', ['记住上次', '固定倒计时', '固定正向计时'], ['remember', 'countdown', 'stopwatch']);
    if (row === '结束确认') return this.save({ confirmEnd: !this.data.prefs.confirmEnd });
    if (row === '休息安排') return this.save({ restEnabled: !this.data.prefs.restEnabled });
    if (row === '屏幕常亮') return this.save({ keepScreenOn: !this.data.prefs.keepScreenOn });
    if (row === '外观主题') return this.choose('theme', ['跟随系统', '浅色', '深色'], ['system', 'light', 'dark']);
    if (row === '统计默认范围') return this.choose('statsPreset', ['今日', '近 7 天', '近 30 天'], ['today', 'last7', 'last30']);
    if (row === '显示今日目标') return this.save({ dailyGoalEnabled: !this.data.prefs.dailyGoalEnabled });
    if (row === '每周起始日') return this.choose('weekStartsSunday', ['周一', '周日'], [false, true]);
    if (row === '使用帮助') return wx.navigateTo({ url: '/pages/guide/guide' });
    if (row === '关于 Foclo') return wx.showModal({ title: 'Foclo', content: '专注计时与学习统计工具\n版本：' + (this.data.appVersion || '以当前构建为准') + '\n项目和专注记录先保存在本机；登录后自动同步到当前账号，方便换设备继续使用。头像与昵称可选，仅用于本机展示。', showCancel: false });
  },
  selectTheme(e) {
    const theme = e.currentTarget.dataset.theme;
    if (['system', 'light', 'dark'].includes(theme) && theme !== this.data.prefs.theme) this.save({ theme });
  },
  selectLightTheme(e) {
    const lightTheme=e.currentTarget.dataset.lightTheme;
    if(isLightTheme(lightTheme)&&lightTheme!==this.data.prefs.lightTheme)return this.save({lightTheme});
  },
  choose(key, labels, values) {
    wx.showActionSheet({ itemList: labels, success: async r => { await this.save({ [key]: values[r.tapIndex] }); } });
  },
  selectDefaultMinutes(e) { const n = Number(e.detail.value) + 1; this.save({ defaultMinutes: n }); },
  selectGoalMinutes(e) { this.save({ dailyGoalMinutes: Number(e.detail.value) + 1 }); },
  selectSlotScale(e) { const minutes=SCALE_MINUTES[Number(e.detail.value)];if(minutes!==undefined)this.save({ timeSlotScaleMinutes:minutes }); },
  selectCommonMinutes(e) {
    const index = Number(e.currentTarget.dataset.index), next = this.data.prefs.commonMinutes.slice();
    next[index] = Number(e.detail.value) + 1;
    if (new Set(next).size !== 4) { this.setData({ commonIndexes:this.data.prefs.commonMinutes.map(n=>n-1) });wx.showToast({ title: '常用时长不能重复', icon: 'none' }); return; }
    this.save({ commonMinutes: next.sort((a,b)=>a-b) });
  },
  selectBreak(e) {
    const key = e.currentTarget.dataset.key, value = Number(e.detail.value) + Number(e.currentTarget.dataset.offset || 1);
    this.save({ [key]: value });
  },
  toggleMoreData() { this.setData({ moreDataOpen: !this.data.moreDataOpen }); },
  getFileName(prefix, extension) { const d=new Date();return prefix+'-'+d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+'-'+Date.now()+'.'+extension; },
  async writeAndShareFile(name, content, doneTitle) {
    if (!wx.env || !wx.env.USER_DATA_PATH || !wx.getFileSystemManager)
      throw new Error('当前微信环境无法生成备份文件，请在手机微信中使用');
    const path=wx.env.USER_DATA_PATH+'/'+name,fs=wx.getFileSystemManager();
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('生成文件超时，请重试')),10000);
      try { fs.writeFile({filePath:path,data:content,encoding:'utf8',
        success:()=>{clearTimeout(timer);resolve();},
        fail:()=>{clearTimeout(timer);reject(new Error('文件生成失败，请检查手机剩余空间'));}
      }); } catch(error) {clearTimeout(timer);reject(error);}
    });
    wx.hideLoading();
    const send=await new Promise((resolve,reject)=>wx.showModal({
      title:'文件已生成',content:'请将文件发送到微信聊天（例如文件传输助手）并保存。只生成文件还不算完成备份。',
      confirmText:'发送文件',cancelText:'稍后发送',success:r=>resolve(r.confirm),fail:reject
    }));
    if (!send) return;
    if(typeof wx.shareFileMessage!=='function') {
      wx.showModal({title:'暂时无法发送',content:'当前环境不支持文件分享，请在手机微信中打开小程序并更新微信后重试。',showCancel:false});return;
    }
    await new Promise(resolve=>wx.shareFileMessage({filePath:path,fileName:name,
      success:()=>{wx.showToast({title:doneTitle,icon:'success'});resolve();},
      fail:error=>{wx.showModal({title:'文件尚未发送',content:/cancel/i.test(error.errMsg||'')?'你取消了发送，可以重新点击保存备份。':'微信未能发送文件，请稍后重试。原记录没有变化。',showCancel:false});resolve();}
    }));
  },
  async exportBackup() {
    if(this.fileBusy)return;this.fileBusy=true;wx.showLoading({title:'正在整理本机数据'});
    try {
      const env=await app.globalData.service.createBackup();if(!env.ok){wx.hideLoading();wx.showToast({title:env.error.message,icon:'none'});return;}
      const backup=env.data,content=JSON.stringify(backup),size=unescape(encodeURIComponent(content)).length;
      if(size>10*1024*1024){wx.hideLoading();wx.showToast({title:'备份超过 10 MB，暂不支持导出',icon:'none'});return;}
      const name=this.getFileName('Foclo-data','json');
      wx.hideLoading();
      await this.writeAndShareFile(name, content, '备份文件已发送');
    } catch(e) { wx.hideLoading();wx.showModal({title:'备份尚未完成',content:e.message||'备份失败，请稍后重试',showCancel:false}); }
    finally { this.fileBusy=false; }
  },
  importBackup() {
    if(this.fileBusy)return;
    if(require('../../utils/rest-break').read()){wx.showToast({title:'休息计时进行中，请先结束休息',icon:'none'});return;}
    if(typeof wx.chooseMessageFile!=='function'||typeof wx.getFileSystemManager!=='function'){wx.showToast({title:'当前微信版本不支持选择或读取备份文件',icon:'none'});return;}
    wx.chooseMessageFile({count:1,type:'file',success:r=>{
      const file=r.tempFiles&&r.tempFiles[0];if(!file)return;
      if(file.size>10*1024*1024){wx.showToast({title:'备份超过 10 MB，暂不支持导入',icon:'none'});return;}
      wx.getFileSystemManager().readFile({filePath:file.path,encoding:'utf8',success:async read=>{
        let backup;try{backup=JSON.parse(read.data);}catch(e){wx.showToast({title:'文件不是有效的 Foclo 备份',icon:'none'});return;}
        this.fileBusy=true;wx.showLoading({title:'正在校验备份'});
        const preview=await app.globalData.service.previewBackup(backup);wx.hideLoading();
        if(!preview.ok){this.fileBusy=false;wx.showModal({title:'无法恢复备份',content:preview.error.message,showCancel:false});return;}
        const d=preview.data;
        try{const info=wx.getStorageInfoSync();if(info&&Number.isFinite(info.limitSize)&&Number.isFinite(info.currentSize)&&(info.limitSize-info.currentSize)*1024<d.estimatedWriteBytes){this.fileBusy=false;wx.showModal({title:'本机空间不足',content:'预计需要约 '+Math.ceil(d.estimatedWriteBytes/1024)+' KB 的本机空间，请先清理空间后重试。原数据未修改。',showCancel:false});return;}}catch(e){}
        const destination = app.globalData.accounts && app.globalData.accounts.getCurrent() ? '当前微信账号；新增内容会自动上传到账号' : '这台设备的游客记录；不会自动上传';
        wx.showModal({title:'找回备份记录？',content:`保存位置：${destination}。将新增 ${d.importedProjects} 个项目、${d.importedSessions} 条专注记录；跳过 ${d.skippedProjects} 个相同项目、${d.skippedSessions} 条相同记录。备份中的设置也会恢复，已删除的记录可能重新出现。`,confirmText:'确认恢复',success:async confirm=>{
          if(!confirm.confirm){this.fileBusy=false;return;}
          wx.showLoading({title:'正在合并数据'});
          const result=await app.globalData.service.importBackup({operationId:uuid(),backup});wx.hideLoading();this.fileBusy=false;
          if(!result.ok){wx.showModal({title:'恢复失败',content:result.error.message,showCancel:false});return;}
          wx.showModal({title:'恢复完成',content:`新增 ${result.data.importedProjects} 个项目、${result.data.importedSessions} 条专注记录。`,showCancel:false,complete:()=>{this.loadPrefs();}});
        }});
      },fail:()=>wx.showToast({title:'无法读取所选文件',icon:'none'})});
    },fail:()=>{}});
  },
  async exportCsv() {
    if(this.fileBusy)return;this.fileBusy=true;wx.showLoading({title:'正在生成统计表'});
    try {
      const env=await app.globalData.service.createBackup();if(!env.ok){wx.hideLoading();wx.showToast({title:env.error.message,icon:'none'});return;}
      const backup=env.data,stack=getCurrentPages(),statsPage=stack.find(p=>p.route==='pages/stats/stats'),shell=stack.find(p=>p.route==='pages/focus/focus'&&p.isShell),stats=statsPage||(shell&&shell.selectComponent('#statsPanel')),currentRange=stats?stats.data.preset:'today';
      wx.hideLoading();
      wx.showActionSheet({itemList:['全部专注记录','当前统计范围'],success:choice=>{
        const now=Date.now()/1000;let start=null,end=null,scope='all';
        if(choice.tapIndex===1){scope=currentRange;const todayStart=Math.floor((now+8*3600)/86400)*86400-8*3600;if(currentRange==='custom'&&stats&&stats.data.startDate&&stats.data.endDate){const a=stats.data.startDate.split('-').map(Number),b=stats.data.endDate.split('-').map(Number);start=Date.UTC(a[0],a[1]-1,a[2])/1000-8*3600;end=Date.UTC(b[0],b[1]-1,b[2]+1)/1000-8*3600;}else{const days=currentRange==='last7'?7:currentRange==='last30'?30:1;start=todayStart-(days-1)*86400;end=todayStart+86400;}}
      const projects={};backup.projects.forEach(p=>projects[p.id]=p);
      function pathOf(id){const names=[],seen={};let p=projects[id];while(p&&!seen[p.id]){seen[p.id]=true;names.unshift(p.name);p=p.parentId?projects[p.parentId]:null;}return names.join(' / ');}
      function stamp(sec){if(!sec)return '';return new Date((sec+8*3600)*1000).toISOString().slice(0,19).replace('T',' ');}
      const rows=backup.sessions.filter(s=>scope==='all'||((s.endedAtSec||now)>=start&&s.startedAtSec<end)).map(s=>{
        const pause=(s.pauses||[]).reduce((n,p)=>n+(p.durationSeconds|| (p.status==='ACTIVE'?Math.max(0,now-p.startedAtSec):0)),0);
        return [pathOf(s.projectId),stamp(s.startedAtSec),stamp(s.endedAtSec),s.durationSeconds==null?'':s.durationSeconds,pause,s.status==='COMPLETED'?'已结束':'进行中'];
      });
      const esc=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
      const csv='统计表，不能用于恢复\r\n'+['项目','开始时间（UTC+8）','结束时间（UTC+8）','净专注秒数','暂停秒数','状态'].map(esc).join(',')+'\r\n'+rows.map(row=>row.map(esc).join(',')).join('\r\n');
      const name=this.getFileName('Foclo-statistics-'+scope,'csv');this.writeAndShareFile(name,'\ufeff'+csv,'统计表已交付');
      },fail:()=>{}});
    } catch(e) {wx.hideLoading();wx.showToast({title:e.message||'统计表生成失败',icon:'none'});}
    finally {this.fileBusy=false;}
  },
  async clearAllData() {
    if(this.fileBusy)return;
    if(app.globalData.accounts && app.globalData.accounts.getCurrent()) {
      wx.navigateTo({ url:'/pages/account/account?tools=1' });
      return;
    }
    if(require('../../utils/rest-break').read()){wx.showToast({title:'休息计时进行中，不能清空数据',icon:'none'});return;}
    const backup=await app.globalData.service.createBackup();if(!backup.ok){wx.showToast({title:backup.error.message,icon:'none'});return;}
    const d=backup.data;
    wx.showModal({title:'清空当前记录？',content:`将删除当前使用的 ${d.projects.length} 个项目和 ${d.sessions.length} 条专注记录，并清除设置。此操作无法撤销。建议先使用“保存一份备份”。`,confirmText:'继续',confirmColor:THEME_COLORS.light.dangerText,success:first=>{
      if(!first.confirm)return;
      wx.showModal({title:'最后确认',content:'确认永久清空当前使用的项目、记录与设置？',confirmText:'永久清空',confirmColor:THEME_COLORS.light.dangerText,success:async second=>{
        if(!second.confirm)return;
        const current=app.globalData.service.peekCurrent();if(current.ok&&current.data.state!=='IDLE'){wx.showToast({title:'专注进行中，不能清空',icon:'none'});return;}
        const env=await app.globalData.service.clearAllData({operationId:uuid()});if(!env.ok){wx.showToast({title:env.error.message,icon:'none'});return;}
        await this.loadPrefs();wx.showToast({title:'本机数据已清空',icon:'success'});
      }});
    }});
  },
  copyFeedback() {
    let info={};try{info=wx.getSystemInfoSync()||{};}catch(e){}
    wx.showModal({title:'复制反馈信息',editable:true,placeholderText:'请描述遇到的问题（选填）',content:'默认不包含项目名称和专注记录',success:r=>{
      if(!r.confirm)return;
      const report=`Foclo ${this.data.appVersion||'版本未知'}\n设备：${info.brand||''} ${info.model||''}\n系统：${info.system||''}\n问题描述：${String(r.content||'未填写')}`;
      wx.setClipboardData({data:report,success:()=>wx.showToast({title:'反馈信息已复制',icon:'success'})});
    }});
  },
  resetDefaults() {
    wx.showModal({ title: '恢复默认设置？', content: '将恢复计时、屏幕和统计范围等设置。项目、专注记录与正在进行的专注不会改变。', confirmText: '恢复默认', success: async r => {
      if (!r.confirm) return;
      const ok = await this.save(Object.assign({}, DEFAULTS));
      if (ok) wx.showToast({ title: '已恢复默认设置', icon: 'none' });
    } });
  }
});
