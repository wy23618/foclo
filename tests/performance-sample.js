const fs=require('node:fs');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const statistics=require('../core/statistics');
const tree=require('../core/tree');
const time=require('../core/time');
const local=require('../sync/local');
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const base=1700000000,spaceId=id(1000000),projects=[],sessions=[];
for(let i=0;i<500;i++)projects.push({id:id(i+1),spaceId,name:'样本项目 '+(i+1),parentId:i? id(1):null,archived:false,creationOrder:i+1,revision:1,color:'#425B42',shortName:'',lastUsedAtSec:null,createdAtSec:base,updatedAtSec:base});
for(let i=0;i<10000;i++){const started=base+i*1800,sid=id(1001+i);sessions.push({id:sid,spaceId,projectId:id(2+i%499),startedAtSec:started,endedAtSec:started+1710,durationSeconds:1500,targetSeconds:1800,status:'COMPLETED',createdAtSec:started,updatedAtSec:started+1710,revision:1,pauses:[{id:id(20001+i*2),sessionId:sid,startedAtSec:started+300,endedAtSec:started+390,durationSeconds:90,status:'COMPLETED',createdAtSec:started+300},{id:id(20002+i*2),sessionId:sid,startedAtSec:started+800,endedAtSec:started+920,durationSeconds:120,status:'COMPLETED',createdAtSec:started+800}]});}
const backup={formatVersion:1,spaceId,meta:{schemaVersion:1,utcOffsetMinutes:480},projects,sessions,prefs:{startupMode:'remember',defaultMinutes:30,commonMinutes:[15,30,45,60]}};
const startStringify=performance.now(),json=JSON.stringify(backup),stringifyMs=performance.now()-startStringify,startParse=performance.now();JSON.parse(json);const parseMs=performance.now()-startParse;
const byId=Object.fromEntries(projects.map(p=>[p.id,p])),range={start:base,end:sessions[sessions.length-1].endedAtSec},startStats=performance.now(),stats=statistics.rangeStatistics(sessions,range,range.end,tree.buildIndex(byId),'completed'),statisticsMs=performance.now()-startStats;
const index={},projectIndexes={};for(const s of sessions){const day=time.dayKey(s.startedAtSec);(index[day]||(index[day]=[])).push(s.id);(projectIndexes[s.projectId]||(projectIndexes[s.projectId]=[])).push(s.id);}
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8'),wire={projects:projects.map(local.projectPayload),sessions:sessions.map(local.sessionPayload)};
const results={date:'2026-10-06',environment:{runtime:process.version,platform:process.platform,measurement:'Node single-run baseline; no wx storage or frame measurement'},sample:{projects:500,sessions:10000,pauses:20000,totalSeconds:stats.totalSeconds},bytes:{backupJson:Buffer.byteLength(json),wireImportJson:bytes(wire),factsAndIndexesJson:bytes(byId)+sessions.reduce((n,s)=>n+bytes(s),0)+bytes(index)+bytes(projectIndexes),legacyUpgradeExtraCopiesJson:2*(bytes(byId)+sessions.reduce((n,s)=>n+bytes(s),0)+bytes(index)+bytes(projectIndexes))},timingsMs:{stringify:+stringifyMs.toFixed(2),parse:+parseMs.toFixed(2),fullRangeStatistics:+statisticsMs.toFixed(2)},limits:{cloudImportMaxBytes:8*1024*1024,localBackupCommitMaxBytes:650*1024,actualWxCapacity:'Read getStorageInfo.currentSize/limitSize on each device; not measured'},conclusions:{requiresChunkedImport:Buffer.byteLength(json)>650*1024,wireFitsCurrentCloudImport:bytes(wire)<=8*1024*1024,trueDeviceAcceptance:false}};
if(stats.totalSeconds!==15000000)throw new Error('Sample duration drift');fs.writeFileSync(path.join(__dirname,'../docs/performance-results.json'),JSON.stringify(results,null,2));process.stdout.write(JSON.stringify(results,null,2)+'\n');
