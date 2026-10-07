const view=require('../../utils/view-data'),time=require('../../core/time'),format=require('../../utils/format');
const {buildDashboard,selectedDetail,detailExpansion}=require('../../utils/stats-dashboard');
function durationParts(seconds){const text=format.durationText(seconds),parts=[],pattern=/(\d+)(小时|分钟|秒)/g;let match;while((match=pattern.exec(text)))parts.push({value:match[1],unit:match[2]});return parts;}
Page({
  data:{date:'',dateTitle:'',scope:'',scopeName:'全部项目',scopeShortName:'',singleExpand:false,rows:[],chartGroups:[],chartTree:[],showDistributionChart:false,chartFull:false,chartExpandable:false,chartAllExpanded:false,totalText:'0秒',totalParts:[{value:'0',unit:'秒'}],stackSegs:[],shortTotal:'—',countText:'',error:'',today:view.today(),selectedProjectId:'',selectedDetail:null,expandedDetailChildIds:[],avgSessionText:'0秒'},
  onLoad(q){this.seq=0;this.dashboard=buildDashboard([],[]);this.setData({date:q.date||view.today(),scope:q.scope||''});},
  onShow(){require('../../utils/theme').applyPageTheme(this);this.load();},
  onUnload(){this.seq++;},
  async load(){
    const seq=++this.seq;await getApp().globalData.readyPromise;
    const args={startDate:this.data.date,endDate:this.data.date,mode:'realtime'};if(this.data.scope)args.projectId=this.data.scope;
    const env=await getApp().globalData.service.getStatistics(args);if(seq!==this.seq)return;
    if(!env.ok){this.setData({error:env.error.message});return;}
    const d=env.data;
    let chart=this.data.scope?view.scopedChartDistribution(d,this.data.scope):view.chartDistribution(d);
    const onlyRoot=!this.data.scope&&chart.groups.length===1&&chart.groups[0].children.length?chart.groups[0]:null;
    if(onlyRoot)chart=view.scopedChartDistribution(d,onlyRoot.projectId);
    const showDistributionChart=view.shouldShowDayDistributionChart(chart.groups,!!(this.data.scope||onlyRoot));
    const rows=chart.segments,dashboard=buildDashboard(chart.groups,rows,chart.tree);
    this.dashboard=dashboard;
    const detail=selectedDetail(dashboard,this.data.selectedProjectId),selectedProjectId=require('../../utils/project-list-link').contains(chart.tree,this.data.selectedProjectId)?this.data.selectedProjectId:'';
    const expansion=detailExpansion(detail,this.data.expandedDetailChildIds);
    const avgSessionText=d.sessionCount>0?format.durationText(d.totalSeconds/d.sessionCount):'0秒';
    const dateIndex=time.parseDayKey(this.data.date),parts=time.partsOfDayIndex(dateIndex);
    const dateTitle=parts.month+'月'+parts.day+'日 · '+format.WEEK_CN[time.weekdayOfDayIndex(dateIndex)];
    this.setData(Object.assign(view.summary(d),{error:'',avgSessionText,dateTitle,today:view.today(),scopeName:this.data.scope?d.pathText:'全部项目',scopeShortName:this.data.scope?d.name:onlyRoot?onlyRoot.name:'',singleExpand:!!(this.data.scope||onlyRoot),rows,chartGroups:chart.groups,chartTree:chart.tree,showDistributionChart,totalText:format.durationText(d.totalSeconds),totalParts:durationParts(d.totalSeconds),stackSegs:chart.groups.filter(r=>r.seconds>0).map(r=>Object.assign({},r,{width:d.totalSeconds?r.seconds/d.totalSeconds*100:0})),shortTotal:format.heatDurationText(d.totalSeconds),countText:'共 '+d.sessionCount+' 次专注',canNext:this.data.date<view.today(),selectedProjectId,selectedDetail:expansion.detail,expandedDetailChildIds:expansion.ids}));
  },
  onChartSelectParent(e){this.applyChartSelection(e.detail);},
  showAllProjects(){require('../../utils/show-all-projects')(this);},
  onChartExpandState(e){const {expandable,allExpanded}=e.detail,nextExpandable=!!expandable,nextExpanded=!!allExpanded;if(this.data.chartExpandable!==nextExpandable||this.data.chartAllExpanded!==nextExpanded)this.setData({chartExpandable:nextExpandable,chartAllExpanded:nextExpanded});},
  toggleChartAll(){const chart=this.selectComponent('#distributionChart');if(chart)chart.toggleAll();},
  onChartSelectChild(e){this.applyChartSelection(e.detail);},
  applyChartSelection(detail){require('../../utils/project-list-link').selectFromChart(this,detail);},
  onListFocusChange(e){require('../../utils/project-list-link').revealFocus(this,e.detail);},
  clearProjectFocus(){require('../../utils/project-list-link').clearFocus(this);},
  toggleDetailChild(e){const id=(e.detail&&e.detail.id)||e.currentTarget.dataset.id,detail=this.data.selectedDetail,child=detail&&(detail.type==='parent'?detail.children.find(item=>item.id===id):detail.id===id?detail:null);if(!child||!child.grandchildren.length)return;const ids=this.data.expandedDetailChildIds,expansion=detailExpansion(detail,ids.indexOf(id)>=0?ids.filter(item=>item!==id):ids.concat(id));this.setData({selectedDetail:expansion.detail,expandedDetailChildIds:expansion.ids});},
  pickDate(e){if(e.detail.value>view.today())return;this.resetChartSelection();this.setData({date:e.detail.value});this.load();},
  move(delta){const date=time.dayKeyOfIndex(time.parseDayKey(this.data.date)+delta);if(date>view.today())return;this.resetChartSelection();this.setData({date});this.load();},
  resetChartSelection(){const chart=this.selectComponent('#distributionChart');if(chart)chart.resetView();this.setData({selectedProjectId:'',selectedDetail:null,expandedDetailChildIds:[]});},
  prev(){this.move(-1);},next(){this.move(1);},
  onDateTouchStart(e){const p=e.touches&&e.touches[0];if(p)this.dateGesture={x:p.clientX,y:p.clientY};},
  onDateTouchEnd(e){const p=e.changedTouches&&e.changedTouches[0],s=this.dateGesture;this.dateGesture=null;if(!p||!s)return;const dx=p.clientX-s.x,dy=p.clientY-s.y;if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.5)this.move(dx<0?1:-1);},
  back(){wx.navigateBack({fail:()=>wx.reLaunch({url:'/pages/stats/stats'})});},
  goHierarchy(){const chart=this.selectComponent('#distributionChart');if(chart)chart.openFullView();},
  onChartFullChange(e){this.setData({chartFull:!!e.detail.open});},
  goProject(e){const id=(e.detail&&e.detail.projectId)||(e.currentTarget&&e.currentTarget.dataset.id);if(!id||id===this.data.scope)return;wx.navigateTo({url:'/pages/project-stats/project-stats?id='+encodeURIComponent(id)+'&preset=custom&startDate='+this.data.date+'&endDate='+this.data.date});}
});
