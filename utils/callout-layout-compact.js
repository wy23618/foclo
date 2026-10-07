const {compactDuration}=require('./donut-data');
const {segmentsIntersect,segmentHitsBox,segmentHitsSector,routeSegments}=require('./callout-geometry-v2');
const EPS=1e-7,TAU=Math.PI*2,TOP=-Math.PI/2;
const mod=a=>(a%TAU+TAU)%TAU;
function naturalSide(angle){return Math.cos(angle)>=-EPS?1:-1;}
function buildVisibleCallouts(parents,children,expanded){
  return parents.flatMap(p=>expanded.includes(p.projectId)&&p.canExpand?children.filter(s=>s.parentId===p.projectId):[p])
    .map((s,stableOrder)=>Object.assign({},s,{anchorRadius:s.outerRadius,stableOrder,showNameInCallout:!s.showInsideName||s.insideName!==s.name}));
}
function fitText(text,width,font,measure){
  if(measure(text,font,'400')<=width)return text;
  const chars=Array.from(text);while(chars.length&&measure(chars.join('')+'…',font,'400')>width)chars.pop();return chars.join('')+'…';
}
function wrap(text,width,font,measure){
  const lines=[];let line='';
  for(const ch of Array.from(text)){if(line&&measure(line+ch,font,'400')>width){lines.push(line);line='';}line+=ch;}
  if(line)lines.push(line);return lines;
}
function sideAt(angle,boundaries){
  const theta=mod(angle-TOP-boundaries.top),span=Math.PI+boundaries.bottom-boundaries.top;
  // Exact natural poles belong to the right; shifted boundaries are half-open.
  if(Math.abs(boundaries.top)<EPS&&Math.abs(boundaries.bottom)<EPS)return naturalSide(angle);
  return theta<span-EPS?1:-1;
}
function angleOrder(angle,side,boundaries){return side>0?mod(angle-TOP-boundaries.top):mod(TOP+boundaries.top-angle);}
function boundaryCandidates(raw,c,previous){
  const natural={top:0,bottom:0},result=[natural],band=c.crossSideBand*Math.PI/180;
  const counts=[-1,1].map(side=>raw.filter(s=>naturalSide(s.midAngle)===side).length);
  const crowded=Math.max(...counts)>=8&&Math.max(...counts)>Math.min(...counts)*1.6;
  // A fixed three-label cap cannot move a four-child family, even with an
  // empty opposite column. Search longer contiguous pole prefixes only when
  // the natural columns are markedly uneven; keep the same angular band.
  const maxMoves=crowded?Math.min(c.maxSideCandidates,raw.length):c.maxBoundaryMoves;
  const byParent=new Map();
  raw.filter(s=>s.type==='child').forEach(s=>{if(!byParent.has(s.parentId))byParent.set(s.parentId,[]);byParent.get(s.parentId).push(s);});
  const homogeneousFamilies=[...byParent.values()].filter(items=>items.length>1&&items.every(s=>naturalSide(s.midAngle)===naturalSide(items[0].midAngle)));
  const splitFamilies=[...byParent.values()].filter(items=>items.length>1&&!items.every(s=>naturalSide(s.midAngle)===naturalSide(items[0].midAngle)));
  const add=b=>{if(Math.abs(b.top)<=band+EPS&&Math.abs(b.bottom)<=band+EPS&&!result.some(p=>Math.abs(p.top-b.top)<EPS&&Math.abs(p.bottom-b.bottom)<EPS))result.push(b);};
  if(previous&&previous.sideBoundaries)add(previous.sideBoundaries);
  // Move only consecutive prefixes adjacent to a pole, never disconnected
  // items in the middle of a side. Never redistribute across the circle.
  const shifts={top:[],bottom:[]},firstShifts={top:[],bottom:[]};
  for(const pole of ['top','bottom'])for(const direction of [-1,1]){
    const center=pole==='top'?TOP:Math.PI/2;
    const distances=raw.map(s=>mod(s.midAngle-center+Math.PI)-Math.PI)
      .filter(d=>d*direction>EPS&&Math.abs(d)<band).sort((a,b)=>Math.abs(a)-Math.abs(b));
    for(let i=0;i<Math.min(maxMoves,distances.length);i++){
      const next=i+1<distances.length?Math.abs(distances[i+1]):band;
      const shift=direction*(Math.abs(distances[i])+Math.min(.001,(next-Math.abs(distances[i]))/2));
      if(i===0)firstShifts[pole].push(shift);
      shifts[pole].push(shift);add(Object.assign({},natural,{[pole]:shift}));
    }
  }
  for(const top of firstShifts.top)for(const bottom of firstShifts.bottom)add({top,bottom});
  // Grouping at the bottom may need the already-helpful top adjustment too.
  // Reserve search slots for these combinations instead of judging a family
  // move only with the other pole reset to its natural position.
  const grouped=[];
  for(const top of [0,...shifts.top])for(const bottom of [0,...shifts.bottom]){
    const b={top,bottom};
    if(splitFamilies.some(items=>items.every(s=>sideAt(s.midAngle,b)===sideAt(items[0].midAngle,b)))&&
      homogeneousFamilies.every(items=>items.every(s=>sideAt(s.midAngle,b)===sideAt(items[0].midAngle,b))))grouped.push(b);
  }
  grouped.sort((a,b)=>Math.abs(a.top)+Math.abs(a.bottom)-Math.abs(b.top)-Math.abs(b.bottom));
  // A parent whose visible children naturally share one side must not have a
  // single near-pole child peeled away. Moving the whole adjacent group is
  // still permitted when it fits the bounded pole search.
  const candidates=result.filter(b=>homogeneousFamilies.every(items=>items.every(s=>sideAt(s.midAngle,b)===sideAt(items[0].midAngle,b)))).slice(0,c.maxSideCandidates);
  for(const b of grouped){
    if(candidates.length>=c.maxSideCandidates+6)break;
    if(!candidates.some(p=>Math.abs(p.top-b.top)<EPS&&Math.abs(p.bottom-b.bottom)<EPS))candidates.push(b);
  }
  return candidates;
}
function prepareRows(raw,c,measure){
  return raw.map(s=>{
    const labelWidth=s.labelWidth||c.labelWidth;
    const time=compactDuration(s.duration),showName=true,showPercent=parseFloat(s.globalPercent)>0;
    const belowFont=c.auxiliaryFontSize;
    const semantic=s.shortName||(c.shortNames||{})[s.name]||Object.keys(c.shortNames||{}).filter(name=>s.name.startsWith(name)).map(name=>c.shortNames[name])[0]||s.name;
    let shownName=fitText(semantic,labelWidth,belowFont,measure);
    if(showName&&!shownName||showName&&shownName==='…')shownName=Array.from(semantic)[0]||'项';
    const belowText=shownName;
    const belowLines=wrap(belowText,labelWidth,belowFont,measure),belowLineHeight=belowFont+1;
    let globalFont=c.calloutFontSize,durationFont=Math.max(10,belowFont+1);
    const textRunGap=showPercent?c.textRunGap:0,readableFont=Math.min(9,belowFont);
    let globalWidth=showPercent?measure(s.globalPercent,globalFont,'600'):0,durationWidth=measure(time,durationFont,'600');
    while(globalWidth+textRunGap+durationWidth>labelWidth&&globalFont>readableFont){globalFont=Math.max(readableFont,globalFont-.25);globalWidth=showPercent?measure(s.globalPercent,globalFont,'600'):0;}
    while(globalWidth+textRunGap+durationWidth>labelWidth&&durationFont>10){durationFont=Math.max(10,durationFont-.25);durationWidth=measure(time,durationFont,'600');}
    const stackedAbove=showPercent&&globalWidth+textRunGap+durationWidth>labelWidth;
    const aboveExtent=c.lineTextGap+(stackedAbove?globalFont+durationFont+2:Math.max(showPercent?globalFont:0,durationFont)),belowExtent=c.lineTextGap+belowLines.length*belowLineHeight;
    return Object.assign({},s,{labelWidth,fullBelow:semantic,belowText,belowLines,belowLineHeight,belowFont,abbreviated:shownName!==semantic,
      time,showPercent,textRunGap,stackedAbove,durationFont,durationWidth,globalFont,globalWidth,aboveExtent,belowExtent,labelHeight:aboveExtent+belowExtent});
  });
}
// Bounded isotonic regression preserves circular order while spreading labels.
// Solve around cy=0, then translate once to the actual content bounds.
function placeSide(rows,c,promoted,blend){
  let offset=0;
  rows.forEach((r,i)=>{
    if(i)offset+=rows[i-1].belowExtent+c.minLabelGap+r.aboveExtent;
    r.offset=offset;r.lower=-Infinity;r.upper=Infinity;
    const cos=Math.cos(r.midAngle),sin=Math.sin(r.midAngle),radius=promoted.has(r.id)?c.activeOuterRadius:r.outerRadius;
    const x=r.side<0?c.chartPadding+r.labelWidth+c.textGap:c.width-c.chartPadding-r.labelWidth-c.textGap;
    r.desiredY=sin*r.outerRadius;r.preferredY=sin*(r.outerRadius+(c.activeOuterRadius-r.outerRadius)*Math.min(blend,1));
    // Only actual obstructions promote the tangent constraint to the outer
    // circle. There is no uniform diagonal angle or length limit.
    const tangentY=sin*radius-(x-c.cx-cos*radius)*cos/(sin||EPS);
    if(blend!==2){if(sin>EPS)r.lower=tangentY;else if(sin<-EPS)r.upper=tangentY;}
  });
  const blocks=[];
  function solve(block){
    block.low=Math.max(...block.rows.map(r=>r.lower-r.offset));block.high=Math.min(...block.rows.map(r=>r.upper-r.offset));
    if(block.low>block.high+EPS)throw Error('COMPACT_ANGLE_CAPACITY');
    block.value=Math.max(block.low,Math.min(block.high,block.rows.reduce((n,r)=>n+r.preferredY-r.offset,0)/block.rows.length));
  }
  for(const row of rows){const block={rows:[row]};solve(block);blocks.push(block);
    while(blocks.length>1&&blocks[blocks.length-2].value>blocks[blocks.length-1].value){const right=blocks.pop(),left=blocks.pop(),merged={rows:left.rows.concat(right.rows)};solve(merged);blocks.push(merged);}}
  blocks.forEach(block=>block.rows.forEach(r=>r.baselineY=block.value+r.offset));
}
function hitsInk(a,b,c){return c.occupiedSectors.some(s=>segmentHitsSector(a,b,s,c));}
function chooseRoute(r,c){
  const cos=Math.cos(r.midAngle),sin=Math.sin(r.midAngle),p0=[c.cx+cos*r.outerRadius,c.cy+sin*r.outerRadius];
  const p2=[r.side<0?c.chartPadding+r.labelWidth+c.textGap:c.width-c.chartPadding-r.labelWidth-c.textGap,r.baselineY],p3=[r.side<0?c.leftLineEndX:c.rightLineEndX,r.baselineY];
  const at=radius=>[c.cx+cos*radius,c.cy+sin*radius];
  if(r.anchorRadius>r.outerRadius+EPS){
    const p1=at(r.anchorRadius);
    if(!hitsInk(p0,p1,c)&&!hitsInk(p1,p2,c))return {p0,p1,p2,p3,points:[p0,p1,p2,p3],segmentCount:3,exitRadius:r.anchorRadius};
  }
  if(!hitsInk(p0,p2,c))return {p0,p1:p0,p2,p3,points:[p0,p0,p2,p3],segmentCount:2,exitRadius:r.outerRadius};
  let low=r.outerRadius,high=c.activeOuterRadius;
  const limit=Math.min(c.activeOuterRadius+c.width*.12,(c.width/2-c.chartPadding-1)/Math.max(EPS,Math.abs(cos)));
  while(hitsInk(at(high),p2,c)&&high<limit)high=Math.min(limit,high+4);
  if(hitsInk(at(high),p2,c))return null;
  // Find the smallest safe exit for this endpoint to subpixel accuracy.
  for(let i=0;i<22;i++){const mid=(low+high)/2;if(hitsInk(at(mid),p2,c))low=mid;else high=mid;}
  const p1=at(high);
  if(hitsInk(p0,p1,c)||hitsInk(p1,p2,c))return null;
  return {p0,p1,p2,p3,points:[p0,p1,p2,p3],segmentCount:3,exitRadius:high};
}
function makeLabel(r,c,route){
  const x=r.side<0?c.chartPadding:c.width-c.chartPadding-r.labelWidth,edge=r.side<0?x:x+r.labelWidth,y=r.baselineY,textRuns=[];
  const align=r.side<0?'left':'right',lineWidth=r.type==='child'?c.childLineWidth:c.parentLineWidth;
  const aboveWidth=r.globalWidth+r.textRunGap+r.durationWidth,start=r.side<0?edge:edge-aboveWidth;
  const aboveY=y-c.lineTextGap-Math.max(r.showPercent?r.globalFont:0,r.durationFont)/2;
  if(r.stackedAbove){
    textRuns.push({kind:'global',text:r.globalPercent,x:edge,y:y-c.lineTextGap-r.durationFont-2-r.globalFont/2,fontSize:r.globalFont,weight:'600',align,width:r.globalWidth});
    textRuns.push({kind:'duration',text:r.time,x:edge,y:y-c.lineTextGap-r.durationFont/2,fontSize:r.durationFont,weight:'600',align,width:r.durationWidth});
  }else{
    if(r.showPercent)textRuns.push({kind:'global',text:r.globalPercent,x:start,y:aboveY,fontSize:r.globalFont,weight:'600',align:'left',width:r.globalWidth});
    textRuns.push({kind:'duration',text:r.time,x:start+r.globalWidth+r.textRunGap,y:aboveY,fontSize:r.durationFont,weight:'600',align:'left',width:r.durationWidth});
  }
  r.belowLines.forEach((text,i)=>textRuns.push({kind:'name',text,x:edge,y:y+c.lineTextGap+r.belowLineHeight*i+r.belowFont/2,fontSize:r.belowFont,weight:'700',align,width:c.measure(text,r.belowFont,'700')}));
  const bounds={x,y:y-r.aboveExtent,width:r.labelWidth,height:r.labelHeight};
  const textBoxes=textRuns.map(run=>({x:run.align==='right'?run.x-run.width:run.x,y:run.y-run.fontSize/2,width:run.width,height:run.fontSize}));
  const diagonalLength=Math.hypot(route.p2[0]-route.p1[0],route.p2[1]-route.p1[1]),horizontalLength=Math.abs(route.p3[0]-route.p2[0]);
  return Object.assign({},r,route,{anchor:route.p0,ringAnchor:route.p0,anchorY:route.p0[1],radialExit:route.p1,
    bounds,textBoxes,textRuns,lineWidth,dotRadius:c.dotRadius,dotFilled:r.type!=='child',dotCenter:route.p3,
    baselineY:y,labelY:y,targetY:y,textX:x,above:textRuns.filter(run=>run.kind!=='name'),below:textRuns.filter(run=>run.kind==='name'),lines:textRuns,
    verticalDisplacement:Math.abs(y-r.desiredY),diagonalLength,horizontalLength,totalLeaderLength:diagonalLength+horizontalLength+Math.hypot(route.p1[0]-route.p0[0],route.p1[1]-route.p0[1])});
}
function inflate(box,padding){return {x:box.x-padding,y:box.y-padding,width:box.width+2*padding,height:box.height+2*padding};}
function validateCompactLayout(layout){
  const errors=[],crossings=[],sectorIntrusions=[],{labels,config:c}=layout;
  const routes=labels.map(l=>routeSegments(l.points));
  labels.forEach((a,i)=>{
    const box=a.bounds,segments=routes[i],stroke=a.lineWidth/2;
    if(![box.x,box.y,box.width,box.height,...a.points.flat()].every(Number.isFinite))errors.push('nonfinite:'+a.id);
    if(box.x<-EPS||box.y<-EPS||box.x+box.width>layout.width+EPS||box.y+box.height>layout.height+EPS)errors.push('label-bounds:'+a.id);
    if(a.segmentCount>1&&a.p2[1]!==a.p3[1])errors.push('nonhorizontal:'+a.id);
    if(segments.length!==a.segmentCount||segments.length<1||segments.length>3)errors.push('segment-count:'+a.id);
    if(Math.abs(Math.hypot(a.p0[0]-c.cx,a.p0[1]-c.cy)-a.outerRadius)>EPS)errors.push('anchor-edge:'+a.id);
    for(const p of a.points)if(p[0]-stroke<-EPS||p[0]+stroke>layout.width+EPS||p[1]-stroke<-EPS||p[1]+stroke>layout.height+EPS)errors.push('line-bounds:'+a.id);
    const dot=a.dotRadius+stroke;
    if(a.p3[0]-dot<-EPS||a.p3[0]+dot>layout.width+EPS||a.p3[1]-dot<-EPS||a.p3[1]+dot>layout.height+EPS)errors.push('dot-bounds:'+a.id);
    for(const run of a.textRuns){const left=run.align==='right'?run.x-run.width:run.x;if(left<box.x-EPS||left+run.width>box.x+box.width+EPS)errors.push('text-bounds:'+a.id);}
    // Expanded text columns must also stay outside the colored circle.
    const closestY=box.y>c.cy?box.y-c.cy:box.y+box.height<c.cy?c.cy-box.y-box.height:0;
    const innerX=a.side<0?box.x+box.width:box.x;
    if(Math.hypot(innerX-c.cx,closestY)<c.activeOuterRadius+1-EPS)errors.push('text-sector:'+a.id);
    if((c.occupiedSectors||c.occupiedChildSectors||[]).some(s=>segments.some(([u,v])=>segmentHitsSector(u,v,s,c)))){errors.push('sector-intrusion:'+a.id);sectorIntrusions.push(a.id);}
    for(const b of labels)for(const textBox of b.textBoxes){
      if(segments.some(([u,v])=>segmentHitsBox(u,v,inflate(textBox,stroke))))errors.push('line-text:'+a.id+':'+b.id);
      const closest=[Math.max(textBox.x,Math.min(textBox.x+textBox.width,a.p3[0])),Math.max(textBox.y,Math.min(textBox.y+textBox.height,a.p3[1]))];
      if(Math.hypot(closest[0]-a.p3[0],closest[1]-a.p3[1])<dot-EPS)errors.push('dot-text:'+a.id+':'+b.id);
    }
    for(let j=i+1;j<labels.length;j++){const b=labels[j];
      if(box.x<b.bounds.x+b.bounds.width-EPS&&box.x+box.width>b.bounds.x+EPS&&box.y<b.bounds.y+b.bounds.height-EPS&&box.y+box.height>b.bounds.y+EPS)errors.push('label-overlap:'+a.id+':'+b.id);
      if(segments.some(([u,v])=>routes[j].some(([w,z])=>segmentsIntersect(u,v,w,z))))crossings.push([a.id,b.id]);
    }
  });
  for(const side of [-1,1]){const rows=labels.filter(r=>r.side===side);rows.forEach((r,i)=>{
    if(i&&(r.angularOrder<rows[i-1].angularOrder-EPS||r.bounds.y<rows[i-1].bounds.y+rows[i-1].bounds.height+c.minLabelGap-EPS))errors.push('label-order:'+r.id);
    if(r.side!==sideAt(r.midAngle,layout.sideBoundaries))errors.push('side-interval:'+r.id);
  });}
  return {valid:!errors.length,errors,crossingCount:crossings.length,crossings,sectorIntrusions};
}
function solveOnce(templates,first,boundaries,blend,allowColumnRetry=false){
  const promoted=new Set();
  let best=null;
  for(let pass=0;pass<5;pass++){
    try{
    const c=Object.assign({},first,{cy:0}),rows=templates.map(s=>{
      const side=sideAt(s.midAngle,boundaries);return Object.assign({},s,{side,naturalSide:naturalSide(s.midAngle),angularOrder:angleOrder(s.midAngle,side,boundaries),
        anchorRadius:promoted.has(s.id)?Math.max(s.anchorRadius||s.outerRadius,c.activeOuterRadius):s.anchorRadius});
    }),sides=[-1,1].map(side=>rows.filter(s=>s.side===side).sort((a,b)=>a.angularOrder-b.angularOrder||a.stableOrder-b.stableOrder||a.id.localeCompare(b.id)));
    sides.forEach(side=>placeSide(side,c,promoted,blend));
    const top=Math.min(-c.activeOuterRadius,...rows.map(r=>r.baselineY-r.aboveExtent));
    const bottom=Math.max(c.activeOuterRadius,...rows.map(r=>r.baselineY+r.belowExtent));
    c.cy=c.chartPadding-top;c.baseChartHeight=bottom-top+2*c.chartPadding;
    if(c.baseChartHeight>c.maxDrawingHeight)throw Error('COMPACT_DRAWING_CAPACITY');
    c.occupiedSectors=first.occupiedSectors;c.calloutBandTop=c.chartPadding;c.calloutBandBottom=c.baseChartHeight-c.chartPadding;
    rows.forEach(r=>{r.baselineY+=c.cy;r.desiredY+=c.cy;});
    const routed=sides.flat().map(r=>({row:r,route:chooseRoute(r,c)})),failed=routed.filter(s=>!s.route);
    if(failed.length){failed.forEach(s=>promoted.add(s.row.id));continue;}
    // Radial escape points may extend beyond the provisional label bounds.
    // Include them before validating or allocating the actual Canvas.
    const minRoute=Math.min(c.chartPadding,...routed.flatMap(s=>s.route.points.map(p=>p[1]-c.parentLineWidth/2)));
    const maxRoute=Math.max(c.baseChartHeight-c.chartPadding,...routed.flatMap(s=>s.route.points.map(p=>p[1]+c.parentLineWidth/2)));
    const shift=c.chartPadding-minRoute;c.cy+=shift;c.baseChartHeight=maxRoute-minRoute+2*c.chartPadding;
    routed.forEach(s=>{s.row.baselineY+=shift;s.row.desiredY+=shift;const points=s.route.points.map(p=>[p[0],p[1]+shift]);Object.assign(s.route,{points,p0:points[0],p1:points[1],p2:points[2],p3:points[3]});});
    const labels=routed.map(s=>makeLabel(s.row,c,s.route)),layout={engine:'compact-sides',labels,config:c,width:c.width,height:c.baseChartHeight,
      centerX:c.cx,centerY:c.cy,minLabelGap:c.minLabelGap,sideBoundaries:boundaries,strategy:'angle-compact'};
    layout.validation=validateCompactLayout(layout);
    if(!layout.validation.valid&&(!allowColumnRetry||layout.validation.errors.some(e=>!['text-sector:','line-text:','sector-intrusion:','dot-text:'].some(prefix=>e.startsWith(prefix)))))throw Error('COMPACT_LAYOUT_INVALID: '+layout.validation.errors.join(','));
    if(layout.validation.valid){
      if(!best||layout.validation.crossingCount<best.validation.crossingCount)best=layout;
      // Different ring depths can make one diagonal cut across a neighbour's
      // radial exit even though the labels retain their correct angular order.
      // Only those crossed routes retry at the common outer-circle clearance;
      // sector geometry, side assignment and label order remain unchanged.
      let retry=false;
      for(const pair of layout.validation.crossings)for(const id of pair){
        if(!promoted.has(id)){promoted.add(id);retry=true;}
      }
      if(retry)continue;
      return best;
    }
    return layout;
    }catch(e){
      // A local repair must never discard a previously valid drawing when
      // the extra outer clearance cannot fit this candidate's label column.
      if(best&&/^COMPACT_/.test(e.message))return best;
      throw e;
    }
  }
  if(best)return best;
  throw Error('COMPACT_ROUTE_CAPACITY');
}
function safeColumn(row,c){
  const box=row.bounds,nearest=box.y>c.cy?box.y-c.cy:box.y+box.height<c.cy?c.cy-box.y-box.height:0;
  const extent=Math.sqrt(Math.max(0,(c.activeOuterRadius+2)**2-nearest**2));
  // Put as much of the leader as possible on the horizontal text line. The
  // actual route and all text/sector intersections are checked after moving
  // this elbow, so a crowded row can fall back to its narrower safe column.
  return Math.max(c.labelWidth,Math.min(c.width*.26,c.cx-extent-c.chartPadding-c.textGap-1));
}
function solveCandidate(templates,first,boundaries,blend,initial){
  let best=initial||solveOnce(templates,first,boundaries,blend),current=best;
  // Reuse top/bottom whitespace while keeping the short leaders gentle.
  // Widths follow the circle, with bounded refinements and a safe fallback.
  const widths=new Map(current.labels.map(r=>[r.id,safeColumn(r,current.config)]));
  for(let step=0;step<3;step++){
    const rows=prepareRows(templates.map(r=>Object.assign({},r,{labelWidth:widths.get(r.id)})),first,first.measure);
    let next;try{next=solveOnce(rows,first,boundaries,blend,true);}catch(e){if(!/^COMPACT_/.test(e.message))throw e;break;}
    if(next.validation.valid){const a=quality(next),b=quality(best);if(a.crossings<b.crossings||a.crossings===b.crossings&&a.score<b.score)best=next;}
    let changed=false;
    next.labels.forEach(r=>{const safe=safeColumn(r,next.config),old=widths.get(r.id);if(safe<old-EPS){widths.set(r.id,safe);changed=true;}});
    // Wide top/bottom columns can introduce crossings between a horizontal
    // underline and a neighbour's diagonal. Trim only the offending column
    // to that actual intersection and solve positions again, keeping order.
    for(const [aId,bId] of next.validation.crossings){
      const a=next.labels.find(r=>r.id===aId),b=next.labels.find(r=>r.id===bId);let repaired=false;
      for(const [row,other] of [[a,b],[b,a]])for(const [u,v] of routeSegments(other.points)){
        if(Math.abs(v[1]-u[1])<EPS||!segmentsIntersect(row.p2,row.p3,u,v))continue;
        const t=(row.baselineY-u[1])/(v[1]-u[1]),x=u[0]+t*(v[0]-u[0]);
        const limit=Math.max(first.labelWidth,(row.side<0?x:first.width-x)-first.chartPadding-first.textGap-1);
        if(limit<widths.get(row.id)-EPS){widths.set(row.id,limit);changed=true;repaired=true;}
      }
      if(!repaired)for(const row of [a,b]){const old=widths.get(row.id),small=first.labelWidth+(old-first.labelWidth)*.5;if(small<old-.1){widths.set(row.id,small);changed=true;}}
    }
    current=next;if(!changed)break;
  }
  return best;
}
function quality(layout,previous){
  const rows=layout.labels,width=layout.width,c=layout.config,old=new Map(previous?previous.labels.map(s=>[s.id,s.side]):[]);
  const maxDiagonal=Math.max(0,...rows.map(s=>s.diagonalLength)),totalDiagonal=rows.reduce((n,s)=>n+s.diagonalLength,0),maxOffset=Math.max(0,...rows.map(s=>s.verticalDisplacement));
  const sideChanges=rows.filter(s=>old.has(s.id)&&old.get(s.id)!==s.side).length,crossSide=rows.filter(s=>s.side!==s.naturalSide).length;
  const sideLoads=[-1,1].map(side=>rows.filter(r=>r.side===side).reduce((sum,r)=>sum+r.labelHeight+c.minLabelGap,0));
  const peakLoad=Math.max(...sideLoads),freeLoad=Math.min(...sideLoads),diameter=c.activeOuterRadius*2;
  // Penalize excess occupied label height, not just unequal item counts.
  // Empty space on one side matters only when the other exceeds the circle.
  const densityPenalty=Math.max(0,peakLoad-Math.max(diameter*1.1,freeLoad*1.5))/width*.3;
  const families=new Map();
  rows.filter(r=>r.type==='child').forEach(r=>{
    if(!families.has(r.parentId))families.set(r.parentId,[]);
    families.get(r.parentId).push(r);
  });
  let familySplits=0,familyPenalty=0;
  for(const items of families.values()){
    if(items.length<2)continue;
    const left=items.filter(r=>r.side<0).length,right=items.length-left;
    if(left&&right){familySplits++;familyPenalty+=Math.min(left,right)*.12;}
    // Prefer the side containing most of the family's actual sector area,
    // rather than moving a large child to follow two tiny boundary children.
    const naturalWeight=items.reduce((n,r)=>n+r.naturalSide*r.duration,0);
    const preferred=naturalWeight>=0?1:-1,total=items.reduce((n,r)=>n+r.duration,0);
    familyPenalty+=items.filter(r=>r.side!==preferred).reduce((n,r)=>n+r.duration,0)/total*.08;
  }
  return {crossings:layout.validation.crossingCount,maxDiagonal,totalDiagonal,maxOffset,sideChanges,crossSide,familySplits,familyPenalty,sideLoads,densityPenalty,
    score:2*maxDiagonal/width+totalDiagonal/(width*Math.max(1,rows.length))+maxOffset/width*.35+layout.height/width*.08+sideChanges*.04+crossSide*.012+densityPenalty};
}
function shortlistBoundaries(templates,c,boundaries,previous){
  if(boundaries.length<=7||templates.length<=12)return boundaries;
  const ranked=boundaries.map(b=>{
    const rows=templates.map(r=>Object.assign({},r,{side:sideAt(r.midAngle,b),angularOrder:angleOrder(r.midAngle,sideAt(r.midAngle,b),b)}));
    const sides=[-1,1].map(side=>rows.filter(r=>r.side===side).sort((a,z)=>a.angularOrder-z.angularOrder||a.stableOrder-z.stableOrder));
    sides.forEach(side=>placeSide(side,c,new Set(),2));
    const displacement=Math.max(0,...rows.map(r=>Math.abs(r.baselineY-r.desiredY)));
    const top=Math.min(-c.activeOuterRadius,...rows.map(r=>r.baselineY-r.aboveExtent));
    const bottom=Math.max(c.activeOuterRadius,...rows.map(r=>r.baselineY+r.belowExtent));
    const crossSide=rows.filter(r=>r.side!==naturalSide(r.midAngle)).length;
    return {b,score:displacement/c.width*2.35+(bottom-top)/c.width*.08+crossSide*.012};
  }).sort((a,b)=>a.score-b.score);
  const chosen=new Set(ranked.slice(0,5).map(r=>r.b));
  chosen.add(boundaries[0]);
  if(previous&&previous.sideBoundaries){
    const stable=boundaries.find(b=>Math.abs(b.top-previous.sideBoundaries.top)<EPS&&Math.abs(b.bottom-previous.sideBoundaries.bottom)<EPS);
    if(stable)chosen.add(stable);
  }
  return boundaries.filter(b=>chosen.has(b));
}
function flattenHorizontal(layout){
  const c=layout.config;
  // Small deviations are often caused by the least-squares spacing step.
  // Use the available local slack to make those lines exactly horizontal.
  for(const current of [...layout.labels].sort((a,b)=>Math.abs(a.baselineY-a.anchorY)-Math.abs(b.baselineY-b.anchorY))){
    const dy=Math.abs(current.baselineY-current.anchorY);
    if(dy<=EPS||dy>8)continue;
    const index=layout.labels.findIndex(row=>row.id===current.id);
    const row=Object.assign({},current,{baselineY:current.anchorY});
    const route=chooseRoute(row,c);
    if(!route||route.segmentCount!==2)continue;
    const replacement=makeLabel(row,c,route),oldValidation=layout.validation;
    layout.labels[index]=replacement;
    const checked=validateCompactLayout(layout);
    if(checked.valid&&checked.crossingCount<=oldValidation.crossingCount)layout.validation=checked;
    else layout.labels[index]=current;
  }
}
function minimizeSegments(layout){
  const {labels,config:c}=layout;
  const existing=new Set(layout.validation.crossings.map(pair=>pair.slice().sort().join('|')));
  const routes=labels.map(l=>routeSegments(l.points));
  for(let i=0;i<labels.length;i++){
    const row=labels[i],a=row.p0,b=row.p3;
    // A one-piece route is reserved for a truly horizontal line. A sloped
    // shortcut removes the horizontal underline the user needs to trace.
    if(Math.abs(a[1]-b[1])>EPS)continue;
    if(hitsInk(a,b,c))continue;
    if(labels.some(l=>l.textBoxes.some(box=>segmentHitsBox(a,b,inflate(box,row.lineWidth/2)))))continue;
    if(labels.some((l,j)=>j!==i&&routes[j].some(([u,v])=>segmentsIntersect(a,b,u,v))&&!existing.has([row.id,l.id].sort().join('|'))))continue;
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]),horizontal=Math.abs(b[1]-a[1])<EPS;
    Object.assign(row,{p1:a,p2:a,points:[a,a,a,b],segmentCount:1,radialExit:a,exitRadius:row.outerRadius,
      diagonalLength:horizontal?0:length,horizontalLength:horizontal?length:0,totalLeaderLength:length});
    routes[i]=[[a,b]];
  }
  layout.validation=validateCompactLayout(layout);
}
function layoutCompactCallouts(raw,base,measure,children,parents=[],previous=null,grandchildren=[]){
  const measured=new Map(),cachedMeasure=(text,font,weight)=>{const key=font+'|'+weight+'|'+text;if(!measured.has(key))measured.set(key,measure(text,font,weight));return measured.get(key);};
  // Parent sectors tile a complete annulus. Their union is an exact, faster
  // collision obstacle; expanded children retain their actual angular spans.
  const parentInk=parents.length?[{innerRadius:base.parentInnerRadius,outerRadius:base.parentOuterRadius,startAngle:TOP,endAngle:TOP+TAU}]:[];
  const childInk=[];
  for(const parent of parents){const own=children.filter(s=>s.parentId===parent.projectId);if(own.length)childInk.push({innerRadius:own[0].innerRadius,outerRadius:base.childOuterRadius,startAngle:own[0].startAngle,endAngle:own[own.length-1].endAngle});}
  const grandchildInk=grandchildren.map(s=>({innerRadius:s.innerRadius,outerRadius:s.outerRadius,startAngle:s.startAngle,endAngle:s.endAngle}));
  const first=Object.assign({},base,{activeOuterRadius:grandchildren.length?base.grandchildOuterRadius:children.length?base.childOuterRadius:base.parentOuterRadius,
    occupiedChildSectors:children.concat(grandchildren),occupiedSectors:parentInk.concat(childInk,grandchildInk),measure:cachedMeasure});
  const templates=prepareRows(raw,first,cachedMeasure),allBoundaries=boundaryCandidates(raw,first,previous);
  const boundaries=shortlistBoundaries(templates,first,allBoundaries,previous);
  let evaluated=0,rejected=0;
  const options=[],recipes=new Map();
  const blends=raw.some(r=>r.outerRadius!==first.activeOuterRadius)?[0,1,2]:[0,2];
  function evaluateBoundary(boundary){
    let option=null,optionBlend=0;
    for(const blend of blends){
      let candidate;try{candidate=solveOnce(templates,first,boundary,blend);}catch(e){if(!/^COMPACT_/.test(e.message))throw e;rejected++;continue;}
      evaluated++;candidate.quality=quality(candidate,previous);
      const a=candidate.quality,b=option&&option.quality;
      if(!b||a.crossings<b.crossings||a.crossings===b.crossings&&a.score<b.score-EPS){option=candidate;optionBlend=blend;}
    }
    options.push(option);
    if(option)recipes.set(option,{boundaries:boundary,blend:optionBlend});
  }
  boundaries.forEach(evaluateBoundary);
  // If the fast shortlist cannot produce a crossing-free valid drawing,
  // restore the full bounded search instead of weakening geometric safety.
  if(options.every(o=>!o||o.validation.crossingCount>0)){
    const skipped=allBoundaries.filter(b=>!boundaries.includes(b));
    skipped.forEach(evaluateBoundary);
    boundaries.push(...skipped);
  }
  // All candidate routes still undergo collision validation. Spend the
  // expensive column-width refinements only on the strongest candidates,
  // plus the natural and previous layouts retained as stable fallbacks.
  const ranked=options.filter(Boolean).slice().sort((a,b)=>a.quality.crossings-b.quality.crossings||
    a.quality.score+a.quality.familyPenalty-b.quality.score-b.quality.familyPenalty);
  const finalists=new Set(ranked.slice(0,4));
  if(options[0])finalists.add(options[0]);
  if(previous&&previous.sideBoundaries){
    const stable=options.find(o=>o&&Math.abs(o.sideBoundaries.top-previous.sideBoundaries.top)<EPS&&Math.abs(o.sideBoundaries.bottom-previous.sideBoundaries.bottom)<EPS);
    if(stable)finalists.add(stable);
  }
  for(const initial of finalists){
    const recipe=recipes.get(initial),candidate=solveCandidate(templates,first,recipe.boundaries,recipe.blend,initial);
    candidate.quality=quality(candidate,previous);
    options[options.indexOf(initial)]=candidate;
  }
  const natural=options[0];let best=natural||options.find(Boolean);
  if(previous&&previous.sideBoundaries&&best){
    const stable=options.find(o=>o&&Math.abs(o.sideBoundaries.top-previous.sideBoundaries.top)<EPS&&Math.abs(o.sideBoundaries.bottom-previous.sideBoundaries.bottom)<EPS);
    if(stable&&(stable.quality.crossings<best.quality.crossings||stable.quality.crossings===best.quality.crossings&&stable.quality.score<=best.quality.score+first.crossSideImprovement))best=stable;
  }
  for(const candidate of options.filter(Boolean)){
    const a=candidate.quality,b=best.quality;
    // A new side boundary needs a meaningful gain, and never adds crossings.
    if(a.crossings<b.crossings||a.crossings===b.crossings&&a.score<b.score-first.crossSideImprovement)best=candidate;
  }
  if(!best)throw Error('COMPACT_LAYOUT_CAPACITY');
  // A soft family preference, only within the existing bounded pole search.
  // Keep the geometric winner as a fixed safety budget: grouping must never
  // add crossings or substantially lengthen leaders / grow the drawing.
  const geometric=best;
  for(const candidate of options.filter(Boolean)){
    const a=candidate.quality,b=best.quality,g=geometric.quality;
    if(a.crossings!==g.crossings||a.score>g.score+.16||
      a.maxDiagonal>g.maxDiagonal+first.width*.12||candidate.height>geometric.height+first.width*.25)continue;
    if(a.score+a.familyPenalty<b.score+b.familyPenalty-EPS)best=candidate;
  }
  flattenHorizontal(best);minimizeSegments(best);best.quality=quality(best,previous);
  best.search={evaluated,rejected,maxCandidates:boundaries.length*blends.length,availableBoundaries:allBoundaries.length,columnRefinements:3,refinedCandidates:finalists.size,natural:natural&&natural.quality,chosen:best.quality};
  delete best.config.measure;
  return {config:best.config,pages:[best],detailOnly:[],aggregated:false,engine:'compact-sides'};
}
module.exports={buildVisibleCallouts,layoutCompactCallouts,validateCompactLayout,fitText,naturalSide,angleOrder,sideAt};
