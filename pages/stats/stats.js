const view = require('../../utils/view-data');
const time = require('../../core/time');
const { buildTimeSlotChart, SCALE_MINUTES, SCALE_LABELS } = require('../../utils/time-slot-chart');
const { createRace } = require('../../utils/race');
const { buildDashboard, selectedDetail, detailExpansion } = require('../../utils/stats-dashboard');
const format = require('../../utils/format');

Page({
  data: {
    heatmapOpen:false,
    rangeItems:view.RANGE_ITEMS,modeItems:view.MODE_ITEMS,preset:'last30',mode:'realtime',
    startDate:'',endDate:'',rangeText:'',rangeLabel:'近30天',distRows:[],chartGroups:[],chartTree:[],chartFull:false,chartExpandable:false,chartAllExpanded:false,
    stackSegs:[],dailySeries:[],sumH:0,sumM:0,sumS:0,sumZero:true,shortTotal:'—',
    totalText:'0秒',countText:'',avgText:'',selectedDate:'',rangeStart:'',rangeEnd:'',
    dailyGoalEnabled:false,dailyGoalMinutes:120,dailyGoalText:'',dailyGoalPercent:0,
    scopeOpen:false,chartObscured:false,subjectOptions:[],rangeOpen:false,loading:true,error:'',openingPage:'',filterTop:78,
    selectedProjectId:'',selectedDetail:null,expandedDetailChildIds:[],timeSlots:[],slotScaleText:'1小时',slotScaleFixed:0,slotScaleIndex:0,slotScaleOptions:SCALE_LABELS,selectedTimeSlot:-1,selectedSlot:null,
    avgSessionText:'0秒',goalPercentText:'0'
  },
  onLoad(){
    this.race=createRace();this.dashboard=buildDashboard([],[]);
    this.setData({startDate:view.today(),endDate:view.today()});
    if(getCurrentPages().length===1){
      this.redirectingToFocus=true;
      wx.reLaunch({url:'/pages/focus/focus',success:()=>setTimeout(()=>wx.navigateTo({url:'/pages/stats/stats'}),0)});
    }
  },
  onNavHeightChange(e){this.setData({filterTop:e.detail.height});},
  async onShow(){
    if(this.redirectingToFocus)return;
    require('../../utils/theme').applyPageTheme(this);
    const returningFromSubpage=!!this.data.openingPage||!!this.returningFromDay;
    this.returningFromDay=false;
    this.setData({openingPage:''});
    await getApp().globalData.readyPromise;
    if(!returningFromSubpage){
      const prefs=await getApp().globalData.service.getPrefs();
      const preset=prefs&&['today','last7','last30'].includes(prefs.statsPreset)?prefs.statsPreset:'today';
      if(this.data.preset!==preset)this.resetChartSelection();
      this.setData({preset,selectedDate:'',selectedTimeSlot:-1,selectedSlot:null});
    }
    this.load();
  },
  onRangeChange(e){if(e.detail.key==='custom'){this.openRange();return;}this.resetChartSelection();this.setData({preset:e.detail.key,selectedDate:'',selectedTimeSlot:-1,selectedSlot:null});this.load();},
  openRange(){this.setData({rangeOpen:true});},closeRange(){this.setData({rangeOpen:false});},
  confirmRange(e){this.resetChartSelection();this.setData({preset:'custom',startDate:e.detail.startDate,endDate:e.detail.endDate,rangeOpen:false,selectedDate:'',selectedTimeSlot:-1,selectedSlot:null});this.load();},
  resetChartSelection(){const chart=this.selectComponent('#distributionChart');if(chart)chart.resetView();this.setData({selectedProjectId:'',selectedDetail:null,expandedDetailChildIds:[]});},


  async load(){
    const token=this.race.next();await getApp().globalData.readyPromise;
    if(!this.race.isCurrent(token))return;
    this.setData({loading:true,error:''});
    const env=await getApp().globalData.service.getStatistics(view.rangeSpec(this.data));
    if(!this.race.isCurrent(token))return;
    if(!env.ok){this.setData({loading:false,error:env.error.message});return;}
    const service=getApp().globalData.service,prefs=await service.getPrefs();
    let goalSeconds=0;
    if(prefs&&prefs.dailyGoalEnabled){const today=await service.getStatistics({preset:'today',mode:'realtime'});if(today.ok)goalSeconds=today.data.totalSeconds;}
    if(!this.race.isCurrent(token))return;
    const d=env.data,chart=view.chartDistribution(d),distRows=chart.segments;
    const dashboard=buildDashboard(chart.groups,distRows,chart.tree);
    this.dashboard=dashboard;
    const selected=selectedDetail(dashboard,this.data.selectedProjectId);
    const selectedProjectId=require('../../utils/project-list-link').contains(chart.tree,this.data.selectedProjectId)?this.data.selectedProjectId:'';
    const expansion=detailExpansion(selected,this.data.expandedDetailChildIds);
    const slotChart=buildTimeSlotChart(d.averageTimeSlots,prefs&&prefs.timeSlotScaleMinutes);
    const timeSlots=slotChart.slots;
    let avgSessionText='0秒',goalPercentText='0';
    if(this.data.preset==='today'){
      avgSessionText=d.sessionCount>0?format.durationText(d.totalSeconds/d.sessionCount):'0秒';
      goalPercentText=String(Math.round(prefs&&prefs.dailyGoalEnabled?Math.min(100,goalSeconds/((prefs.dailyGoalMinutes||120)*60)*100):0));
    }
    const start=time.dayKey(d.range.start),end=time.dayKey(d.range.end-1);
    this.setData(Object.assign(view.summary(d),{
      loading:false,chartGroups:chart.groups,chartTree:chart.tree,subjectOptions:view.subjectOptions(d),distRows,
      avgSessionText,goalPercentText,
      dailyGoalEnabled:!!(prefs&&prefs.dailyGoalEnabled),dailyGoalMinutes:prefs&&prefs.dailyGoalMinutes||120,dailyGoalPercent:prefs&&prefs.dailyGoalEnabled?Math.round(Math.min(100,goalSeconds/((prefs.dailyGoalMinutes||120)*60)*100)):0,dailyGoalText:require('../../utils/format').durationText(goalSeconds),
      stackSegs:chart.groups.filter(r=>r.seconds>0).map(r=>Object.assign({},r,{width:d.totalSeconds?r.seconds/d.totalSeconds*100:0})),dailySeries:d.dailySeries,
      timeSlots,slotScaleText:slotChart.scaleText,slotScaleFixed:slotChart.fixed,slotScaleIndex:slotChart.scaleIndex,selectedSlot:timeSlots[this.data.selectedTimeSlot]||null,
      selectedProjectId,selectedDetail:expansion.detail,expandedDetailChildIds:expansion.ids,
      rangeLabel:this.data.preset==='custom'?this.data.startDate+'–'+this.data.endDate:view.RANGE_ITEMS.find(r=>r.key===this.data.preset).label,
      rangeStart:start,rangeEnd:end>view.today()?view.today():end,
      selectedDate:this.data.selectedDate>=start&&this.data.selectedDate<=end?this.data.selectedDate:(end>view.today()?view.today():end)
    }));
  },
  onChartSelectParent(e){this.applyChartSelection(e.detail);},
  showAllProjects(){require('../../utils/show-all-projects')(this);},
  onChartExpandState(e){const {expandable,allExpanded}=e.detail,nextExpandable=!!expandable,nextExpanded=!!allExpanded;if(this.data.chartExpandable!==nextExpandable||this.data.chartAllExpanded!==nextExpanded)this.setData({chartExpandable:nextExpandable,chartAllExpanded:nextExpanded});},
  toggleChartAll(){const chart=this.selectComponent('#distributionChart');if(chart)chart.toggleAll();},
  onChartSelectChild(e){this.applyChartSelection(e.detail);},
  applyChartSelection(detail){
    require('../../utils/project-list-link').selectFromChart(this,detail);
  },
  onListFocusChange(e){require('../../utils/project-list-link').revealFocus(this,e.detail);},
  clearProjectFocus(){require('../../utils/project-list-link').clearFocus(this);},
  toggleDetailChild(e){
    const id=(e.detail&&e.detail.id)||e.currentTarget.dataset.id,detail=this.data.selectedDetail;
    const child=detail && (detail.type==='parent'?detail.children.find(item=>item.id===id):detail.id===id?detail:null);
    if(!child || !child.grandchildren.length)return;
    const ids=this.data.expandedDetailChildIds;
    const expansion=detailExpansion(detail,ids.indexOf(id)>=0?ids.filter(item=>item!==id):ids.concat(id));
    this.setData({selectedDetail:expansion.detail,expandedDetailChildIds:expansion.ids});
  },
  selectTimeSlot(e){const index=Number(e.currentTarget.dataset.index);this.setData({selectedTimeSlot:index,selectedSlot:this.data.timeSlots[index]||null});},
  async selectSlotScale(e){const minutes=SCALE_MINUTES[Number(e.detail.value)];if(minutes===undefined)return;const saved=await getApp().globalData.service.savePrefs({timeSlotScaleMinutes:minutes});if(!saved.ok){wx.showToast({title:saved.error.message,icon:'none'});return;}this.load();},
  openSubjects(){if(this.openingSubjectPicker||this.data.chartObscured)return;this.openingSubjectPicker=true;const open=()=>this.setData({scopeOpen:true,chartObscured:!!this.selectComponent('#distributionChart')});const chart=this.selectComponent('#distributionChart');if(chart)chart.captureSnapshot(ready=>{if(ready)open();else{this.openingSubjectPicker=false;wx.showToast({title:'圆环正在准备，请再试一次',icon:'none'});}});else open();},
  closeSubjects(){this.setData({scopeOpen:false});},
  onSubjectsAfterClose(){this.setData({chartObscured:false},()=>{this.openingSubjectPicker=false;});},
  chooseSubject(e){if(e.detail.projectId)this.goProject(e);else this.closeSubjects();},
  selectDay(e){this.returningFromDay=true;wx.navigateTo({url:'/pages/day-stats/day-stats?date='+e.detail.date,fail:()=>{this.returningFromDay=false;}});},
  goFocus(){
    const pages=getCurrentPages(),index=pages.findIndex(page=>page.route==='pages/focus/focus');
    if(index>=0&&index<pages.length-1)wx.navigateBack({delta:pages.length-1-index});
    else wx.reLaunch({url:'/pages/focus/focus'});
  },refresh(){return this.load();},
  goProject(e){const id=(e.detail&&e.detail.projectId)||e.currentTarget.dataset.id;if(!id)return;let url='/pages/project-stats/project-stats?id='+encodeURIComponent(id)+'&mode='+this.data.mode+'&preset='+this.data.preset;if(this.data.preset==='custom')url+='&startDate='+this.data.startDate+'&endDate='+this.data.endDate;this.openSubpage('project',url);},
  goHeatmap(){require('../../utils/heatmap-modal').openHeatmap.call(this);},
  closeHeatmap(){require('../../utils/heatmap-modal').closeHeatmap.call(this);},
  goManage(){this.openSubpage('manage','/pages/manage/manage');},
  goHierarchy(){const chart=this.selectComponent('#distributionChart');if(chart)chart.openFullView();},
  onChartFullChange(e){this.setData({chartFull:!!e.detail.open});},
  openSubpage(name,url){if(this.data.openingPage)return;this.setData({openingPage:name});wx.navigateTo({url,fail:e=>{this.setData({openingPage:''});wx.showToast({title:e.errMsg,icon:'none'});}});}
});
