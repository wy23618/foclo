const { themeColors } = require('./theme');
function paletteName(theme) { return theme === true ? 'dark' : (theme === false ? 'light' : theme); }
function drawSector(ctx, s, c, outer = s.outerRadius, alpha = 1, selected = false,theme='light') {
  if (outer <= s.innerRadius || alpha <= 0) return;
  ctx.globalAlpha=alpha;ctx.fillStyle=s.color;ctx.beginPath();
  ctx.arc(c.cx,c.cy,outer,s.startAngle,s.endAngle);
  ctx.arc(c.cx,c.cy,s.innerRadius,s.endAngle,s.startAngle,true);ctx.closePath();ctx.fill();
  if(selected){ctx.fillStyle=themeColors(paletteName(theme)).cardBackground;ctx.globalAlpha=alpha*c.selectedAlpha;ctx.beginPath();ctx.arc(c.cx,c.cy,outer-c.selectedInset,s.startAngle,s.endAngle);ctx.arc(c.cx,c.cy,s.innerRadius+c.selectedInset,s.endAngle,s.startAngle,true);ctx.closePath();ctx.fill();}
  if(s.showInsideName&&outer===s.outerRadius){
    ctx.globalAlpha=alpha;ctx.font='600 '+s.insideFontSize+'px sans-serif';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
    const radius=s.insideRadius||(s.innerRadius+outer)/2,angle=s.insideAngle===undefined?s.midAngle:s.insideAngle;ctx.fillText(s.insideName,c.cx+Math.cos(angle)*radius,c.cy+Math.sin(angle)*radius);
  }
  ctx.globalAlpha=1;
}
function drawCallout(ctx,l,c,alpha=1,theme='light'){
  if(alpha<=0)return;
  // Consume computed geometry and typography without rerouting in the painter.
  const child=l.type==='child';
  ctx.globalAlpha=alpha;ctx.strokeStyle=l.color;ctx.lineWidth=child?Math.max(.9,l.lineWidth):Math.max(1.5,l.lineWidth);ctx.lineCap='round';ctx.lineJoin='round';if(ctx.setLineDash)ctx.setLineDash(child?[3,2.5]:[]);ctx.beginPath();ctx.moveTo(...l.points[0]);l.points.slice(1).forEach(p=>ctx.lineTo(...p));ctx.stroke();if(ctx.setLineDash)ctx.setLineDash([]);
  ctx.fillStyle=l.dotFilled?l.color:c.backgroundColor;ctx.beginPath();ctx.arc(l.p3[0],l.p3[1],l.dotRadius,0,Math.PI*2);ctx.fill();if(!l.dotFilled)ctx.stroke();ctx.textAlign='left';ctx.textBaseline='middle';
  for(const run of l.textRuns){ctx.font=run.weight+' '+run.fontSize+'px sans-serif';ctx.textAlign=run.align;ctx.fillStyle=run.kind==='global'?l.color:(themeColors(paletteName(theme)).chartText);ctx.fillText(run.text,run.x,run.y);}ctx.globalAlpha=1;
}
function drawCalloutSet(ctx,labels,c,dx,dy,alpha,theme){ctx.save();ctx.translate(dx,dy);labels.forEach(l=>drawCallout(ctx,l,c,alpha,theme));ctx.restore();}
function centerDuration(seconds){
  const value=Math.max(0,Math.floor(Number(seconds)||0));
  if(value>=3600){const hours=Math.floor(value/3600),minutes=Math.floor(value%3600/60);return hours+'h'+(minutes?minutes+'m':'');}
  if(value>=60)return Math.floor(value/60)+'m';
  return value+'s';
}
function drawCenterSummary(ctx,g,c,theme){
  const total=Number(g.totalAllSeconds)||0;
  const count=g.preparedData&&g.preparedData.parents?g.preparedData.parents.length:(g.parentSectors||[]).length;
  const primary=centerDuration(total),secondary=count+' 个项目',maxWidth=Math.max(1,(c.parentInnerRadius||32)*1.8);
  const primarySize=Math.max(12,Math.min(17,(c.centerFontSize||15)+1));
  const secondarySize=Math.max(9,Math.min(11,c.auxiliaryFontSize||10));
  ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle=themeColors(paletteName(theme)).textPrimary;ctx.font='600 '+primarySize+'px sans-serif';
  ctx.fillText(primary,c.cx,c.cy-(c.centerLineHeight||14)*.34,maxWidth);
  ctx.fillStyle=themeColors(paletteName(theme)).chartMuted;ctx.font='500 '+secondarySize+'px sans-serif';
  ctx.fillText(secondary,c.cx,c.cy+(c.centerLineHeight||14)*.78,maxWidth);
  ctx.restore();
}
function translateCallout(l,dx,dy){
  const points=l.points.map(p=>[p[0]+dx,p[1]+dy]),moveBox=b=>Object.assign({},b,{x:b.x+dx,y:b.y+dy});
  return Object.assign({},l,{points,p0:points[0],p1:points[1],p2:points[2],p3:points[3],dotCenter:points[3],
    bounds:moveBox(l.bounds),textBoxes:l.textBoxes.map(moveBox),textRuns:l.textRuns.map(r=>Object.assign({},r,{x:r.x+dx,y:r.y+dy}))});
}
function interpolateDonut(g,from,t){
  // Hide callouts during a radius change; endpoint callouts always attach to
  // their actual endpoint radii. Frames only interpolate precomputed geometry.
  const resizing=from.config.parentOuterRadius!==g.config.parentOuterRadius;
  // Fade old labels before changing rings, then reveal the final labels after
  // the rings settle. Adaptive columns can occupy the unused child-ring area.
  const u=Math.max(0,Math.min(1,(t-.25)*2));
  const lerp=(a,b)=>a+(b-a)*u,inner=lerp(from.config.parentInnerRadius,g.config.parentInnerRadius),outer=lerp(from.config.parentOuterRadius,g.config.parentOuterRadius);
  const config=Object.assign({},g.config,{cx:from.config.cx+(g.config.cx-from.config.cx)*t,cy:from.config.cy+(g.config.cy-from.config.cy)*t,parentInnerRadius:inner,parentOuterRadius:outer,childOuterRadius:outer+g.config.childRingWidth});
  const oldParents=new Map(from.parentSectors.map(s=>[s.id,s]));
  const parents=g.parentSectors.map(s=>Object.assign({},s,{innerRadius:inner,outerRadius:outer,showInsideName:resizing&&u>0&&u<1?false:u===0?(oldParents.get(s.id)||s).showInsideName:s.showInsideName}));
  const oldIds=new Set(from.childSectors.map(s=>s.id)),newIds=new Set(g.childSectors.map(s=>s.id));
  const children=g.childSectors.map(s=>Object.assign({},s,{innerRadius:outer,outerRadius:outer+g.config.childRingWidth*(oldIds.has(s.id)?1:u),showInsideName:s.showInsideName&&u===1}));
  const retracting=from.childSectors.filter(s=>!newIds.has(s.id)).map(s=>Object.assign({},s,{innerRadius:outer,outerRadius:outer+g.config.childRingWidth*(1-u),showInsideName:false}));
  const fadeOut=.25,fadeIn=.75;
  const callouts=t<fadeOut?from.computedCallouts.map(l=>translateCallout(l,config.cx-from.config.cx,config.cy-from.config.cy)):
    t>fadeIn?g.computedCallouts.map(l=>translateCallout(l,config.cx-g.config.cx,config.cy-g.config.cy)):[];
  return Object.assign({},g,{config,parentSectors:parents,childSectors:children,retracting,resizing,computedCallouts:callouts,labels:callouts});
}
function renderDonut(ctx,g,transition,viewport,theme='light') {
  if(viewport){ctx.clearRect(0,0,viewport.width,viewport.height);ctx.save();ctx.translate(-viewport.x,-viewport.y);}
  const palette=paletteName(theme),dark=palette==='dark',visual=transition?interpolateDonut(g,transition.from,transition.progress):g,c=Object.assign({},visual.config,dark?{backgroundColor:themeColors('dark').cardBackground}:{});
  const aggregate=g.calloutPages&&g.calloutPages.flatMap(page=>page.labels).find(s=>s.projectId===g.selectedChildId&&s.visualAggregate);
  const selectedIds=new Set(aggregate?aggregate.members.map(s=>s.projectId):[g.selectedChildId]);
  ctx.clearRect(0,0,g.width,g.height);
  if(!g.parentSectors.length){ctx.strokeStyle=themeColors(palette).chartTrack;ctx.lineWidth=c.parentRingWidth;ctx.beginPath();ctx.arc(c.cx,c.cy,(c.parentInnerRadius+c.parentOuterRadius)/2,0,Math.PI*2);ctx.stroke();}
  visual.parentSectors.forEach(s=>drawSector(ctx,s,c,s.outerRadius,1,s.projectId===(g.selectedProjectId||g.selectedParentId),palette));
  const t=transition&&transition.progress;
  if(transition){
    const old=transition.from;
    visual.retracting.forEach(s=>drawSector(ctx,s,c,s.outerRadius,1-t,false,palette));
    visual.childSectors.forEach(s=>drawSector(ctx,s,c,s.outerRadius,1,selectedIds.has(s.projectId),palette));
    // Use precomputed FINAL coordinates for both fading sets. Moving labels and
    // lines simultaneously can cross during interpolation; sequential fades
    // retain a validated, stable topology on every rendered frame.
    const fadeOut=.25,fadeIn=.75;
    if(t<fadeOut)drawCalloutSet(ctx,old.computedCallouts,c,c.cx-old.config.cx,c.cy-old.config.cy,1-t/fadeOut,palette);
    else if(t>=fadeIn)drawCalloutSet(ctx,g.computedCallouts,c,c.cx-g.config.cx,c.cy-g.config.cy,(t-fadeIn)/(1-fadeIn),palette);
  }else{g.childSectors.forEach(s=>drawSector(ctx,s,c,s.outerRadius,1,s.projectId===g.selectedProjectId||selectedIds.has(s.projectId),palette));(g.grandchildSectors||[]).forEach(s=>drawSector(ctx,s,c,s.outerRadius,1,s.projectId===g.selectedProjectId,palette));g.computedCallouts.forEach(l=>drawCallout(ctx,l,c,1,palette));}
  drawCenterSummary(ctx,visual,c,palette);
  if(viewport)ctx.restore();
}
module.exports={renderDonut,drawSector,drawCallout,interpolateDonut};
