const { themeColors } = require('../../utils/theme');
function clamp(v){return Math.max(0,Math.min(1,Number(v)||0));}
Component({
  properties:{obscured:Boolean,layoutKey:{type:String,value:'',observer(){if(this.isReady)wx.nextTick(()=>{if(this.isReady)this.measure();});}},countdown:{type:Boolean,value:true},progress:{type:Number,value:0},paused:{type:Boolean,value:false},running:{type:Boolean,value:false},durationSeconds:{type:Number,value:0},theme:{type:String,value:'light'}},
  observers:{'progress, paused, countdown, running, durationSeconds'(){this.sync();},theme(){this.faceCountdown=null;this.sync();}},
  lifetimes:{ready(){this.isReady=true;this.measure();},detached(){this.isReady=false;this.cancel();}},
  pageLifetimes:{hide(){this.hidden=true;this.cancel();},show(){this.hidden=false;this.wasRunning=false;this.sync();},resize(){wx.nextTick(()=>{if(this.isReady)this.measure();});}},
  methods:{
    measure(){
      const token=this.measureToken=(this.measureToken||0)+1,q=this.createSelectorQuery();
      q.select('#face').fields({node:true,size:true});q.select('#ring').fields({node:true,size:true});
      q.exec(rows=>{
        if(!this.isReady||token!==this.measureToken||!rows[0]||!rows[1]||!rows[1].width||!rows[1].height)return;
        const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync(),ratio=info.pixelRatio||1;
        this.cancel();this.face=rows[0].node;this.canvas=rows[1].node;this.size=rows[1];
        [this.face,this.canvas].forEach(c=>{c.width=this.size.width*ratio;c.height=this.size.height*ratio;c.getContext('2d').scale(ratio,ratio);});
        this.faceCountdown=null;this.sync();
      });
    },
    cancel(){if(this.frame!=null&&this.canvas){this.canvas.cancelAnimationFrame(this.frame);this.frame=null;}},
    faceDraw(){const s=this.size,ctx=this.face.getContext('2d'),x=s.width/2,y=s.height/2,r=Math.min(x,y)-10,colors=themeColors(this.properties.theme);ctx.clearRect(0,0,s.width,s.height);for(let i=0;i<60;i++){if(i===0)continue;const a=i/60*Math.PI*2;ctx.strokeStyle=i%5?colors.focusTick:colors.focusTickMajor;ctx.lineWidth=i%5?1:2;ctx.beginPath();ctx.moveTo(x+Math.sin(a)*(r-(i%5?5:10)),y-Math.cos(a)*(r-(i%5?5:10)));ctx.lineTo(x+Math.sin(a)*r,y-Math.cos(a)*r);ctx.stroke();}ctx.lineWidth=Math.max(4,Math.min(6,r*.04));ctx.strokeStyle=colors.focusTrack;if(this.properties.countdown){ctx.beginPath();ctx.arc(x,y,r-17,0,Math.PI*2);ctx.stroke();}},
    paint(fraction){const s=this.size,ctx=this.canvas.getContext('2d'),x=s.width/2,y=s.height/2,r=Math.min(x,y)-10,colors=themeColors(this.properties.theme);ctx.clearRect(0,0,s.width,s.height);this.visibleFraction=this.properties.countdown?clamp(fraction):0;this.arcStart=-Math.PI/2+(1-this.visibleFraction)*Math.PI*2;this.arcEnd=Math.PI*1.5;ctx.lineWidth=Math.max(4,Math.min(6,r*.04));ctx.strokeStyle=this.properties.paused?colors.focusPaused:colors.focusProgress;ctx.lineCap='round';if(this.visibleFraction>0){ctx.beginPath();ctx.arc(x,y,r-17,this.arcStart,this.arcEnd);ctx.stroke();}},
    sync(){if(!this.isReady||!this.canvas)return;const p=this.properties,next=clamp(p.progress),duration=Number(p.durationSeconds)||0,now=Date.now(),active=p.countdown&&p.running&&!p.paused&&duration>0&&next>0&&!this.hidden;
      if(this.faceCountdown!==p.countdown){this.faceCountdown=p.countdown;this.faceDraw();}
      if(active){const deadline=(Math.floor(now/1000)+next*duration)*1000;if(!this.wasRunning||this.lastDuration!==duration||Math.abs(deadline-this.deadline)>1500)this.deadline=deadline;this.lastDuration=duration;this.wasRunning=true;this.paint(Math.max(0,(this.deadline-now)/(duration*1000)));if(this.frame==null)this.schedule();}
      else{this.wasRunning=false;this.cancel();this.paint(next);}
    },
    schedule(){if(!this.isReady||this.hidden||!this.wasRunning)return;this.frame=this.canvas.requestAnimationFrame(()=>{this.frame=null;if(!this.isReady||this.hidden||!this.wasRunning)return;const now=Date.now();if(!this.lastPaint||now-this.lastPaint>=30){this.lastPaint=now;this.paint(Math.max(0,(this.deadline-now)/(this.lastDuration*1000)));}if(this.visibleFraction>0)this.schedule();});}
  }
});
