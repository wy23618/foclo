const format=require('./format');
const time=require('../core/time');
const {colorOf}=require('./color');
const RANGE_ITEMS=[{key:'today',label:'今天'},{key:'last7',label:'近7天'},{key:'last30',label:'近30天'},{key:'custom',label:'自定义'}];
const MODE_ITEMS=[{key:'realtime',label:'实时'},{key:'completed',label:'仅已完成'}];
const today=()=>time.dayKey(Math.floor(Date.now()/1000));
function percent(part,total){const p=total>0?part/total*100:0;return p>0&&p<1?'<1%':(Math.round(p*10)/10)+'%';}
function distribution(rows,total){return rows.slice().sort((a,b)=>b.seconds-a.seconds).map(r=>Object.assign({},r,{color:colorOf(r.projectId),width:total>0?r.seconds/total*100:0,secondsText:format.durationText(r.seconds),shortText:format.heatDurationText(r.seconds),pctText:percent(r.seconds,total)}));}
function subjectRows(d,scope){
 const projects=d.projects||[],byId={};projects.forEach(p=>byId[p.projectId]=p);
 function names(p){const out=[],seen={};while(p&&!seen[p.projectId]){seen[p.projectId]=true;out.unshift(p.name);p=byId[p.parentId];}return out;}
 function inside(p){if(!scope)return true;const seen={};while(p&&!seen[p.projectId]){if(p.projectId===scope)return true;seen[p.projectId]=true;p=byId[p.parentId];}return false;}
 return distribution(projects.filter(inside).map(p=>Object.assign({},p,{seconds:(d.secondsById||{})[p.projectId]||0,parentText:names(p).slice(0,-1).join(' › '),pathText:names(p).join(' › '),self:p.projectId===scope})).filter(p=>p.seconds>0),d.totalSeconds);
}
function subjectList(d,scope){
 const projects=d.projects||[],byId={},kids={};projects.forEach(p=>{byId[p.projectId]=p;(kids[p.parentId||'']||(kids[p.parentId||'']=[])).push(p);});
 const totals={},seen={};function sum(p){if(totals[p.projectId]!==undefined)return totals[p.projectId];if(seen[p.projectId])return 0;seen[p.projectId]=true;return totals[p.projectId]=((d.secondsById||{})[p.projectId]||0)+(kids[p.projectId]||[]).reduce((n,c)=>n+sum(c),0);}
 projects.forEach(sum);const rows=[];function append(p,depth){rows.push(Object.assign({},p,{seconds:totals[p.projectId]||0,self:p.projectId===scope,depth,parentName:byId[p.parentId]?byId[p.parentId].name:'',ownSecondsText:format.durationText((d.secondsById||{})[p.projectId]||0),ownSeconds:(d.secondsById||{})[p.projectId]||0,indent:Math.min(depth,5)*36,includesChildren:!!(kids[p.projectId]||[]).length}));(kids[p.projectId]||[]).slice().sort((a,b)=>totals[b.projectId]-totals[a.projectId]).forEach(c=>append(c,depth+1));}
 if(scope){if(byId[scope])append(byId[scope],0);}else (kids['']||[]).slice().sort((a,b)=>totals[b.projectId]-totals[a.projectId]).forEach(p=>append(p,0));
 const styled=distribution(rows,d.totalSeconds),map={};styled.forEach(p=>map[p.projectId]=p);return rows.map(p=>{const parentTotal=p.parentId&&totals[p.parentId]!==undefined?totals[p.parentId]:totals[scope]||0,item=map[p.projectId];return Object.assign({},item,{color:p.color||item.color,parentPct:percent(p.seconds,parentTotal),parentWidth:parentTotal>0?Math.min(100,p.seconds/parentTotal*100):0});});
}
function chartDistribution(d,scope){
 const byId={},kids={},totals={},visiting=new Set();
 (d.projects||[]).forEach(p=>{byId[p.projectId]=p;(kids[p.parentId||'']||(kids[p.parentId||'']=[])).push(p);});
 function sum(p){
   if(totals[p.projectId]!==undefined)return totals[p.projectId];
   if(visiting.has(p.projectId)){console.warn('[donut] project cycle',p.projectId);return 0;}
   visiting.add(p.projectId);
   const total=Number((d.secondsById||{})[p.projectId]||0)+(kids[p.projectId]||[]).reduce((n,c)=>n+sum(c),0);
   visiting.delete(p.projectId);return totals[p.projectId]=total;
 }
 const roots=scope?(byId[scope]?[byId[scope]]:[]):(d.projects||[]).filter(p=>!p.parentId||!byId[p.parentId]);
 const groups=roots.map(p=>Object.assign({},p,{seconds:sum(p),color:p.color||colorOf(p.projectId),children:(kids[p.projectId]||[]).map(child=>({id:child.projectId,projectId:child.projectId,name:child.name,shortName:child.shortName||'',duration:sum(child),seconds:sum(child),color:child.color||colorOf(child.projectId)}))})).filter(p=>p.seconds>0).sort((a,b)=>b.seconds-a.seconds||String(a.projectId).localeCompare(String(b.projectId)));
 // segments remains the existing direct-record list for page empty states and
 // compatibility. Geometry consumes groups.children (direct subtree totals).
 return {groups,segments:subjectRows(d,scope),tree:buildTree(d,scope)};
}
function buildTree(d,scope){
 const toNode=n=>({id:n.projectId,name:n.name,shortName:n.shortName||'',duration:n.seconds,color:n.color,
   children:n.children.map(toNode)});
 return hierarchyDistribution(d,scope).nodes.map(toNode);
}
function scopedChartDistribution(d,scope){
 const hierarchy=hierarchyDistribution(d,scope),root=hierarchy.nodes[0];
 if(!root)return {groups:[],segments:[],tree:[]};
 const own=root.ownSeconds>0?{id:scope,projectId:scope,name:root.name+'本级',shortName:'本级',seconds:root.ownSeconds,duration:root.ownSeconds,color:root.color,children:[],virtual:true}:null;
 const groups=root.children.map(n=>({id:n.projectId,projectId:n.projectId,name:n.name,shortName:n.shortName||'',seconds:n.seconds,duration:n.seconds,color:n.color,children:n.children.map(c=>({id:c.projectId,projectId:c.projectId,name:c.name,shortName:c.shortName||'',seconds:c.seconds,duration:c.seconds,color:c.color}))}));
 if(own)groups.push(own);
 groups.sort((a,b)=>b.seconds-a.seconds||String(a.projectId).localeCompare(String(b.projectId)));
 const toTree=n=>({id:n.projectId,name:n.name,shortName:n.shortName||'',duration:n.seconds,color:n.color,children:n.children.map(toTree)});
 const tree=root.children.map(toTree);
 if(own)tree.push({id:scope,name:own.name,shortName:'本级',duration:own.duration,color:own.color,virtual:true,children:[]});
 return {groups,segments:subjectRows(d,scope),tree};
}
function hasRecordedChildGroups(groups){return (groups||[]).some(group=>!group.virtual&&Number(group.seconds||group.duration)>0);}
function shouldShowDayDistributionChart(groups,scoped){const positive=(groups||[]).filter(group=>Number(group.seconds||group.duration)>0);return positive.length>1||!!(scoped&&hasRecordedChildGroups(groups));}
function hierarchyDistribution(d,scope){
 const projects=d.projects||[],byId={},kids={},totals={},visiting=new Set();
 projects.forEach(p=>{byId[p.projectId]=p;(kids[p.parentId||'']||(kids[p.parentId||'']=[])).push(p);});
 function sum(p){
  if(totals[p.projectId]!==undefined)return totals[p.projectId];
  if(visiting.has(p.projectId))return 0;
  visiting.add(p.projectId);
  const value=Number((d.secondsById||{})[p.projectId]||0)+(kids[p.projectId]||[]).reduce((n,c)=>n+sum(c),0);
  visiting.delete(p.projectId);return totals[p.projectId]=value;
 }
 const roots=scope?(byId[scope]?[byId[scope]]:[]):projects.filter(p=>!p.parentId||!byId[p.parentId]);
 let maxDepth=0;
 function fullPath(p){const names=[],seen={};while(p&&!seen[p.projectId]){seen[p.projectId]=true;names.unshift(p.name);p=byId[p.parentId];}return names;}
 function node(p,depth){
  const children=(kids[p.projectId]||[]).map(c=>node(c,depth+1)).filter(c=>c.seconds>0).sort((a,b)=>b.seconds-a.seconds);
  const seconds=sum(p);maxDepth=Math.max(maxDepth,depth);
   const names=fullPath(p);return {id:p.projectId,projectId:p.projectId,name:p.name,shortName:p.shortName||'',path:names.join(' › '),depth,level:names.length-1,seconds,ownSeconds:Number((d.secondsById||{})[p.projectId]||0),color:p.color||colorOf(p.projectId),children};
 }
 const nodes=roots.map(p=>node(p,0)).filter(n=>n.seconds>0).sort((a,b)=>b.seconds-a.seconds);
 const rows=[];function flatten(n){rows.push(Object.assign({},n,{durationText:format.durationText(n.seconds),pctText:percent(n.seconds,d.totalSeconds),indent:Math.min(n.depth,7)*28}));n.children.forEach(flatten);}nodes.forEach(flatten);
 return {nodes,rows,maxDepth:maxDepth+1,totalSeconds:d.totalSeconds||0};
}
function subjectOptions(d){const byId={};(d.projects||[]).forEach(p=>byId[p.projectId]=p);return (d.projects||[]).map(p=>{const names=[],seen={};let n=p;while(n&&!seen[n.projectId]){seen[n.projectId]=true;names.unshift(n.name);n=byId[n.parentId];}return Object.assign({},p,{pathText:names.join(' › ')});}).sort((a,b)=>a.pathText.localeCompare(b.pathText,'zh-CN'));}
function summary(d){const total=d.totalSeconds||0,average=d.averageSeconds||0;return {sumH:Math.floor(total/3600),sumM:Math.floor(total%3600/60),sumS:Math.floor(total%60),sumZero:total===0,totalText:format.durationText(total),shortTotal:format.heatDurationText(total),focusCount:d.sessionCount||0,pauseCount:d.pauseCount||0,avgDisplay:format.durationText(average),countText:'共 '+d.sessionCount+' 次专注',avgText:'日均 '+format.durationText(average),rangeText:time.dayKey(d.range.start)+' — '+time.dayKey(d.range.end-1)};}
function record(r){return Object.assign({},r,{color:colorOf(r.projectId),pathText:(r.path||[]).join(' › '),parentPath:(r.path||[]).slice(0,-1).join(' › '),startTime:format.timeOfDay(r.clippedStartedAtSec),timeRange:format.timeOfDay(r.clippedStartedAtSec)+' – '+format.timeOfDay(r.clippedEndedAtSec),durationText:format.durationText(r.seconds),modeText:r.targetSeconds==null?'正向计时':'倒计专注',statusText:r.status==='ACTIVE'?(r.paused?'已暂停':'进行中'):'已完成'});}
function rangeSpec(data){return data.preset==='custom'?{startDate:data.startDate,endDate:data.endDate,mode:data.mode}:{preset:data.preset,mode:data.mode};}
function dateLabel(date){const p=date.split('-');return Number(p[1])+'月'+Number(p[2])+'日';}
module.exports={RANGE_ITEMS,MODE_ITEMS,today,percent,distribution,subjectRows,subjectList,chartDistribution,scopedChartDistribution,hasRecordedChildGroups,shouldShowDayDistributionChart,buildTree,hierarchyDistribution,subjectOptions,summary,record,rangeSpec,dateLabel};
