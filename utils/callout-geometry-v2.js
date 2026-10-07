const EPS = 1e-8;
const sectorBoxes=new WeakMap();
function cross(a,b,c) { return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]); }
function onSegment(a,b,p) { return Math.abs(cross(a,b,p))<=EPS && p[0]>=Math.min(a[0],b[0])-EPS && p[0]<=Math.max(a[0],b[0])+EPS && p[1]>=Math.min(a[1],b[1])-EPS && p[1]<=Math.max(a[1],b[1])+EPS; }
function segmentsIntersect(a1,a2,b1,b2) {
  if((a2[0]-a1[0])**2+(a2[1]-a1[1])**2<=EPS*EPS||(b2[0]-b1[0])**2+(b2[1]-b1[1])**2<=EPS*EPS)return false;
  if(Math.max(a1[0],a2[0])<Math.min(b1[0],b2[0])-EPS||Math.max(b1[0],b2[0])<Math.min(a1[0],a2[0])-EPS||Math.max(a1[1],a2[1])<Math.min(b1[1],b2[1])-EPS||Math.max(b1[1],b2[1])<Math.min(a1[1],a2[1])-EPS)return false;
  const a=cross(a1,a2,b1),b=cross(a1,a2,b2),c=cross(b1,b2,a1),d=cross(b1,b2,a2);
  return ((a>EPS&&b < -EPS||a < -EPS&&b>EPS)&&(c>EPS&&d < -EPS||c < -EPS&&d>EPS))||onSegment(a1,a2,b1)||onSegment(a1,a2,b2)||onSegment(b1,b2,a1)||onSegment(b1,b2,a2);
}
function segmentHitsBox(a,b,box) {
  // Slab clipping gives the same segment/rectangle predicate without creating
  // four corner segments for every text box in every search candidate.
  let enter=0,leave=1;
  for(let axis=0;axis<2;axis++){
    const low=(axis?box.y:box.x)-EPS,high=low+(axis?box.height:box.width)+2*EPS,delta=b[axis]-a[axis];
    if(Math.abs(delta)<EPS){if(a[axis]<low||a[axis]>high)return false;continue;}
    let t0=(low-a[axis])/delta,t1=(high-a[axis])/delta;if(t0>t1){const tmp=t0;t0=t1;t1=tmp;}
    enter=Math.max(enter,t0);leave=Math.min(leave,t1);if(enter>leave)return false;
  }
  return true;
}
function segmentDistance(p,a,b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(a[0]+t*dx-p[0],a[1]+t*dy-p[1]);
}
function segmentHitsSector(a,b,s,c){
  const x=a[0]-c.cx,y=a[1]-c.cy,dx=b[0]-a[0],dy=b[1]-a[1],lengthSquared=dx*dx+dy*dy;
  if(lengthSquared<EPS*EPS)return false;
  // Cheap exact rejection before solving circle/ray intersections. Cache only
  // radius/angle bounds, so translation and frozen inputs remain safe.
  let box=sectorBoxes.get(s);
  if(!box||box.inner!==s.innerRadius||box.outer!==s.outerRadius||box.start!==s.startAngle||box.end!==s.endAngle){
    const angles=[s.startAngle,s.endAngle];
    for(let k=Math.ceil(s.startAngle/(Math.PI/2));k*Math.PI/2<=s.endAngle;k++)angles.push(k*Math.PI/2);
    const points=[s.innerRadius,s.outerRadius].flatMap(r=>angles.map(angle=>[r*Math.cos(angle),r*Math.sin(angle)]));
    box={minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1])),inner:s.innerRadius,outer:s.outerRadius,start:s.startAngle,end:s.endAngle};sectorBoxes.set(s,box);
  }
  if(Math.max(x,x+dx)<box.minX-EPS||Math.min(x,x+dx)>box.maxX+EPS||Math.max(y,y+dy)<box.minY-EPS||Math.min(y,y+dy)>box.maxY+EPS)return false;
  const closest=Math.max(0,Math.min(1,-(x*dx+y*dy)/lengthSquared));
  if((x+closest*dx)**2+(y+closest*dy)**2>=(s.outerRadius-EPS)**2)return false;
  if(x*x+y*y<=(s.innerRadius+EPS)**2&&(x+dx)**2+(y+dy)**2<=(s.innerRadius+EPS)**2)return false;
  const cuts=[0,1],add=t=>{if(t>0&&t<1)cuts.push(t);};
  for(const radius of [s.innerRadius,s.outerRadius]){
    const linear=2*(x*dx+y*dy),constant=x*x+y*y-radius*radius,disc=linear*linear-4*lengthSquared*constant;
    if(disc>=0){add((-linear-Math.sqrt(disc))/(2*lengthSquared));add((-linear+Math.sqrt(disc))/(2*lengthSquared));}
  }
  for(const angle of [s.startAngle,s.endAngle]){const ux=Math.cos(angle),uy=Math.sin(angle),denom=dx*uy-dy*ux;if(Math.abs(denom)>EPS)add((y*ux-x*uy)/denom);}
  cuts.sort((u,v)=>u-v);
  for(let i=1;i<cuts.length;i++){
    const t=(cuts[i-1]+cuts[i])/2,px=x+t*dx,py=y+t*dy,r=Math.hypot(px,py);let angle=Math.atan2(py,px);
    while(angle<s.startAngle)angle+=Math.PI*2;
    if(r>s.innerRadius+EPS&&r<s.outerRadius-EPS&&(s.endAngle-s.startAngle>=Math.PI*2-EPS||angle>s.startAngle+EPS&&angle<s.endAngle-EPS))return true;
  }
  return false;
}

function routeSegments(points){return points.slice(1).map((p,i)=>[points[i],p]).filter(([a,b])=>(a[0]-b[0])**2+(a[1]-b[1])**2>EPS*EPS);}
module.exports={segmentsIntersect,segmentHitsBox,segmentDistance,segmentHitsSector,routeSegments};
