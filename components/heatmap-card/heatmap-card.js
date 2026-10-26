const demoContext = require('../../utils/demo-context');
const time = require('../../core/time');
const format = require('../../utils/format');
const view = require('../../utils/view-data');
const heatColor = require('../../utils/heat-color');
const { responsiveMetrics, isTabletLandscape } = require('../../utils/window-layout');
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { demoSession: { type: String, value: '' },
    opened: { type: Boolean, value: false, observer: 'onOpened' },
    theme: { type: String, value: 'light', observer: 'onThemeChange' },
    scopeId: { type: String, value: '' },
    topInset: { type: Number, value: 0 },
    standalone: { type: Boolean, value: false }
  },
  data: { tabletLayout:false,landscapeLayout:false,monthKey:'',currentMonth:'',monthTitle:'',scopeName:'全部项目',scopeOptions:[],scopeIndex:0,
    grid:[],weekHead:[],monthTotalText:'0秒',activeDays:0,canGoNext:false,loading:true,error:'',
    scopePickerOpen:false,scopeLoading:false,scopeError:'',scopeQuery:'',scopeTreeRows:[],scopePickerRows:[],expandedScopeIds:[],recentScopes:[],selectedScopeId:'',
    transitionFrom:null,incomingClass:'',outgoingClass:'',dragPreview:null,dragPreviewOffset:0,dragOffset:0,dragAnimating:false,dragPreviewLoading:false },
  lifetimes: { attached(){this.seq=0;this.attachedReady=true;if(this.properties.opened)this.open();},
    detached(){this.seq++;this.attachedReady=false;} },
  pageLifetimes: { show(){if(this.properties.opened&&this.returningFromDay){this.returningFromDay=false;this.load();}},
    resize(){this.measureLayout();this.gesture=null;this.stageWidth=0;if(this.properties.opened)wx.nextTick(()=>this.createSelectorQuery().select('.month-stage').boundingClientRect(rect=>{if(rect&&rect.width)this.stageWidth=rect.width;}).exec());} },
  methods: {
    measureLayout(){let info;try{info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync();}catch(e){}const tabletLayout=responsiveMetrics(info).tablet,landscapeLayout=isTabletLandscape(info);if(tabletLayout!==this.data.tabletLayout||landscapeLayout!==this.data.landscapeLayout)this.setData({tabletLayout,landscapeLayout});},
    onOpened(opened){if(!this.attachedReady)return;if(opened)this.open();else{this.seq++;this.transitionSeq=(this.transitionSeq||0)+1;this.gesture=null;this.dragTargetMonth='';this.dragReleasePending=false;clearTimeout(this.dragSettleTimer);this.setData({scopePickerOpen:false,scopeQuery:'',transitionFrom:null,incomingClass:'',outgoingClass:'',dragPreview:null,dragDirection:'',dragPreviewLoading:false,dragOffset:0,dragPreviewOffset:0,dragAnimating:false});}},
    onThemeChange(theme){
      if(!this.data.grid.length)return;
      const grid=this.data.grid.map(row=>row.map(cell=>Object.assign({},cell,{heatStyle:cell.outside||cell.isFuture?'':heatColor.heatStyle(cell.seconds,theme)})));
      this.setData({grid});
    },
    async open(){
      this.measureLayout();
      const token=++this.seq,currentMonth=demoContext.todayFor(this).slice(0,7);
      this.scope=this.properties.scopeId||'';
      const keepGrid=this.gridMonthKey===currentMonth&&this.gridScope===(this.scope||'');
      this.setData({monthKey:currentMonth,currentMonth,grid:keepGrid?this.data.grid:[],loading:true,error:''});
      const app=demoContext.appFor(this);await app.globalData.readyPromise;
      if(token!==this.seq||!this.properties.opened)return;
      wx.nextTick(()=>this.createSelectorQuery().select('.month-stage').boundingClientRect(rect=>{if(rect&&rect.width)this.stageWidth=rect.width;}).exec());
      return this.load();
    },
    async load(){
      const token=++this.seq,monthKey=this.data.monthKey,app=demoContext.appFor(this);
      this.setData({loading:true,error:''});await app.globalData.readyPromise;
      const prefsPromise=app.globalData.service.getPrefs();
      const resultPromise=app.globalData.service.getHeatmap({monthKey,scopeProjectId:this.scope||null});
      const values=await Promise.all([prefsPromise,resultPromise]),prefs=values[0],result=values[1];
      if(token!==this.seq||!this.properties.opened)return;
      if(!result.ok){this.pendingTransition='';this.setData({loading:false,error:result.error.message});return;}
      const sunday=!!(prefs&&prefs.weekStartsSunday),d=result.data;
      this.weekStartsSunday=sunday;
      const page=this.makeMonthPage(monthKey,d.cells,sunday,d.scopeName);
      const direction=this.pendingTransition;this.pendingTransition='';
      const transitionFrom=direction&&this.data.grid.length?{
        grid:this.data.grid,weekHead:this.data.weekHead,monthTitle:this.data.monthTitle,
        monthTotalText:this.data.monthTotalText,activeDays:this.data.activeDays
      }:null;
      const transitionToken=this.transitionSeq=(this.transitionSeq||0)+1;
      this.gridMonthKey=monthKey;this.gridScope=this.scope||'';
      this.cacheMonthPage(page);
      this.setData(Object.assign({},page,{loading:false,error:'',
        transitionFrom,incomingClass:transitionFrom?(direction==='next'?'enter-from-right':'enter-from-left'):'',
        outgoingClass:transitionFrom?(direction==='next'?'exit-to-left':'exit-to-right'):''}));
      if(transitionFrom)setTimeout(()=>{
        if(transitionToken===this.transitionSeq)this.setData({transitionFrom:null,incomingClass:'',outgoingClass:''});
      },320);
    },
    makeMonthPage(monthKey,cells,sunday,scopeName){
      const p=time.parseMonthKey(monthKey),weekday=time.weekdayOfDayIndex(p.startIndex),offset=sunday?(weekday+1)%7:weekday;
      const count=Math.max(35,Math.ceil((offset+cells.length)/7)*7),lookup={};
      cells.forEach(c=>{lookup[c.date]=c;});
      const flat=Array.from({length:count},(_,i)=>{
        const date=time.dayKeyOfIndex(p.startIndex-offset+i),c=lookup[date];
        return c?{...c,shortText:format.heatDurationText(c.seconds),isToday:date===demoContext.todayFor(this),heatStyle:heatColor.heatStyle(c.seconds,this.properties.theme)}:
          {date,day:Number(date.slice(-2)),outside:true};
      });
      const grid=[];for(let i=0;i<count;i+=7)grid.push(flat.slice(i,i+7));
      return {monthKey,currentMonth:demoContext.todayFor(this).slice(0,7),grid,
        weekHead:sunday?['日','一','二','三','四','五','六']:['一','二','三','四','五','六','日'],
        monthTitle:p.year+'年'+p.month+'月',scopeName:scopeName||this.data.scopeName||'全部项目',
        monthTotalText:format.durationText(cells.reduce((n,c)=>n+c.seconds,0)),
        activeDays:cells.filter(c=>c.seconds>0).length,canGoNext:monthKey<demoContext.todayFor(this).slice(0,7)};
    },
    cacheMonthPage(page){
      if(!this.monthPageCache)this.monthPageCache=new Map();
      const key=(this.scope||'')+':'+page.monthKey;this.monthPageCache.delete(key);this.monthPageCache.set(key,page);
      while(this.monthPageCache.size>4)this.monthPageCache.delete(this.monthPageCache.keys().next().value);
    },
    monthPageShell(monthKey){
      const p=time.parseMonthKey(monthKey);if(!p)return null;
      const sunday=!!this.weekStartsSunday,weekday=time.weekdayOfDayIndex(p.startIndex),offset=sunday?(weekday+1)%7:weekday;
      const today=demoContext.todayFor(this),count=Math.max(35,Math.ceil((offset+p.days)/7)*7),flat=Array.from({length:count},(_,i)=>{
        const dayIndex=p.startIndex-offset+i,date=time.dayKeyOfIndex(dayIndex),outside=dayIndex<p.startIndex||dayIndex>=p.startIndex+p.days;
        return {date,day:Number(date.slice(-2)),seconds:0,shortText:'',outside,isFuture:date>today,isToday:date===today,
          heatStyle:outside||date>today?'':heatColor.heatStyle(0,this.properties.theme)};
      }),grid=[];
      for(let i=0;i<count;i+=7)grid.push(flat.slice(i,i+7));
      return {monthKey,grid,weekHead:this.data.weekHead,monthTitle:p.year+'年'+p.month+'月',monthTotalText:'读取中…',activeDays:0};
    },
    async loadDragPreview(monthKey){
      this.dragTargetMonth=monthKey;
      const key=(this.scope||'')+':'+monthKey,cached=this.monthPageCache&&this.monthPageCache.get(key);
      if(cached){this.setData({dragPreview:cached,dragPreviewLoading:false},()=>{if(this.dragReleasePending)this.settleDrag(true);});return;}
      this.setData({dragPreview:this.monthPageShell(monthKey),dragPreviewLoading:true});
      if(!this.dragPreviewTasks)this.dragPreviewTasks={};
      if(this.dragPreviewTasks[key])return;
      const task=(async()=>{
        const app=demoContext.appFor(this);await app.globalData.readyPromise;
        const result=await app.globalData.service.getHeatmap({monthKey,scopeProjectId:this.scope||null});
        if(!result.ok)return null;
        const page=this.makeMonthPage(monthKey,result.data.cells,!!this.weekStartsSunday,result.data.scopeName);
        this.cacheMonthPage(page);return page;
      })();
      this.dragPreviewTasks[key]=task;
      const page=await task;delete this.dragPreviewTasks[key];
      if(this.dragTargetMonth!==monthKey)return;
      if(!page){this.dragReleasePending=false;this.setData({dragPreview:null,dragPreviewLoading:false},()=>{if(this.data.dragDirection)this.settleDrag(false);});return;}
      this.setData({dragPreview:page,dragPreviewLoading:false},()=>{if(this.dragReleasePending)this.settleDrag(true);});
    },
    settleDrag(commit){
      if(this.dragAnimating)return;
      const direction=this.data.dragDirection,target=this.dragTargetMonth,width=this.stageWidth||Math.max(280,(wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync()).windowWidth-28);
      if(commit&&(!target||this.data.dragPreviewLoading||!this.data.dragPreview||this.data.dragPreview.monthKey!==target))return;
      this.dragReleasePending=false;this.dragAnimating=true;
      const finalCurrent=commit?(direction==='next'?-width:width):0;
      const finalPreview=commit?0:(direction==='next'?width:-width);
      this.setData({dragAnimating:true,dragOffset:finalCurrent,dragPreviewOffset:finalPreview});
      clearTimeout(this.dragSettleTimer);
      this.dragSettleTimer=setTimeout(()=>{
        if(commit&&this.data.dragPreview){
          const page=this.data.dragPreview;this.gridMonthKey=page.monthKey;this.gridScope=this.scope||'';
          this.setData(Object.assign({},page,{monthKey:page.monthKey,transitionFrom:null,incomingClass:'',outgoingClass:'',dragDirection:'',dragPreview:null,dragPreviewLoading:false,dragOffset:0,dragPreviewOffset:0,dragAnimating:false}));
        }else this.setData({dragDirection:'',dragPreview:null,dragPreviewLoading:false,dragOffset:0,dragPreviewOffset:0,dragAnimating:false});
        this.dragAnimating=false;this.dragTargetMonth='';
      },320);
    },
    openScopePicker(){
      const current=this.scope?{id:this.scope,name:this.data.scopeName}:({id:'',name:'全部项目'});
      const recent=[current].concat(this.data.recentScopes||[]).filter((item,index,all)=>all.findIndex(next=>next.id===item.id)===index).slice(0,4);
      this.setData({scopePickerOpen:true,scopeQuery:'',expandedScopeIds:[],recentScopes:recent},()=>{
        if(this.scopeLoaded){
          this.buildScopePickerRows();
          if(Date.now()-this.scopeLoadedAt>15000)this.loadScopeOptions(true);
        }else this.loadScopeOptions();
      });
    },
    async loadScopeOptions(force){
      if(this.scopeLoaded&&!force)return;
      if(this.data.scopeLoading)return;
      this.setData({scopeLoading:!this.scopeLoaded,scopeError:''});
      const app=demoContext.appFor(this);await app.globalData.readyPromise;
      const result=await app.globalData.service.getManageData();
      if(!this.attachedReady)return;
      if(!result.ok){this.setData({scopeLoading:false,scopeError:this.scopeLoaded?'':result.error.message});return;}
      const rows=result.data.active.concat(result.data.archived);
      const options=[{id:'',name:'全部项目'}].concat(rows.map(row=>({id:row.projectId,name:row.pathText||row.name})));
      this.scopeById={};this.scopeChildren={};
      rows.forEach(row=>{const id=String(row.projectId);this.scopeById[id]=row;const parent=row.parentId==null?'':String(row.parentId);(this.scopeChildren[parent]||(this.scopeChildren[parent]=[])).push(row);});
      const tree=[];
      const visit=(parentId,depth,path,seen)=>{
        (this.scopeChildren[parentId]||[]).forEach(row=>{
          const id=String(row.projectId);if(seen.has(id))return;
          const name=row.name||'未命名项目',nextPath=path?path+' › '+name:name,children=this.scopeChildren[id]||[];
          tree.push({id,name,parentId:parentId||'',path:row.pathText||nextPath,depth,hasChildren:children.length>0,archived:!!row.archived});
          const nextSeen=new Set(seen);nextSeen.add(id);visit(id,depth+1,nextPath,nextSeen);
        });
      };
      visit('',0,'',new Set());this.scopeTreeRows=tree;this.scopeLoaded=true;this.scopeLoadedAt=Date.now();
      const scopeIndex=Math.max(0,options.findIndex(row=>row.id===this.scope));
      this.setData({scopeOptions:options,scopeIndex,scopeName:options[scopeIndex].name,selectedScopeId:this.scope,
        scopeLoading:false,scopeError:'',recentScopes:(this.data.recentScopes||[]).filter(item=>item.id===''||!!this.scopeById[item.id]).slice(0,4)},()=>this.buildScopePickerRows());
    },
    closeScopePicker(){this.setData({scopePickerOpen:false,scopeQuery:''});},
    queryScopes(e){this.setData({scopeQuery:e.detail.value||''},()=>this.buildScopePickerRows());},
    buildScopePickerRows(){
      const query=String(this.data.scopeQuery||'').trim().toLocaleLowerCase(),tree=this.scopeTreeRows||[];
      if(query){this.setData({scopePickerRows:tree.filter(row=>(row.path+' '+row.name).toLocaleLowerCase().includes(query)).map(row=>Object.assign({},row,{searchMatch:true}))});return;}
      const expanded=new Set(this.data.expandedScopeIds||[]),visible=[],openParents=new Set();
      tree.forEach(row=>{if(row.depth===0||openParents.has(row.parentId)){visible.push(Object.assign({},row,{expanded:expanded.has(row.id)}));if(expanded.has(row.id))openParents.add(row.id);}});
      this.setData({scopePickerRows:visible});
    },
    toggleScopeBranch(e){
      const id=String(e.currentTarget.dataset.id||''),row=(this.scopeTreeRows||[]).find(item=>item.id===id);if(!row||!row.hasChildren)return;
      const expanded=new Set(this.data.expandedScopeIds||[]);expanded.has(id)?expanded.delete(id):expanded.add(id);
      this.setData({expandedScopeIds:Array.from(expanded)},()=>this.buildScopePickerRows());
    },
    selectScope(e){
      this.pendingTransition='';
      const id=String(e.currentTarget.dataset.id||''),row=id&&(this.scopeById||{})[id],option=row?{id,name:row.pathText||row.name}:{id:'',name:'全部项目'};
      const recent=[option].concat(this.data.recentScopes||[]).filter((item,index,all)=>all.findIndex(next=>next.id===item.id)===index).slice(0,4);
      const index=Math.max(0,(this.data.scopeOptions||[]).findIndex(item=>item.id===id));
      this.scope=id;this.setData({scopeIndex:index,scopeName:option.name,selectedScopeId:id,recentScopes:recent,scopePickerOpen:false,scopeQuery:''});this.load();
    },
    moveMonth(delta){const key=time.shiftMonthKey(this.data.monthKey,delta);if(!key||key>demoContext.todayFor(this).slice(0,7))return;
      this.pendingTransition=delta>0?'next':'prev';this.setData({monthKey:key});this.load();},
    prevMonth(){this.moveMonth(-1);},nextMonth(){this.moveMonth(1);},
    pickMonth(e){const key=e.detail.value;if(!time.parseMonthKey(key)||key>demoContext.todayFor(this).slice(0,7))return;
      this.pendingTransition='';this.setData({monthKey:key});this.load();},
    touchStart(e){
      if(this.data.dragAnimating||this.data.loading||!this.data.grid.length)return;
      const p=e.touches&&e.touches[0];this.gesture=p?{x:p.clientX,y:p.clientY,startedAt:Date.now(),lastX:p.clientX,lastAt:Date.now(),horizontal:false}:null;
      this.setData({transitionFrom:null,incomingClass:'',outgoingClass:''});
    },
    touchMove(e){
      const p=e.touches&&e.touches[0],start=this.gesture;if(!p||!start)return;
      const dx=p.clientX-start.x,dy=p.clientY-start.y,absX=Math.abs(dx),absY=Math.abs(dy);
      start.lastX=p.clientX;start.lastAt=Date.now();
      if(!start.horizontal){if(absX<7||absX<absY*1.2)return;start.horizontal=true;this.suppressTap=true;setTimeout(()=>{this.suppressTap=false;},450);}
      const direction=dx<0?'next':'prev',delta=direction==='next'?1:-1,target=time.shiftMonthKey(this.data.monthKey,delta);
      const width=this.stageWidth||Math.max(280,(wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync()).windowWidth-28);
      if(!target||(direction==='next'&&target>demoContext.todayFor(this).slice(0,7))){
        this.dragTargetMonth='';this.setData({dragDirection:'',dragOffset:0,dragPreview:null,dragPreviewLoading:false,dragPreviewOffset:0,dragAnimating:false});return;
      }
      if(this.dragTargetMonth!==target||this.data.dragDirection!==direction){
        this.dragReleasePending=false;this.dragTargetMonth=target;this.loadDragPreview(target);
      }
      const offset=Math.max(-width,Math.min(width,dx));
      this.setData({dragDirection:direction,dragOffset:offset,dragPreviewOffset:direction==='next'?width+offset:-width+offset,dragAnimating:false});
    },
    touchEnd(e){
      const p=e.changedTouches&&e.changedTouches[0],start=this.gesture;this.gesture=null;if(!p||!start)return;
      if(!start.horizontal)return;
      const dx=p.clientX-start.x,elapsed=Math.max(1,Date.now()-start.startedAt),velocity=Math.abs(dx)/elapsed;
      const width=this.stageWidth||Math.max(280,(wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync()).windowWidth-28);
      const commit=!!this.data.dragDirection&&(Math.abs(dx)>=width*.32||(Math.abs(dx)>22&&velocity>.45));
      if(commit&&this.data.dragPreviewLoading){this.dragReleasePending=true;return;}
      this.settleDrag(commit&&!!this.data.dragPreview);
    },
    touchCancel(){this.gesture=null;if(this.data.dragDirection)this.settleDrag(false);},
    onCellTap(e){if(this.suppressTap)return;const c=e.currentTarget.dataset.cell;if(this.data.loading||!c||c.outside||c.isFuture||c.date>demoContext.todayFor(this))return;
      this.returningFromDay=true;demoContext.navigateFor(this, {url:'/pages/day-stats/day-stats?date='+c.date+'&scope='+encodeURIComponent(this.scope||''),
        fail:()=>{this.returningFromDay=false;}});},
    close(){this.triggerEvent('close');},noop(){}
  }
});
