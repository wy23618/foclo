const { prepareChartData, ensureUnallocatedChild, formatPercent, formatDuration, compactDuration, childColor } = require('./donut-data');
const { THEME_COLORS } = require('./theme');
const {buildVisibleCallouts,layoutCompactCallouts}=require('./callout-layout-compact');
const {routeSegments,segmentDistance}=require('./callout-geometry-v2');
const TWO_PI = Math.PI * 2, START_ANGLE = -Math.PI / 2;
const MIN_CALLOUT_RATIO = 0.01;
// 扇区小框文字：全名放不下时优先使用语义化简称（对齐示例图风格），
// 仍放不下再按可读字号收缩、保留前缀，保证小框内始终有可辨认文字。
const SHORT_NAMES = Object.freeze({
  '词汇背诵':'词汇','阅读精读':'阅读','听力练习':'听力',
  '中国古代史':'古史','世界近代史':'世史','史纲整理':'史纲',
  '数据结构':'数结','操作系统':'系统','计算机网络':'计网',
  '马克思原理':'马原','马原原理':'马原','马原理':'马原',
  '毛中特':'中特','思修时政':'时政'
});
// Logical pixels derived from actual card width. Compact labels may abbreviate
// names; full names and values stay in selection details. Dense charts grow.
const LAYOUT_DEFAULTS = Object.freeze({
  baseChartHeight: 290, maxChartHeight: 520, maxDrawingHeight: 8192,
  chartPadding: 8, labelWidth: 82, textGap: 5, horizontalLeaderLength: 7,
  corridorGap: 4, radialLeaderGap: 1, parentRingWidth: 29, childRingWidth: 20,
  minInnerRadius: 32, baseOuterRadius: 72, sectorFontSize: 12,
  calloutFontSize: 12, auxiliaryFontSize: 11, labelLineHeight: 16,
  namePadding: 6, minLabelGap: 9, safeLabelGap: 6, animationDuration: 220,
  lineWidth: .8, dotRadius: 1.5, centerFontSize: 14, centerLineHeight: 14,
  selectedInset: 2, selectedAlpha: .18, epsilon: 1e-8,
  verticalLimitRatio: .55, diagonalLimitRatio: .75, leaderLimitRatio: .86,
  bandAllowanceRatio: .4, costDiagonalWeight: .25, costLeaderWeight: .15,
  radialClearances: Object.freeze([1,2,3,4,5,6,8,10,12,16,20,24,30]),
  radiusGrowthSteps: Object.freeze([12,24]), smallChildGlobalRatio: .02,
  fullControlX: 12, fullControlTop: 80, fullControlWidth: 76,
  fullControlHeight: 30, fullFooterGap: 24, fullControlFont: 12,
  crossSideBand: 24, maxBoundaryMoves: 3, maxSideCandidates: 18, crossSideImprovement: .055,
  parentLineWidth: 1.2, childLineWidth: .7, backgroundColor: THEME_COLORS.light.cardBackground, preferredDiagonalSlope: 1.1
});
function createLayoutConfig(width, overrides = {}) {
  if (!Number.isFinite(width) || width <= 0) throw new Error('INVALID_CHART_WIDTH');
  const c = Object.assign({}, LAYOUT_DEFAULTS, overrides);
  c.width=width;c.chartPadding=5;c.labelWidth=width*.172;c.textGap=1.5;c.radialLeaderGap=0;
  c.leftLineEndX=c.chartPadding+2.1;c.rightLineEndX=width-c.chartPadding-2.1;
  c.leftLineStartX=c.chartPadding+c.labelWidth+c.textGap;c.rightLineStartX=width-c.leftLineStartX;
  const available=width/2-c.leftLineStartX-c.radialLeaderGap-1;
  c.childOuterRadius=Math.min(width*.32,available);
  c.parentOuterRadius=c.childOuterRadius*.77;c.parentInnerRadius=c.childOuterRadius*.40;
  c.parentRingWidth=c.parentOuterRadius-c.parentInnerRadius;c.childRingWidth=c.childOuterRadius-c.parentOuterRadius;
  c.sectorFontSize=Math.max(9,Math.min(13,width*.031));c.childSectorFontSize=Math.max(8,Math.min(11,width*.027));
  c.calloutFontSize=Math.max(10,Math.min(12,width*.031));c.auxiliaryFontSize=Math.max(9,Math.min(11,width*.027));
  c.localFontSize=Math.max(7,Math.min(8,width*.021));c.minAuxiliaryFontSize=6.5;c.minBodyFontSize=6.5;
  c.shortNames=SHORT_NAMES;
  c.centerFontSize=Math.max(13,Math.min(18,width*.043));c.centerLineHeight=c.auxiliaryFontSize+3;
  c.lineTextGap=2.4;c.minLabelGap=3;c.textRunGap=2;c.dotRadius=1.5;c.lineWidth=c.parentLineWidth;
  c.baseChartHeight=Math.max(210,width*.84);c.cx=width/2;c.cy=c.baseChartHeight/2;
  c.leftTextX=c.chartPadding;c.rightTextX=width-c.chartPadding-c.labelWidth;
  c.horizontalLeaderLength=c.labelWidth+c.textGap;
  if(overrides.thirdLayer){
    const depth=Math.max(1,Number(overrides.hierarchyDepth)||3),outer=Math.min(c.childOuterRadius,overrides.maxOuterRadius||Infinity);
    c.grandchildOuterRadius=outer;
    if(depth<=3){
      c.childOuterRadius=outer*.78;
      c.parentOuterRadius=c.childOuterRadius*.77;
      c.parentInnerRadius=c.parentOuterRadius*.40;
      c.ringBounds=[c.parentInnerRadius,c.parentOuterRadius,c.childOuterRadius,outer];
    }else{
      c.parentInnerRadius=Math.max(18,outer*.23);
      c.ringBounds=Array.from({length:depth+1},(_,index)=>c.parentInnerRadius+(outer-c.parentInnerRadius)*index/depth);
      c.parentOuterRadius=c.ringBounds[1];c.childOuterRadius=c.ringBounds[2];
    }
    c.parentRingWidth=c.parentOuterRadius-c.parentInnerRadius;
    c.childRingWidth=c.childOuterRadius-c.parentOuterRadius;
    c.grandchildRingWidth=c.ringBounds[3]-c.ringBounds[2];
  }
  return c;
}
function polarToCartesian(cx, cy, radius, angle) { return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }; }
function createDonutSectorPath(cx, cy, inner, outer, start, end) {
  const point = (r, a) => { const p = polarToCartesian(cx, cy, r, a); return p.x + ' ' + p.y; };
  // A full SVG circle requires two arcs; coincident ends on a single A are empty.
  if (end - start >= TWO_PI - 1e-8) {
    const mid = start + Math.PI;
    return `M ${point(outer, start)} A ${outer} ${outer} 0 1 1 ${point(outer, mid)} A ${outer} ${outer} 0 1 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 1 0 ${point(inner, mid)} A ${inner} ${inner} 0 1 0 ${point(inner, start)} Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
}
function estimateTextWidth(text, fontSize) { return Array.from(text).reduce((n, ch) => n + (/[^\x00-\xff]/.test(ch) ? fontSize : fontSize * .6), 0); }
function shouldRenderSectorNameAtR(s, angle, radius, c, measure, measuredWidth) {
  const width = measuredWidth === undefined ? measure(s.name, c.sectorFontSize, '600') : measuredWidth;
  // Check the real horizontal text rectangle. Comparing text width to arc
  // length incorrectly hides two-character names on left/right child sectors.
  const center = polarToCartesian(c.cx, c.cy, radius, angle);
  // Radial thickness and angular boundaries both constrain the glyph box.
  for (const dx of [-width / 2, 0, width / 2]) for (const dy of [-c.sectorFontSize / 2, 0, c.sectorFontSize / 2]) {
    const x = center.x + dx - c.cx, y = center.y + dy - c.cy, r = Math.hypot(x, y);
    let a = Math.atan2(y, x); while (a < s.startAngle) a += TWO_PI;
    if (r < s.innerRadius || r > s.outerRadius || a > s.endAngle) return false;
  }
  return true;
}
function shouldRenderSectorNameAt(s, angle, c, measure) {
  return shouldRenderSectorNameAtR(s, angle, (s.innerRadius + s.outerRadius) / 2, c, measure);
}
function shouldRenderSectorName(s, c, measure) { return shouldRenderSectorNameAt(s, s.midAngle, c, measure); }
// 扇区内逐点微调锚点角度：文字在正中放不下时，沿弧线挪到能放下的位置（贴近正中优先）
function findSectorNameAngle(s, name, font, c, measure) {
  const span = s.endAngle - s.startAngle, step = Math.PI / 720, limit = Math.max(0, span / 2 - step);
  for (let off = step; off <= limit; off += step) {
    const a1 = s.midAngle - off, a2 = s.midAngle + off;
    if (a1 > s.startAngle && shouldRenderSectorNameAt(Object.assign({}, s, { name }), a1, Object.assign({}, c, { sectorFontSize: font }), measure)) return a1;
    if (a2 < s.endAngle && shouldRenderSectorNameAt(Object.assign({}, s, { name }), a2, Object.assign({}, c, { sectorFontSize: font }), measure)) return a2;
  }
  return 0;
}
function sector(item, type, startAngle, endAngle, innerRadius, outerRadius, total, parent, c, measure) {
  const s = Object.assign({}, item, { id: type + ':' + (parent ? parent.id + ':' : '') + item.id, projectId: item.id, parentId: parent ? parent.id : item.id, type, layer: type === 'child' ? 'outer' : 'parent', startAngle, endAngle, midAngle: (startAngle + endAngle) / 2, innerRadius, outerRadius, globalRatio: item.duration / total, globalPercent: formatPercent(item.duration / total) });
  if (parent) { s.localRatio = item.duration / parent.duration; s.parentPercent = formatPercent(s.localRatio); }
  s.start = startAngle; s.end = endAngle; s.r = (innerRadius + outerRadius) / 2; s.line = outerRadius - innerRadius;
  s.insideFontSize=type==='parent'?c.sectorFontSize:c.childSectorFontSize;
  const placementCache=c.sectorPlacementCache;
  const placementKey=[s.id,s.name,s.shortName||'',startAngle,endAngle,innerRadius,outerRadius,s.insideFontSize,c.minBodyFontSize].join('|');
  if(placementCache&&placementCache.has(placementKey)){
    Object.assign(s,placementCache.get(placementKey));
    s.path=createDonutSectorPath(c.cx,c.cy,innerRadius,outerRadius,startAngle,endAngle);
    return s;
  }
  const maxFont=s.insideFontSize,minFont=c.minBodyFontSize||6.5;
  const shortName=s.shortName||SHORT_NAMES[s.name]||'';
  const fits=(name,font,angle)=>shouldRenderSectorNameAt(Object.assign({},s,{name}),angle,Object.assign({},c,{sectorFontSize:font}),measure);
  const midScan=(name,from,to)=>{for(let font=from;font>=to;font-=.25)if(fits(name,font,s.midAngle))return font;return 0;};
  let insideName='',insideAngle=s.midAngle;
  // 1) 全名满字号  2) 简写满字号  3) 全名/简写收缩  4) 角度微调（窄扇区斜向时可放下的位置）  5) 前缀回退
  const fullAtMax=midScan(s.name,maxFont,maxFont);
  if(fullAtMax){insideName=s.name;s.insideFontSize=fullAtMax;}
  else if(shortName){
    const shortAtMax=midScan(shortName,maxFont,maxFont);
    if(shortAtMax){insideName=shortName;s.insideFontSize=shortAtMax;}
    else{
      const shortShrunk=midScan(shortName,maxFont-.25,minFont);
      if(shortShrunk){insideName=shortName;s.insideFontSize=shortShrunk;}
    }
  }else{
    const fullShrunk=midScan(s.name,maxFont-.25,minFont);
    if(fullShrunk){insideName=s.name;s.insideFontSize=fullShrunk;}
  }
  if(!insideName){
    const source=shortName||s.name,chars=Array.from(source);
    const rMid=(s.innerRadius+s.outerRadius)/2,radialStep=Math.max(1,(s.outerRadius-s.innerRadius)/6);
    // 兜底：在扇区内做(角度×半径)二维搜索，取"字号最大、位置最贴近正中"的落点。
    // 斜向扇区把文字沿径向挪到外侧（半径更大、切向角占比更小），可比固定环中线用更大字号。
    const findPlacement=(name,from,to)=>{
      const namedSector=Object.assign({},s,{name});
      const radii=[rMid];
      for(let k=1;k<=6;k++){
        const rp=rMid+k*radialStep,rm=rMid-k*radialStep;
        if(rp+from/2<=s.outerRadius)radii.push(rp);
        if(rm-from/2>=s.innerRadius)radii.push(rm);
      }
      const span=s.endAngle-s.startAngle;
      for(let font=from;font>=to;font-=.25){
        const fontConfig=Object.assign({},c,{sectorFontSize:font});
        const textWidth=measure(name,font,'600');
        for(let off=0;off<span/2;off+=Math.PI/180){
          const angles=off===0?[s.midAngle]:[s.midAngle-off,s.midAngle+off];
          for(const a of angles){
            if(a<s.startAngle||a>s.endAngle)continue;
            for(const r of radii)
              if(shouldRenderSectorNameAtR(namedSector,a,r,fontConfig,measure,textWidth))
                return {font,angle:a,radius:r};
          }
        }
      }
      return null;
    };
    for(let len=Math.min(2,chars.length);len>=1&&!insideName;len--){
      const prefix=chars.slice(0,len).join('');
      const floor=len===1?5.0:minFont; // 单字最终底线 5.0px，保证 >8° 扇区不空框
      const p=findPlacement(prefix,maxFont,floor);
      if(p){insideName=prefix;s.insideFontSize=p.font;insideAngle=p.angle;s.insideRadius=p.radius;}
    }
  }
  s.insideName=insideName;s.insideAngle=insideAngle;
  s.showInsideName=!!s.insideName;
  if(placementCache){
    placementCache.set(placementKey,{insideFontSize:s.insideFontSize,insideName:s.insideName,insideAngle:s.insideAngle,insideRadius:s.insideRadius,showInsideName:s.showInsideName});
    if(placementCache.size>256)placementCache.delete(placementCache.keys().next().value);
  }
  s.path = createDonutSectorPath(c.cx, c.cy, innerRadius, outerRadius, startAngle, endAngle);
  return s;
}
function computeParentSectors(data, c, measure) {
  let seconds = 0;
  return data.parents.map((p, index) => {
    const start = START_ANGLE + seconds / data.totalAllSeconds * TWO_PI; seconds += p.duration;
    const end = index === data.parents.length - 1 ? START_ANGLE + TWO_PI : START_ANGLE + seconds / data.totalAllSeconds * TWO_PI;
    return sector(p, 'parent', start, end, c.parentInnerRadius, c.parentOuterRadius, data.totalAllSeconds, null, c, measure);
  });
}
function computeChildSectors(parents, expandedIds, total, c, measure) {
  const children = [];
  parents.forEach(p => {
    if (!expandedIds.includes(p.projectId) || !p.canExpand) return;
    let seconds = 0;
    p.effectiveChildren.forEach((child, index) => {
      const start = p.startAngle + seconds / p.duration * (p.endAngle - p.startAngle); seconds += child.duration;
      const end = index === p.effectiveChildren.length - 1 ? p.endAngle : p.startAngle + seconds / p.duration * (p.endAngle - p.startAngle);
      children.push(sector(child, 'child', start, end, c.parentOuterRadius, c.childOuterRadius, total, { id: p.projectId, duration: p.duration }, c, measure));
    });
  });
  return children;
}
function computeGrandchildSectors(children, nodeById, expandedIds, total, c, measure) {
  const descendants=[];
  function append(parent,depth){
    const node=nodeById[parent.projectId];
    if(!node||!(node.children||[]).length||!expandedIds.has(parent.projectId)||depth+1>=c.ringBounds.length-1)return;
    const prepared=ensureUnallocatedChild({id:parent.projectId,duration:parent.duration,color:parent.color,
      children:node.children.map(child=>({id:child.projectId,name:child.name,shortName:child.shortName||'',duration:child.seconds,color:child.color})),
      hasRealChildren:true},[],()=>{});
    if(!prepared.canExpand)return;
    let seconds=0;
    prepared.effectiveChildren.forEach((child,index)=>{
      const start=parent.startAngle+seconds/parent.duration*(parent.endAngle-parent.startAngle);seconds+=child.duration;
      const end=index===prepared.effectiveChildren.length-1?parent.endAngle:parent.startAngle+seconds/parent.duration*(parent.endAngle-parent.startAngle);
      const item=sector(child,'child',start,end,c.ringBounds[depth+1],c.ringBounds[depth+2],total,{id:parent.projectId,duration:parent.duration},c,measure);
      item.depth=depth+1;descendants.push(item);append(item,depth+1);
    });
  }
  children.forEach(child=>append(child,1));
  return descendants;
}
function wrapText(text, width, fontSize, measure, weight) {
  const lines = []; let current = '';
  for (const ch of Array.from(text)) { if (current && measure(current + ch, fontSize, weight) > width) { lines.push(current); current = ''; } current += ch; }
  if (current) lines.push(current); return lines;
}
function computeVisibleCallouts(parents,children,expandedIds){return buildVisibleCallouts(parents,children,expandedIds);}
function computeDonutLayout(input){
  // Accepted data and parent/child sector geometry remain unchanged. Only the
  // callout subsystem below is replaced; no old engine or retry is invoked.
  const data=input.preparedData||prepareChartData(input),sourceMeasure=input.measureText||estimateTextWidth,measurements=new Map();
  const measure=(text,font,weight)=>{
    const key=font+'|'+weight+'|'+text;
    if(!measurements.has(key))measurements.set(key,sourceMeasure(text,font,weight));
    return measurements.get(key);
  };
  let c=createLayoutConfig(input.width,input.layoutConfig);
  c.sectorPlacementCache=input.sectorPlacementCache;
  const wanted=input.expandedParentIds||input.expandedIds||(input.expandedId?[input.expandedId]:[]),expandedParentIds=data.parents.filter(p=>p.canExpand&&wanted.includes(p.id)).map(p=>p.id);
  let parentSectors=computeParentSectors(data,c,measure),childSectors=computeChildSectors(parentSectors,expandedParentIds,data.totalAllSeconds,c,measure);
  const thirdLayer=!!(input.layoutConfig&&input.layoutConfig.thirdLayer),nodeById={};
  if(thirdLayer){const index=nodes=>(nodes||[]).forEach(node=>{nodeById[node.projectId]=node;index(node.children);});index(input.hierarchyNodes);}
  const expandedIds=new Set(input.expandedProjectIds||Object.keys(nodeById));
  let grandchildSectors=thirdLayer?computeGrandchildSectors(childSectors,nodeById,expandedIds,data.totalAllSeconds,c,measure):[];
  delete c.sectorPlacementCache;
  const visibleChildren=childSectors.concat(grandchildSectors),expandedChildIds=new Set(grandchildSectors.map(s=>s.parentId));
  // Filter only external callouts, using the exact share of the chart total.
  // Keep every sector and its existing expansion/selection behavior.
  const visibleCallouts=(thirdLayer?parentSectors.flatMap(parent=>{
    if(!expandedParentIds.includes(parent.projectId)||!parent.canExpand)return [parent];
    const collect=child=>expandedChildIds.has(child.projectId)?visibleChildren.filter(next=>next.parentId===child.projectId).flatMap(collect):[child];
    return childSectors.filter(child=>child.parentId===parent.projectId).flatMap(collect);
  }).map((s,stableOrder)=>Object.assign({},s,{anchorRadius:s.outerRadius,stableOrder,showNameInCallout:!s.showInsideName||s.insideName!==s.name})):
    buildVisibleCallouts(parentSectors,childSectors,expandedParentIds))
    .filter(s=>s.globalRatio>=MIN_CALLOUT_RATIO);
  const callout=layoutCompactCallouts(visibleCallouts,c,measure,childSectors,parentSectors,input.previousLayout,grandchildSectors);c=callout.config;
  const calloutPages=callout.pages,page=0,leaderLayout=calloutPages[0];
  const withPath=s=>Object.assign({},s,{path:createDonutSectorPath(c.cx,c.cy,s.innerRadius,s.outerRadius,s.startAngle,s.endAngle)});parentSectors=parentSectors.map(withPath);childSectors=childSectors.map(withPath);grandchildSectors=grandchildSectors.map(withPath);
  return {engine:'compact-sides',runtime:{layout:'donut-layout',callout:'callout-layout-compact',renderer:'donut-renderer-compact'},config:c,preparedData:data,parentSectors,childSectors,grandchildSectors,visibleCallouts,calloutDetails:[],computedCallouts:leaderLayout.labels,leaderLayout,calloutPages,calloutPage:page,denseMode:false,expandedParentIds,selectedParentId:input.selectedParentId||'',selectedChildId:input.selectedChildId||'',selectedProjectId:input.selectedProjectId||'',totalAllSeconds:data.totalAllSeconds,childCount:data.childCount,diagnostics:data.diagnostics,width:leaderLayout.width,height:leaderLayout.height,viewportHeight:leaderLayout.height,scrollable:false,
    x:c.cx,y:c.cy,arcs:parentSectors,outerArcs:childSectors,labels:leaderLayout.labels,total:data.totalAllSeconds,startAngle:START_ANGLE,expandedIds:expandedParentIds,jointRadius:c.parentOuterRadius,outerBoundary:c.childOuterRadius,r:(c.parentInnerRadius+c.parentOuterRadius)/2,line:c.parentRingWidth,outerR:(c.parentOuterRadius+c.childOuterRadius)/2,outerLine:c.childRingWidth};
}
function hitTestChart(layout, x, y) {
  const c = layout.config, dx = x - c.cx, dy = y - c.cy, radius = Math.hypot(dx, dy);
  let angle = Math.atan2(dy, dx); while (angle < START_ANGLE) angle += TWO_PI; while (angle >= START_ANGLE + TWO_PI) angle -= TWO_PI;
  if (radius < c.parentInnerRadius) return { type: 'center' };
  const sectors = radius <= c.parentOuterRadius ? layout.parentSectors : radius <= c.childOuterRadius ? layout.childSectors.concat(layout.retracting||[]) : layout.grandchildSectors||[];
  const s = sectors.find(item => radius>=item.innerRadius&&radius<=item.outerRadius&&angle >= item.startAngle && angle < item.endAngle);
  if (s) return { type: s.type, sector: s };
  const label = layout.computedCallouts.find(l => x >= l.bounds.x && x <= l.bounds.x + l.bounds.width && y >= l.bounds.y && y <= l.bounds.y + l.bounds.height);
  if(label)return {type:label.type,sector:label};
  const point=[x,y],leader=layout.computedCallouts.find(l=>routeSegments(l.points).some(([a,b])=>segmentDistance(point,a,b)<=Math.max(3,l.lineWidth/2))||Math.hypot(x-l.p3[0],y-l.p3[1])<=l.dotRadius+2);
  return leader?{type:leader.type,sector:leader}:{type:'outside'};
}
const TOLERANCE = 1e-7;
// 多级树数据规整：ID/时长规整；子项合计不足父项时补"未细分"虚拟叶子并继承色板；
// 子项合计超出父项视为数据异常，降级为叶子不再向下展开。
function prepareNode(node) {
  const n = Object.assign({}, node, { duration: Number(node.duration === undefined ? node.seconds : node.duration) });
  n.id = String(n.id === undefined ? n.projectId : n.id);
  let kids = Array.isArray(n.children) ? n.children.map(prepareNode).filter(c => c.duration > 0) : [];
  if (!kids.length) return Object.assign(n, { children: [] });
  const tolerance = Math.max(TOLERANCE, n.duration * TOLERANCE);
  const sum = kids.reduce((a, c) => a + c.duration, 0);
  if (sum > n.duration + tolerance) return Object.assign(n, { children: [], dataIssue: true });
  const remainder = n.duration - sum;
  if (remainder > tolerance) kids.push({ id: n.id + '__unallocated', name: '未细分', duration: remainder, color: childColor(n.color, kids.length, kids.length + 1, true), virtual: true, children: [] });
  else if (kids.length && Math.abs(remainder) <= tolerance) {
    const largest = kids.reduce((best, c, i) => c.duration > kids[best].duration ? i : best, 0);
    kids[largest] = Object.assign({}, kids[largest], { duration: kids[largest].duration + remainder });
  }
  kids = kids.map((c, i) => Object.assign({}, c, { parentId: n.id, color: c.color || childColor(n.color, i, kids.length, c.virtual) }));
  return Object.assign(n, { children: kids });
}
function computeMultiDepthLayout({tree=[],width,availableHeight,measureText=estimateTextWidth,previousLayout}={}) {
  const roots=tree.filter(n=>Number(n.duration)>0).map(prepareNode),total=roots.reduce((n,row)=>n+row.duration,0);
  if(!total)throw Error('EMPTY_MULTI_DEPTH_CHART');
  const depthOf=node=>1+Math.max(0,...(node.children||[]).filter(c=>c.duration>0).map(depthOf));
  const depth=Math.max(...roots.map(depthOf)),c=createLayoutConfig(width);
  // 外环贴近卡片可用宽度；全屏画布按比例缩放适配，可用高度不硬性压小圆环
  const outer=Math.min(width*.32,width/2-c.leftLineStartX-8),inner=outer*.32;
  const weights=Array.from({length:depth},(_,index)=>Math.max(.35,1.15-index*.10));
  const weightSum=weights.reduce((n,value)=>n+value,0),ringBounds=[inner];
  weights.forEach(weight=>ringBounds.push(ringBounds[ringBounds.length-1]+(outer-inner)*weight/weightSum));
  c.parentInnerRadius=inner;c.parentOuterRadius=ringBounds[1];c.childOuterRadius=ringBounds[2]||ringBounds[1];
  c.grandchildOuterRadius=outer;c.parentRingWidth=c.parentOuterRadius-inner;c.childRingWidth=c.childOuterRadius-c.parentOuterRadius;
  c.ringBounds=ringBounds;c.multiDepth=true;

  const sectorsByDepth=Array.from({length:depth},()=>[]),leaves=[];
  function addNode(node,start,end,level,parent){
    const item={id:String(node.id),projectId:String(node.id),name:node.name,duration:Number(node.duration),color:node.color||'#55794e',virtual:!!node.virtual};
    const s=sector(item,level===0?'parent':'child',start,end,ringBounds[level],ringBounds[level+1],total,parent,c,measureText);
    s.depth=level;sectorsByDepth[level].push(s);
    const children=(node.children||[]).filter(child=>Number(child.duration)>0);
    if(!children.length||level+1>=depth){leaves.push(s);return;}
    const prepared=ensureUnallocatedChild({...item,children:children.map(child=>({id:String(child.id),name:child.name,duration:Number(child.duration),color:child.color})),hasRealChildren:true},[],()=>{});
    if(!prepared.canExpand){leaves.push(s);return;}
    const childById=new Map(children.map(child=>[String(child.id),child]));let elapsed=0;
    prepared.effectiveChildren.forEach((child,index)=>{
      const childStart=start+(end-start)*elapsed/item.duration;elapsed+=child.duration;
      const childEnd=index===prepared.effectiveChildren.length-1?end:start+(end-start)*elapsed/item.duration;
      addNode(childById.get(child.id)||{...child,children:[]},childStart,childEnd,level+1,{id:item.id,duration:item.duration});
    });
  }
  let elapsed=0;
  roots.forEach((root,index)=>{const start=START_ANGLE+TWO_PI*elapsed/total;elapsed+=root.duration;
    addNode(root,start,index===roots.length-1?START_ANGLE+TWO_PI:START_ANGLE+TWO_PI*elapsed/total,0,null);});
  const ordered=leaves.slice().sort((a,b)=>{
    const dy=Math.sin(a.midAngle)*a.outerRadius-Math.sin(b.midAngle)*b.outerRadius;
    if(Math.abs(dy)>1e-7)return dy;
    const ax=Math.cos(a.midAngle)*a.outerRadius,bx=Math.cos(b.midAngle)*b.outerRadius;
    return ax>=0&&bx>=0?ax-bx:bx-ax;
  });
  const callouts=ordered.filter(s=>s.globalRatio>=MIN_CALLOUT_RATIO).map((s,stableOrder)=>Object.assign({},s,{stableOrder,anchorRadius:s.outerRadius<outer?outer:s.outerRadius,
    showNameInCallout:!s.showInsideName||s.insideName!==s.name}));
  const laidOut=layoutCompactCallouts(callouts,c,measureText,sectorsByDepth[1]||[],sectorsByDepth[0],previousLayout,sectorsByDepth.slice(2).flat());
  const final=laidOut.config,leader=laidOut.pages[0],withPath=s=>Object.assign({},s,{path:createDonutSectorPath(final.cx,final.cy,s.innerRadius,s.outerRadius,s.startAngle,s.endAngle)});
  const rings=sectorsByDepth.map(items=>items.map(withPath));
  return {engine:'compact-sides',runtime:{layout:'donut-layout-multi',callout:'callout-layout-compact',renderer:'donut-renderer-compact'},
    config:final,tree,depth,ringBounds,totalAllSeconds:total,parentSectors:rings[0],childSectors:rings[1]||[],grandchildSectors:rings.slice(2).flat(),
    sectorsByDepth:rings,computedCallouts:leader.labels,calloutPages:laidOut.pages,leaderLayout:leader,expandedParentIds:roots.map(n=>String(n.id)),
    centerLines:[compactDuration(total),roots.length+'个科目',leaves.length+'个末级'],
    selectedParentId:'',selectedChildId:'',selectedProjectId:'',width:leader.width,height:leader.height,viewportHeight:leader.height,scrollable:false};
}
function hitTestMulti(layout,x,y){return hitTestChart(layout,x,y);}
module.exports = { LAYOUT_DEFAULTS, SHORT_NAMES, START_ANGLE, TWO_PI, createLayoutConfig, polarToCartesian, createDonutSectorPath, estimateTextWidth, shouldRenderSectorName, shouldRenderSectorNameAt, shouldRenderSectorNameAtR, findSectorNameAngle, sector, computeParentSectors, computeChildSectors, computeVisibleCallouts, computeDonutLayout, computeMultiDepthLayout, hitTestMulti, hitTestChart, wrapText };


