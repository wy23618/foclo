const { colorOf } = require('../../utils/color');

Component({
  properties:{
    opened:{type:Boolean,value:false,observer:'onOpenedChange'},
    rows:{type:Array,value:[],observer:'onRowsChange'},
    theme:{type:String,value:'light'},
    selected:{type:String,value:'',observer:'onRowsChange'}
  },
  data:{visibleRows:[],expandedIds:[],bodyHeight:160,listScrollTop:0,currentName:'全部项目'},
  methods:{
    noop(){},
    close(){if(this.closing)return;this.closing=true;this.triggerEvent('close');},
    onBeforeLeave(){this.close();},
    onAfterLeave(){
      if(this.afterLeaveSent)return;
      this.afterLeaveSent=true;
      this.triggerEvent('afterclose');
      const selection=this.pendingSelection;
      this.pendingSelection=null;
      if(selection)this.triggerEvent('select',selection);
    },
    onOpenedChange(opened){
      if(!opened)return;
      this.closing=false;this.afterLeaveSent=false;this.pendingSelection=null;
      const byId={};(this.properties.rows||[]).forEach(row=>{byId[String(row.projectId)]=row;});
      const expandedIds=[],seen=new Set();
      let current=byId[this.properties.selected];
      while(current&&current.parentId&&!seen.has(String(current.parentId))){
        const id=String(current.parentId);seen.add(id);expandedIds.push(id);current=byId[id];
      }
      this.setData({expandedIds,listScrollTop:0});
      this.rebuildVisibleRows(this.properties.rows||[],expandedIds);
    },
    onRowsChange(){this.rebuildVisibleRows(this.properties.rows||[],this.data.expandedIds||[]);},
    rebuildVisibleRows(rows,expandedIds){
      const byParent={};
      (rows||[]).forEach(row=>{
        const parentId=row.parentId==null?'':String(row.parentId);
        (byParent[parentId]||(byParent[parentId]=[])).push(row);
      });
      const expanded=new Set(expandedIds||[]);
      const visible=[];
      const nodesById={},seen=new Set();
      const walk=(parentId,depth)=>{
        const siblings=byParent[parentId]||[];
        siblings.forEach((row,index)=>{
          const id=String(row.projectId);
          if(seen.has(id))return;
          seen.add(id);
          const children=byParent[id]||[];
          const node=Object.assign({},row,{_id:id,_depth:depth,_indent:Math.min(depth,4)*56,_hasChildren:children.length>0,_childCount:children.length,_expanded:expanded.has(id),_hasNextSibling:index<siblings.length-1,_color:row.color||colorOf(id)});
          nodesById[id]=node;visible.push(node);
          if(children.length&&expanded.has(id))walk(id,depth+1);
        });
      };
      walk('',0);
      visible.forEach(row=>{
        row._guideLeft=20-56;row._guideRails=[];
        let ancestor=nodesById[String(row.parentId||'')];
        while(ancestor){
          if(ancestor._depth>0&&ancestor._hasNextSibling)row._guideRails.push({left:Math.min(ancestor._depth-1,3)*56+20-row._indent});
          ancestor=nodesById[String(ancestor.parentId||'')];
        }
      });
      const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync(),scale=(info.windowWidth||375)/750;
      const desired=(84+(rows||[]).length*92)*scale;
      const available=Math.max(80,(info.windowHeight||667)*.72-300*scale);
      const selected=(rows||[]).find(row=>String(row.projectId)===this.properties.selected);
      this.setData({visibleRows:visible,bodyHeight:Math.ceil(Math.min(desired,available)),currentName:selected?selected.name:'全部项目'});
    },
    toggleExpand(e){
      if(this.closing)return;
      if(!e.currentTarget.dataset.hasChildren){this.select(e);return;}
      const id=String(e.currentTarget.dataset.id||'');
      const expanded=new Set(this.data.expandedIds||[]);
      expanded.has(id)?expanded.delete(id):expanded.add(id);
      const expandedIds=Array.from(expanded);
      this.setData({expandedIds});
      this.rebuildVisibleRows(this.data.rows||[],expandedIds);
    },
    select(e){
      if(this.closing)return;
      // Wait for the native return layer to leave before navigating to statistics.
      this.pendingSelection={projectId:e.currentTarget.dataset.id||''};
      this.close();
    }
  }
});
