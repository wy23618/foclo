const { themeColors } = require('../../utils/theme');
const { computeDonutLayout, hitTestChart, computeMultiDepthLayout, hitTestMulti } = require('../../utils/donut-layout');
const { prepareChartData, formatDuration, formatPercent } = require('../../utils/donut-data');
const { renderDonut, interpolateDonut } = require('../../utils/donut-renderer-compact');
Component({
  properties: { segments: { type:Array,value:[] }, groups: { type:Array,value:[] }, tree: {type:Array,value:[]}, totalText: { type:String,value:'—' }, centerLabel:{type:String,value:''}, singleExpand:{type:Boolean,value:false}, standaloneFull:{type:Boolean,value:false}, compact:{type:Boolean,value:false}, toolbarActions:{type:Boolean,value:false}, animation: { type:Boolean,value:true }, theme: { type:String,value:'light' }, obscured: {type:Boolean,value:false,observer(v){if(v){this.drawToken=(this.drawToken||0)+1;this.cancelAnimation();this.canvas=null;this.ctx=null;this.setData({restoringCanvas:false,drawReady:false});}else if(this.ready)this.setData({restoringCanvas:!!this.data.snapshotPath},()=>wx.nextTick(()=>this.draw(false)));}} },
  observers: { 'segments, groups, theme'() { this.preparedData=null;this.snapshotReady=false;this.setData({snapshotPath:this.properties.obscured||this.data.restoringCanvas?this.data.snapshotPath:''});this.draw(false); } },
  data: { drawReady:false,restoringCanvas:false,snapshotPath:'',chartHeight:290,renderHeight:290,renderWidth:0,labels:[],calloutDetails:[],expandedParentIds:[],expandedIds:[],expandableCount:0,allExpanded:false,selectedParentId:'',selectedChildId:'',calloutPage:0,calloutPageCount:1,layoutError:'',scrollHint:'',detail:null,fullView:false,fullWidth:0,fullHeight:0,isEmpty:false,renderTotal:-1 },
  lifetimes: {
    ready() { this.ready=true;this.draw(false); },
    detached() { this.ready=false;this.drawToken=(this.drawToken||0)+1;this.cancelAnimation(); }
  },
  pageLifetimes: { resize() { this.draw(false);if(this.data.fullView)this.openFullView(); } },
  methods: {
    noop() {},
    captureSnapshot(callback){
      if(!this.data.drawReady&&!this.properties.obscured){this.deferredSnapshotCallback=callback;return;}
      if(this.data.snapshotPath&&this.snapshotReady){if(callback)callback(true);return;}
      const canvas=this.canvas;
      if(!canvas||!wx.canvasToTempFilePath){if(callback)callback(false);return;}
      this.pendingSnapshotCallback=callback||null;
      wx.canvasToTempFilePath({canvas,fileType:'png',success:result=>{
        if(!result||!result.tempFilePath){this.finishSnapshot(false);return;}
        this.snapshotReady=false;
        this.setData({snapshotPath:result.tempFilePath});
      },fail:()=>this.finishSnapshot(false)},this);
    },
    onSnapshotLoad(e){if(e.currentTarget.dataset.path===this.data.snapshotPath)this.finishSnapshot(true);},
    onSnapshotError(e){if(e.currentTarget.dataset.path===this.data.snapshotPath)this.finishSnapshot(false);},
    finishSnapshot(ready){
      this.snapshotReady=ready;
      const callback=this.pendingSnapshotCallback;
      this.pendingSnapshotCallback=null;
      if(callback)callback(ready);
    },
    openFullView(){
      if(!this.ready||this.properties.obscured)return;
      if(!this.properties.standaloneFull){
        if(this.openingFull)return;
        this.openingFull=true;
        const app=getApp();
        app.globalData.fullChartPayload={groups:this.properties.groups,segments:this.properties.segments,tree:this.properties.tree,totalText:this.properties.totalText,centerLabel:this.properties.centerLabel,singleExpand:this.properties.singleExpand,theme:this.properties.theme};
        wx.navigateTo({url:'/pages/chart-full/chart-full',fail:()=>{app.globalData.fullChartPayload=null;wx.showToast({title:'暂时无法打开全图',icon:'none'});},complete:()=>{this.openingFull=false;}});
        return;
      }
      if(!(this.properties.tree&&this.properties.tree.length)&&!this.geometry){this.pendingFullOpen=true;return;}
      this.pendingFullOpen=false;
      const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync();
      const width=info.windowWidth,height=info.windowHeight;
      if(!width||!height)return;
      this.fullSelectedId='';
      this.setData({fullView:true,fullWidth:width,fullHeight:height},()=>wx.nextTick(()=>this.paintFullView()));
      this.triggerEvent('fullchange',{open:true});
    },
    closeFullView(){
      if(!this.data.fullView)return;
      if(this.properties.standaloneFull){wx.navigateBack({delta:1,fail:()=>wx.reLaunch({url:'/pages/stats/stats'})});return;}
      this.fullGeometry=null;this.fullCanvas=null;this.fullTransform=null;
      this.setData({fullView:false},()=>this.draw(false));
      this.triggerEvent('fullchange',{open:false});
    },
    paintFullView(){
      if(!this.ready||!this.data.fullView)return;
      this.createSelectorQuery().select('#donut-full').fields({node:true,size:true}).exec(result=>{
        const item=result&&result[0];if(!this.ready||!this.data.fullView||!item||!item.node)return;
        const canvas=item.node,ctx=canvas.getContext('2d'),w=this.data.fullWidth,h=this.data.fullHeight,
          landscapeWidth=Math.max(w,h),shortSide=Math.min(w,h),rotated=w<h;
        const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync(),dpr=info.pixelRatio||1;
        const measureText=(text,font,weight='400')=>{ctx.font=weight+' '+font+'px sans-serif';return ctx.measureText(text).width;};
        let geometry;
        try{geometry=this.properties.tree&&this.properties.tree.length?
          computeMultiDepthLayout({tree:this.properties.tree,width:landscapeWidth,measureText}):
          this.geometry;}
        catch(error){console.error('[donut/full]',error);wx.showToast({title:'全图暂时无法绘制',icon:'none'});this.closeFullView();return;}
        if(!geometry){this.closeFullView();return;}
        if(this.properties.centerLabel)geometry.centerLines=['',this.properties.centerLabel,'点圆环看细分'];
        this.fullGeometry=geometry;this.fullCanvas=canvas;this.fullContext=ctx;this.fullDpr=dpr;
        canvas.width=Math.ceil(w*dpr);canvas.height=Math.ceil(h*dpr);ctx.scale(dpr,dpr);
        this.renderFullView();
      });
    },
    renderFullView(){
      const ctx=this.fullContext,g=this.fullGeometry;if(!ctx||!g||!this.data.fullView)return;
      const w=this.data.fullWidth,h=this.data.fullHeight,rotated=w<h;
      const scale=Math.min(rotated?w/g.height:h/g.width,rotated?h/g.width:w/g.height);
      const ox=rotated?(w-g.height*scale)/2:(w-g.width*scale)/2;
      const oy=rotated?(h-g.width*scale)/2:(h-g.height*scale)/2;
      ctx.clearRect(0,0,w,h);const dark=this.properties.theme==='dark',colors=themeColors(this.properties.theme);ctx.fillStyle=colors.fullBackground;ctx.fillRect(0,0,w,h);
      ctx.save();if(rotated){ctx.translate(w-ox,oy);ctx.rotate(Math.PI/2);ctx.scale(scale,scale);}
      else{ctx.translate(ox,oy);ctx.scale(scale,scale);}
      g.selectedProjectId=this.fullSelectedId||'';renderDonut(ctx,g,null,null,this.properties.theme);
      ctx.restore();
      // 关闭按钮画在屏幕坐标系（旋转/缩放外），点击判定直接用触点屏幕坐标
      const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync();
      const close={x:12,y:(info.statusBarHeight||24)+12,width:98,height:36};this.fullCloseRect=close;
      ctx.fillStyle=colors.fullCloseBackground;ctx.strokeStyle=colors.fullCloseBorder;ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(close.x+14,close.y);ctx.lineTo(close.x+close.width-14,close.y);
      ctx.quadraticCurveTo(close.x+close.width,close.y,close.x+close.width,close.y+14);
      ctx.lineTo(close.x+close.width,close.y+close.height-14);
      ctx.quadraticCurveTo(close.x+close.width,close.y+close.height,close.x+close.width-14,close.y+close.height);
      ctx.lineTo(close.x+14,close.y+close.height);ctx.quadraticCurveTo(close.x,close.y+close.height,close.x,close.y+close.height-14);
      ctx.lineTo(close.x,close.y+14);ctx.quadraticCurveTo(close.x,close.y,close.x+14,close.y);ctx.closePath();ctx.fill();ctx.stroke();
      ctx.font='600 14px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=colors.fullCloseText;
      ctx.fillText('关闭全图',close.x+close.width/2,close.y+close.height/2);
      this.fullTransform={rotated,scale,ox,oy};
    },
    onFullTouchStart(e){const t=e.touches&&e.touches[0];this.fullStart=t?{x:t.clientX,y:t.clientY}:null;this.fullMoved=false;},
    onFullTouchMove(e){const t=e.touches&&e.touches[0],p=this.fullStart;if(t&&p&&Math.hypot(t.clientX-p.x,t.clientY-p.y)>6)this.fullMoved=true;},
    onFullTap(e){
      if(this.fullMoved){this.fullMoved=false;return;}
      const touch=e.changedTouches&&e.changedTouches[0],g=this.fullGeometry,t=this.fullTransform;
      if(!touch||!g||!t)return;
      this.createSelectorQuery().select('#donut-full').boundingClientRect(rect=>{
        if(!rect||!this.data.fullView)return;
        const px=touch.clientX-rect.left,py=touch.clientY-rect.top;
        const close=this.fullCloseRect;
        if(close&&px>=close.x&&px<=close.x+close.width&&py>=close.y&&py<=close.y+close.height){this.closeFullView();return;}
        const x=(t.rotated?py-t.oy:px-t.ox)/t.scale;
        const y=(t.rotated?this.data.fullWidth-t.ox-px:py-t.oy)/t.scale;
        const hit=hitTestMulti(g,x,y);
        if(!hit.sector)return;
        this.fullSelectedId=this.fullSelectedId===hit.sector.projectId?'':hit.sector.projectId;
        this.renderFullView();
      }).exec();
    },
    cancelAnimation() { if(this.canvas&&this.frame!==undefined)this.canvas.cancelAnimationFrame(this.frame);if(this.canvas&&this.panFrame!==undefined)this.canvas.cancelAnimationFrame(this.panFrame);this.frame=undefined;this.panFrame=undefined; },
    draw(animate=false) {
      if(!this.ready||this.properties.obscured)return;
      this.snapshotReady=false;
      this.setData({snapshotPath:this.data.restoringCanvas?this.data.snapshotPath:'',drawReady:false});
      const token=this.drawToken=(this.drawToken||0)+1;this.cancelAnimation();
      if(!this.preparedData)this.preparedData=prepareChartData({groups:this.properties.groups,segments:this.properties.segments});
      this.createSelectorQuery().select('.chart-viewport').boundingClientRect().select('#donut').fields({node:true,size:true}).exec(res=>{
        if(!this.ready||token!==this.drawToken||!res[0]||!res[1]||!res[1].node)return;
        const width=res[0].width,canvas=res[1].node,ctx=canvas.getContext('2d');this.canvas=canvas;
        const measureText=(text,font,weight='400')=>{ctx.font=weight+' '+font+'px sans-serif';return ctx.measureText(text).width;};
        let g;
        try{
          const key='compact-sides:'+width+':'+this.data.expandedParentIds.slice().sort().join('|');
          if(!this.layoutCache||this.layoutCache.data!==this.preparedData||this.layoutCache.width!==width){
            this.layoutCache={data:this.preparedData,width,entries:new Map(),sectorPlacements:new Map()};
          }
          const entries=this.layoutCache.entries,cached=entries.get(key);
          if(cached){entries.delete(key);entries.set(key,cached);g=Object.assign({},cached);}
          else {
            const previous=this.geometry&&this.geometry.preparedData===this.preparedData&&this.geometry.width===width?this.geometry.leaderLayout:null;
            g=computeDonutLayout({preparedData:this.preparedData,width,measureText,expandedParentIds:this.data.expandedParentIds,previousLayout:previous,sectorPlacementCache:this.layoutCache.sectorPlacements});
            entries.set(key,Object.assign({},g));
            if(entries.size>8)entries.delete(entries.keys().next().value);
          }
          g.selectedParentId=this.data.selectedParentId;g.selectedChildId=this.data.selectedChildId;
          if(this.properties.centerLabel)g.centerLines=['',this.properties.centerLabel,'点圆环看细分'];
          const page=Math.min(this.data.calloutPage,g.calloutPages.length-1),leader=g.calloutPages[page];
          Object.assign(g,{calloutPage:page,leaderLayout:leader,computedCallouts:leader.labels,labels:leader.labels});
        }
        catch(error){this.geometry=null;this.setData({layoutError:'图表暂时无法绘制',drawReady:false});console.error('[donut]',error);return;}
        if(!this.runtimeLogged){console.info('[stat-donut/compact-sides]',g.runtime);this.runtimeLogged=true;}
        const from=this.geometry,oldViewport=this.viewport;
        const validParents=new Set(g.preparedData.parents.map(p=>p.id)), validChildren=new Set([...g.childSectors,...g.calloutPages.flatMap(page=>page.labels),...g.calloutDetails].filter(s=>s.type==='child').map(s=>s.projectId));
        if(!validParents.has(g.selectedParentId))g.selectedParentId='';
        if(g.selectedChildId&&!validChildren.has(g.selectedChildId)){g.selectedChildId='';g.selectedParentId='';}
        const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync(),dpr=info.pixelRatio||1;
        const useAnimation=animate&&this.properties.animation&&from&&from.engine==='compact-sides'&&canvas.requestAnimationFrame;
        const height=useAnimation?Math.max(from.viewportHeight,g.viewportHeight):g.viewportHeight;
        this.viewport={width,height,x:Math.max(0,Math.min(g.width-width,oldViewport&&from?oldViewport.x+g.x-from.x:(g.width-width)/2)),y:Math.max(0,Math.min(g.height-height,oldViewport&&from?oldViewport.y+g.y-from.y:0))};
        this.geometry=g;
        const expandableCount=this.preparedData.parents.filter(p=>p.canExpand).length;
        const expandedSet=new Set(g.expandedParentIds);
        this.setData({drawReady:false,renderWidth:width,renderTotal:this.preparedData.totalAllSeconds,isEmpty:this.preparedData.totalAllSeconds<=0,renderHeight:height,chartHeight:height,calloutDetails:g.calloutDetails.map(s=>({projectId:s.projectId,parentId:s.parentId,name:s.name,time:s.timeFormatted,globalPercent:s.globalPercent,parentPercent:s.parentPercent,type:s.type})),calloutPage:g.calloutPage,calloutPageCount:g.calloutPages.length,expandedParentIds:g.expandedParentIds,expandedIds:g.expandedIds,expandableCount,allExpanded:expandableCount>0&&g.expandedParentIds.filter(id=>this.preparedData.parents.some(p=>p.canExpand&&p.id===id)).length===expandableCount,selectedParentId:g.selectedParentId,selectedChildId:g.selectedChildId,layoutError:'',detail:this.makeDetail(g),scrollHint:g.scrollable?'拖动图表查看完整标注':''},()=>{
          if(!this.ready||token!==this.drawToken)return;
          if(this.properties.toolbarActions)this.triggerEvent('expandstate',{expandable:expandableCount>0,allExpanded:this.data.allExpanded});
          const resizeBuffer=(pixelWidth,pixelHeight)=>{
            if(canvas.width===pixelWidth&&canvas.height===pixelHeight)return;
            canvas.width=pixelWidth;canvas.height=pixelHeight;ctx.scale(dpr,dpr);
          };
          resizeBuffer(Math.ceil(width*dpr),Math.ceil(height*dpr));this.ctx=ctx;this.dpr=dpr;
          const finish=()=>{
            if(!this.ready||token!==this.drawToken)return;
            this.frame=undefined;this.visualGeometry=g;
            this.viewport.height=g.viewportHeight;this.viewport.y=Math.min(this.viewport.y,Math.max(0,g.height-g.viewportHeight));
            this.visualViewport=this.viewport;
            const paint=()=>{
              if(!this.ready||token!==this.drawToken)return;
              resizeBuffer(Math.ceil(width*dpr),Math.ceil(g.viewportHeight*dpr));
              try{renderDonut(ctx,g,null,this.viewport,this.properties.theme);}
              catch(error){console.error('[donut/paint]',error);}
              const reveal=()=>{
                if(!this.ready||token!==this.drawToken||this.properties.obscured)return;
                this.frame=undefined;
                this.setData({drawReady:true,restoringCanvas:false,snapshotPath:''},()=>{
                  const callback=this.deferredSnapshotCallback;
                  this.deferredSnapshotCallback=null;
                  if(callback)this.captureSnapshot(callback);
                });
              };
              if(this.data.restoringCanvas&&canvas.requestAnimationFrame)this.frame=canvas.requestAnimationFrame(()=>{
                if(!this.ready||token!==this.drawToken||this.properties.obscured)return;
                this.frame=canvas.requestAnimationFrame(reveal);
              });
              else reveal();
            };
            if(this.data.renderHeight===g.viewportHeight&&this.data.chartHeight===g.viewportHeight)paint();
            else this.setData({renderHeight:g.viewportHeight,chartHeight:g.viewportHeight},paint);
          };
          if(this.pendingFullOpen){this.pendingFullOpen=false;wx.nextTick(()=>this.openFullView());}
          if(!useAnimation){finish();return;}
          if(from)renderDonut(ctx,from,null,oldViewport||this.viewport,this.properties.theme);
          let start;
          const frame=timestamp=>{
            if(!this.ready||token!==this.drawToken)return;
            if(start===undefined)start=timestamp;
            const elapsed=Math.min(1,(timestamp-start)/g.config.animationDuration),progress=1-Math.pow(1-elapsed,3);
            this.visualGeometry=interpolateDonut(g,from,progress);
            const end=this.viewport,begin=oldViewport||end;
            this.visualViewport=Object.assign({},end,{x:begin.x+(end.x-begin.x)*progress,y:begin.y+(end.y-begin.y)*progress});
            renderDonut(ctx,g,{from,progress},this.visualViewport,this.properties.theme);
            if(elapsed<1)this.frame=canvas.requestAnimationFrame(frame);else finish();
          };this.frame=canvas.requestAnimationFrame(frame);
        });
      });
    },
    makeDetail(g) {
      const child=[...g.childSectors,...g.calloutPages.flatMap(page=>page.labels),...g.calloutDetails].find(s=>s.projectId===g.selectedChildId);
      if(child)return {name:child.name,parentName:(g.preparedData.parents.find(p=>p.id===child.parentId)||{}).name,time:formatDuration(child.duration),globalPercent:child.globalPercent,parentPercent:child.parentPercent,virtual:!!child.virtual,members:child.visualAggregate?child.members.map(s=>({id:s.projectId,name:s.name,time:formatDuration(s.duration),globalPercent:s.globalPercent,parentPercent:s.parentPercent})):[]};
      const p=g.preparedData.parents.find(p=>p.id===g.selectedParentId);
      return p?{name:p.name,time:formatDuration(p.duration),globalPercent:formatPercent(p.duration/g.totalAllSeconds),dataIssue:!!p.dataIssue}:null;
    },
    onParentTap(id,origin='chart') {
      const p=this.preparedData&&this.preparedData.parents.find(p=>p.id===id);if(!p)return;
      const repeated=this.data.selectedParentId===id&&!this.data.selectedChildId;
      const expandedParentIds=repeated?this.data.expandedParentIds.filter(value=>value!==id):p.canExpand?(this.properties.singleExpand?[id]:this.data.expandedParentIds.includes(id)?this.data.expandedParentIds.slice():this.data.expandedParentIds.concat(id)):this.data.expandedParentIds.slice();
      this.setData({expandedParentIds,selectedParentId:repeated?'':id,selectedChildId:'',calloutPage:0},()=>this.draw(false));
      this.triggerEvent('selectParent',{projectId:repeated?'':id,name:p.name,duration:p.duration,hasChildren:p.canExpand,origin});
    },
    onChildTap(id,parentId,origin='chart') {
      const g=this.geometry;
      const sector=g&&[...g.childSectors,...g.calloutPages.flatMap(page=>page.labels),...g.calloutDetails].find(s=>s.projectId===id&&(!parentId||s.parentId===parentId));
      const parent=this.preparedData&&this.preparedData.parents.find(p=>p.id===parentId||p.effectiveChildren.some(c=>c.id===id));
      const child=parent&&parent.effectiveChildren.find(c=>c.id===id);
      if(!sector&&!child)return;
      const actualParentId=sector?sector.parentId:parent.id;
      const repeated=this.data.selectedChildId===id;
      const page=g?g.calloutPages.findIndex(page=>page.labels.some(l=>l.projectId===id||(l.members||[]).some(m=>m.projectId===id))):-1;
      this.setData({selectedParentId:repeated?'':actualParentId,selectedChildId:repeated?'':id,calloutPage:Math.max(0,page)},()=>this.draw(false));
      this.triggerEvent('selectChild',{projectId:repeated?'':id,parentId:actualParentId,name:child?child.name:sector.name,duration:child?child.duration:sector.duration,virtual:!!(child&&child.virtual),origin});
    },
    onCalloutPageTap() {this.setData({calloutPage:(this.data.calloutPage+1)%this.data.calloutPageCount},()=>this.draw(false));},
    onCalloutDetailTap(e) {const item=e.currentTarget.dataset;if(item.type==='child')this.onChildTap(item.id,item.parent);else this.onParentTap(item.id);},
    expand(id) { this.onParentTap(id); },
    collapse() { this.setData({expandedParentIds:[],selectedChildId:''},()=>this.draw(false)); },
    toggleAll() {
      const parents=(this.preparedData||prepareChartData({groups:this.properties.groups,segments:this.properties.segments})).parents;
      const expandable=parents.filter(p=>p.canExpand).map(p=>p.id);
      if(!expandable.length)return;
      const expandedParentIds=this.data.allExpanded?[]:expandable;
      this.setData({expandedParentIds,selectedParentId:'',selectedChildId:'',calloutPage:0},()=>this.draw(false));
    },
    resetView() { this.setData({expandedParentIds:[],expandedIds:[],expandableCount:0,allExpanded:false,selectedParentId:'',selectedChildId:'',calloutPage:0,detail:null},()=>this.draw(false)); },
    clearSelection() { this.setData({selectedParentId:'',selectedChildId:'',detail:null},()=>this.draw(false)); },
    paintCurrent() { if(this.ctx&&this.geometry)renderDonut(this.ctx,this.geometry,null,this.viewport,this.properties.theme); },
    onTouchStart(e) {
      const t=e.touches&&e.touches[0];if(!t||!this.viewport)return;
      this.touchStart={x:t.clientX,y:t.clientY,offsetX:this.viewport.x,offsetY:this.viewport.y};this.touchMoved=false;
    },
    onTouchMove(e) {
      const t=e.touches&&e.touches[0],start=this.touchStart,g=this.geometry;if(!t||!start||!g)return;
      const dx=start.x-t.clientX,dy=start.y-t.clientY;if(Math.hypot(dx,dy)<3&&!this.touchMoved)return;this.touchMoved=true;
      if(!g.scrollable)return;
      const unfinished=!this.data.drawReady;this.cancelAnimation();this.visualGeometry=g;
      if(unfinished||this.viewport.height!==g.viewportHeight){
        this.viewport.height=g.viewportHeight;this.canvas.width=Math.ceil(this.viewport.width*this.dpr);this.canvas.height=Math.ceil(g.viewportHeight*this.dpr);this.ctx.scale(this.dpr,this.dpr);
        this.setData({renderHeight:g.viewportHeight,chartHeight:g.viewportHeight,drawReady:true});
      }
      this.viewport.x=Math.max(0,Math.min(g.width-this.viewport.width,start.offsetX+dx));this.viewport.y=Math.max(0,Math.min(g.height-this.viewport.height,start.offsetY+dy));this.visualViewport=this.viewport;
      const paint=()=>{this.panFrame=undefined;if(this.ready)this.paintCurrent();};
      if(this.canvas.requestAnimationFrame)this.panFrame=this.canvas.requestAnimationFrame(paint);else paint();
    },
    onTouchCancel() { this.touchStart=null;this.touchMoved=false; },
    onTap(e) {
      if(this.touchMoved){this.touchMoved=false;this.touchStart=null;return;}
      const t=e.changedTouches&&e.changedTouches[0],g=this.geometry;if(!t||!g)return;
      this.createSelectorQuery().select('#donut').boundingClientRect(rect=>{
        if(!rect||g!==this.geometry)return;
        const viewport=this.visualViewport||this.viewport;
        const hit=hitTestChart(this.visualGeometry||g,t.clientX-rect.left+viewport.x,t.clientY-rect.top+viewport.y);
        if(hit.type==='parent')this.onParentTap(hit.sector.projectId);
        else if(hit.type==='child')this.onChildTap(hit.sector.projectId,hit.sector.parentId);
      }).exec();
    }
  }
});
