// Shared by the normal page and its isolated guide demonstration.
module.exports = function createPage(app, runtime) {
  runtime = runtime || {};
  const navigation = runtime.platform || {
    navigateTo: options => wx.navigateTo(options),
    redirectTo: options => wx.redirectTo(options),
    reLaunch: options => wx.reLaunch(options)
  };
const view = (runtime.view || require('../../utils/view-data'));
const format = require('../../utils/format');
const time = require('../../core/time');
const { buildTimeSlotChart, SCALE_MINUTES, SCALE_LABELS } = require('../../utils/time-slot-chart');
const { colorOf } = require('../../utils/color');

const definition = {
  data: {
    heatmapOpen:false,
    projectId:'',name:'项目',projectColor:'#425B42',pathText:'',preset:'last30',mode:'realtime',
    rangeItems:view.RANGE_ITEMS,startDate:view.today(),endDate:view.today(),rangeLabel:'近30天',
    scopeOpen:false,chartObscured:false,subjectOptions:[],rangeOpen:false,filterTop:78,loading:false,error:'',
    listRows:[],distRows:[],chartGroups:[],chartTree:[],showDistributionChart:false,chartFull:false,chartExpandable:false,chartAllExpanded:false,dailySeries:[],
    selectedProjectId:'',
    timeSlots:[],slotScaleText:'1小时',slotScaleFixed:0,slotScaleIndex:0,slotScaleOptions:SCALE_LABELS,selectedTimeSlot:-1,selectedSlot:null,
    selectedDate:'',rangeStart:'',rangeEnd:''
  },
  onLoad(q){
    this.seq=0;
    this.setData({projectId:q.id||'',preset:q.preset||'last30',mode:q.mode==='completed'?'completed':'realtime',startDate:q.startDate||view.today(),endDate:q.endDate||view.today()});
  },
  onShow(){require('../../utils/theme').applyPageTheme(this);return this.load();},
  onUnload(){this.seq++;},
  onNavHeightChange(e){this.setData({filterTop:e.detail.height});},
  async load(){
    const token=++this.seq;
    this.setData({loading:true,error:''});
    await app.globalData.readyPromise;
    const response=await app.globalData.service.getStatistics(Object.assign(view.rangeSpec(this.data),{projectId:this.data.projectId}));
    if(token!==this.seq)return;
    if(!response.ok){this.setData({loading:false,error:response.error.message});return;}
    const d=response.data;
    const byId={};
    (d.projects||[]).forEach(item=>{byId[item.projectId]=item;});
    const chart=view.scopedChartDistribution(d,this.data.projectId),rows=chart.segments;
    this.statsData=d;
    this.chartById=byId;
    const structure=view.subjectList(d,this.data.projectId).filter(item=>item.projectId!==this.data.projectId).map(item=>Object.assign({},item,{depth:Math.max(0,item.depth-1),indent:Math.max(0,item.depth-1)*36}));
    const selectedProjectId=require('../../utils/project-list-link').contains(chart.tree,this.data.selectedProjectId)?this.data.selectedProjectId:'';
    const prefs=await app.globalData.service.getPrefs();if(token!==this.seq)return;
    const slotChart=buildTimeSlotChart(d.averageTimeSlots,prefs&&prefs.timeSlotScaleMinutes);
    const timeSlots=slotChart.slots;
    const rangeStart=time.dayKey(d.range.start),rangeEnd=time.dayKey(d.range.end-1);
    const lastDate=rangeEnd>view.today()?view.today():rangeEnd;
    this.setData(Object.assign(view.summary(d),{
      avgSessionText:d.sessionCount>0?format.durationText(d.totalSeconds/d.sessionCount):'0秒',
      loading:false,name:d.name,projectColor:(byId[this.data.projectId]&&byId[this.data.projectId].color)||colorOf(this.data.projectId),pathText:d.pathText.split(' / ').join(' › '),
      chartGroups:chart.groups,chartTree:chart.tree,distRows:rows,showDistributionChart:view.hasRecordedChildGroups(chart.groups),
      subjectOptions:view.subjectOptions(d),listRows:structure,
      dailySeries:d.dailySeries,timeSlots,slotScaleText:slotChart.scaleText,slotScaleFixed:slotChart.fixed,slotScaleIndex:slotChart.scaleIndex,
      selectedSlot:timeSlots[this.data.selectedTimeSlot]||null,selectedProjectId,
      rangeLabel:this.data.preset==='custom'?this.data.startDate+'–'+this.data.endDate:(view.RANGE_ITEMS.find(item=>item.key===this.data.preset)||{}).label||'自定义',
      rangeStart,rangeEnd:lastDate,selectedDate:this.data.selectedDate>=rangeStart&&this.data.selectedDate<=lastDate?this.data.selectedDate:lastDate
    }));
  },
  onChartSelectParent(e){this.applyChartSelection(e.detail);},
  onChartSelectChild(e){this.applyChartSelection(e.detail);},
  applyChartSelection(detail){
    require('../../utils/project-list-link').selectFromChart(this,detail);
  },
  onListFocusChange(e){require('../../utils/project-list-link').revealFocus(this,e.detail);},
  clearProjectFocus(){require('../../utils/project-list-link').clearFocus(this);},
  selectTimeSlot(e){const index=Number(e.currentTarget.dataset.index);this.setData({selectedTimeSlot:index,selectedSlot:this.data.timeSlots[index]||null});},
  async selectSlotScale(e){const minutes=SCALE_MINUTES[Number(e.detail.value)];if(minutes===undefined)return;const saved=await app.globalData.service.savePrefs({timeSlotScaleMinutes:minutes});if(!saved.ok){wx.showToast({title:saved.error.message,icon:'none'});return;}this.load();},
  openSubjects(){if(this.openingSubjectPicker||this.openingHeatmap||this.data.heatmapOpen||this.data.chartObscured)return;this.openingSubjectPicker=true;const open=()=>{this.pageOverlayKind='subjects';this.setData({scopeOpen:true,chartObscured:!!this.selectComponent('#distributionChart')});};const chart=this.selectComponent('#distributionChart');if(chart)chart.captureSnapshot(ready=>{if(ready)open();else{this.openingSubjectPicker=false;wx.showToast({title:'圆环正在准备，请再试一次',icon:'none'});}});else open();},
  closeSubjects(){this.setData({scopeOpen:false});},
  onSubjectsAfterClose(){this.setData({chartObscured:false},()=>{this.openingSubjectPicker=false;});},
  onOverlayBeforeLeave(){this.overlayLeaving=this.pageOverlayKind;if(this.overlayLeaving==='subjects'){const picker=this.selectComponent('#subjectPicker');if(picker&&picker.onBeforeLeave)picker.onBeforeLeave();}},
  onOverlayAfterLeave(){const kind=this.overlayLeaving||this.pageOverlayKind;this.overlayLeaving='';this.pageOverlayKind='';if(kind==='subjects'){if(this.data.scopeOpen)this.setData({scopeOpen:false});const picker=this.selectComponent('#subjectPicker');if(picker&&picker.onAfterLeave)picker.onAfterLeave();}else if(kind==='heatmap')require('../../utils/heatmap-modal').afterHeatmapLeave.call(this);},
  onOverlayClick(){if(this.pageOverlayKind==='subjects'){const picker=this.selectComponent('#subjectPicker');if(picker&&picker.close)picker.close();else this.closeSubjects();}},
  chooseSubject(e){
    if(e.detail.projectId){this.drill(e);return;}
    this.closeSubjects();
    const pages=getCurrentPages(),index=pages.findIndex(page=>page.route==='pages/stats/stats'||(page.route==='pages/focus/focus'&&page.isShell&&page.data.activeTab===1));
    if(index>=0&&index<pages.length-1){app.globalData.closeStatsPickerOnReturn=!!pages[index].isShell;wx.navigateBack({delta:pages.length-1-index});}
    else navigation.reLaunch({url:'/pages/stats/stats'});
  },
  refresh(){return this.load();},
  onRangeChange(e){if(e.detail.key==='custom'){this.openRange();return;}this.resetChartSelection();this.setData({preset:e.detail.key,selectedTimeSlot:-1,selectedSlot:null});this.load();},
  openRange(){this.setData({rangeOpen:true});},
  closeRange(){this.setData({rangeOpen:false});},
  confirmRange(e){this.resetChartSelection();this.setData({preset:'custom',startDate:e.detail.startDate,endDate:e.detail.endDate,rangeOpen:false,selectedTimeSlot:-1,selectedSlot:null});this.load();},
  resetChartSelection(){const chart=this.selectComponent('#distributionChart');if(chart)chart.resetView();this.setData({selectedProjectId:''});},
  selectDay(e){navigation.navigateTo({url:'/pages/day-stats/day-stats?date='+e.detail.date+'&scope='+encodeURIComponent(this.data.projectId)});},
  back(){wx.navigateBack({fail:()=>navigation.reLaunch({url:'/pages/stats/stats'})});},
  drill(e){
    const id=(e.detail&&e.detail.projectId)||(e.currentTarget&&e.currentTarget.dataset.id);
    if(!id||id===this.data.projectId)return;
    let url='/pages/project-stats/project-stats?id='+encodeURIComponent(id)+'&preset='+this.data.preset+'&mode='+this.data.mode;
    if(this.data.preset==='custom')url+='&startDate='+this.data.startDate+'&endDate='+this.data.endDate;
    navigation.navigateTo({url});
  },
  goHeatmap(){require('../../utils/heatmap-modal').openHeatmap.call(this);},
  closeHeatmap(){require('../../utils/heatmap-modal').closeHeatmap.call(this);},
  goHierarchy(){const chart=this.selectComponent('#distributionChart');if(chart)chart.openFullView();},
  toggleChartAll(){const chart=this.selectComponent('#distributionChart');if(chart)chart.toggleAll();},
  onChartExpandState(e){this.setData({chartExpandable:!!e.detail.expandable,chartAllExpanded:!!e.detail.allExpanded});},
  onChartFullChange(e){this.setData({chartFull:!!e.detail.open});},
  async exportReport(){const e=await app.globalData.service.getStatistics({projectId:this.data.projectId,preset:'last7',mode:this.data.mode});if(!e.ok){wx.showToast({title:e.error.message,icon:'none'});return;}const d=e.data;const text=[d.pathText+' · 近7天专注复盘',time.dayKey(d.range.start)+' 至 '+time.dayKey(d.range.end-1),'累计：'+format.durationText(d.totalSeconds),'本项目记录：'+format.durationText(d.selfSeconds),'所含项目记录：'+format.durationText(d.totalSeconds-d.selfSeconds),'专注次数：'+d.sessionCount,'暂停次数：'+d.pauseCount,'日均：'+format.durationText(d.averageSeconds),'每日时长：'].concat(d.dailySeries.map(r=>r.date+' '+format.durationText(r.seconds))).join('\n');wx.showActionSheet({itemList:['查看并复制报告','导出文本文件'],success:r=>{if(r.tapIndex===0){wx.showModal({title:'本周复盘',content:text,confirmText:'复制报告',success:res=>{if(res.confirm)wx.setClipboardData({data:text});}});return;}if(!wx.shareFileMessage){wx.setClipboardData({data:text});wx.showToast({title:'当前环境已复制报告文本',icon:'none'});return;}const filePath=wx.env.USER_DATA_PATH+'/focus-review-'+Date.now()+'.txt';wx.getFileSystemManager().writeFile({filePath,data:text,encoding:'utf8',success:()=>wx.shareFileMessage({filePath,fileName:d.name+'-近7天专注复盘.txt',fail:()=>wx.showToast({title:'分享未完成，可改用复制报告',icon:'none'})}),fail:()=>wx.showToast({title:'文件导出失败，请改用复制',icon:'none'})});}});}
};

  definition.data.demoSession = '';
  const load = definition.onLoad;
  definition.onLoad = function(options) {
    this.runtimeApp = app;
    if (load) return load.call(this, options || {});
  };
  return require('../../utils/window-layout').withLandscapeLayout(definition);
};
