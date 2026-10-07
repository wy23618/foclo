const { THEME_COLORS } = require('../../utils/theme');
const view=require('../../utils/view-data');const time=require('../../core/time');const format=require('../../utils/format');
const { uuid } = require('../../core/ids');
const { managementRows, deletionMessage } = require('../../utils/record-management');
Component({
  properties:{date:String,scope:{type:String,value:''},mode:{type:String,value:'realtime'},controls:{type:Boolean,value:true},summary:{type:Boolean,value:true},distribution:{type:Boolean,value:true},start:{type:String,value:''},end:{type:String,value:''}},
  data:{distRows:[],timelineRecords:[],projectColors:{},totalText:'0秒',count:0,loading:true,error:'',today:'',canPrev:true,canNext:false,recordManaging:false},
  observers:{'date, scope, mode':function(){if(this.attachedFlag)this.load(true);}},
  lifetimes:{attached(){this.attachedFlag=true;this.load(true);},detached(){this.attachedFlag=false;this.token=(this.token||0)+1;}},
  methods:{
    async load(reset){if(!this.properties.date)return;const token=this.token=(this.token||0)+1;this.setData({loading:true,error:'',...(reset?{timelineRecords:[],projectColors:{}}:{} )});await getApp().globalData.readyPromise;
      const spec={date:this.properties.date,projectId:this.properties.scope||undefined,mode:this.properties.mode,page:1,pageSize:100,includeZeroCompleted:true};const svc=getApp().globalData.service;
      let records=await svc.getRecords(spec);if(records.ok&&records.data.totalCount>records.data.rows.length)records=await svc.getRecords(Object.assign({},spec,{pageSize:Number.MAX_SAFE_INTEGER}));
      const stats=this.properties.summary||this.properties.distribution?await svc.getStatistics({startDate:spec.date,endDate:spec.date,projectId:spec.projectId,mode:spec.mode}):null;
      if(!this.attachedFlag||token!==this.token)return;if(!records.ok||(stats&&!stats.ok)){this.setData({loading:false,error:(!records.ok?records.error:stats.error).message});return;}
      this.allRows=records.data.rows.map(view.record).sort((a,b)=>b.clippedEndedAtSec-a.clippedEndedAtSec||b.clippedStartedAtSec-a.clippedStartedAtSec||String(b.sessionId).localeCompare(String(a.sessionId)));
      const projectColors={};this.allRows.forEach(row=>{projectColors[row.projectId]=row.color;});
      const timelineRecords=this.allRows.map(row=>({id:row.sessionId,project:row.projectId,projectName:row.name,parentPath:row.parentPath,title:'',startTime:row.clippedStartedAtSec*1000,endTime:row.clippedEndedAtSec*1000,durationSec:row.seconds,realStartedAtSec:row.realStartedAtSec,realEndedAtSec:row.realEndedAtSec,totalDurationSeconds:row.totalDurationSeconds,status:row.status,paused:row.paused,color:row.color}));
      const recordTotalSeconds=this.allRows.reduce((sum,row)=>sum+(Number(row.seconds)||0),0),patch={loading:false,timelineRecords,projectColors,count:records.data.totalCount,totalText:format.durationText(recordTotalSeconds),today:view.today(),canPrev:!this.properties.start||this.properties.date>this.properties.start,canNext:this.properties.date<(this.properties.end||view.today())};
      if(stats){const d=stats.data;patch.totalText=view.summary(d).totalText;const dist=this.properties.scope?[{projectId:d.projectId,name:d.name+'（直接记录）',seconds:d.selfSeconds}].concat(d.children):d.roots;patch.distRows=view.distribution(dist,d.totalSeconds).filter(r=>r.seconds>0);}
      this.setData(patch);this.triggerEvent('loaded',{date:spec.date,totalCount:records.data.totalCount});
    },
    onRecordManagementChange(e){this.setData({recordManaging:!!e.detail.managing});},
    async deleteRecord(e) {
      if(this.deletingRecord)return;
      const row=managementRows(this.data.timelineRecords).find(item=>item.id===e.detail.sessionId);
      if(!row||!row.canDelete)return;
      this.deletingRecord=true;
      const svc=getApp().globalData.service,revision=svc.peekCurrent().dataRevision;
      try {
        const confirm=await new Promise(resolve=>wx.showModal({title:'删除这条专注记录？',content:deletionMessage(row),confirmText:'删除记录',confirmColor:THEME_COLORS.light.dangerText,success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
        if(!confirm||!this.attachedFlag)return;
        wx.showLoading({title:'正在删除记录',mask:true});
        let result;
        try{result=await svc.deleteSession({sessionId:row.id,operationId:uuid(),expectedDataRevision:revision});}
        finally{wx.hideLoading();}
        if(!result.ok){wx.showModal({title:'未能删除',content:result.error.message,showCancel:false});return;}
        if(this.attachedFlag)await this.load(false);
        this.triggerEvent('recorddeleted',{sessionId:row.id,date:this.properties.date});
        wx.showToast({title:'记录已删除',icon:'success'});
      } catch(error) {
        wx.showModal({title:'未能完成删除',content:error.message||'请重新打开记录查看删除结果',showCancel:false});
      } finally {this.deletingRecord=false;}
    },
    prev(){if(this.data.canPrev)this.change(time.dayKeyOfIndex(time.parseDayKey(this.properties.date)-1));},next(){if(this.data.canNext)this.change(time.dayKeyOfIndex(time.parseDayKey(this.properties.date)+1));},pick(e){this.change(e.detail.value);},change(date){if(date>view.today())return;this.triggerEvent('datechange',{date});},retry(){this.load(true);},goProject(e){wx.navigateTo({url:'/pages/project-stats/project-stats?id='+encodeURIComponent(e.currentTarget.dataset.id)+'&preset=custom&startDate='+this.properties.date+'&endDate='+this.properties.date+'&mode='+this.properties.mode});}
  }
});

