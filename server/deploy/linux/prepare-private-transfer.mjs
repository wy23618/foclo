// Windows administrator preparation. Writes only to the protected private folder.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = join(process.env.LOCALAPPDATA,'YoTick','CloudServer');
const localRoot=join(process.env.LOCALAPPDATA,'YoTick','LocalServer');
const url=new URL(process.env.DATABASE_URL);
if (process.platform!=='win32' || url.hostname!=='127.0.0.1' || url.port!=='5433' || url.pathname!=='/yotick')
  throw new Error('Only the audited local Windows database is accepted');
const credentials={};
for(const key of ['WECHAT_APP_ID','WECHAT_APP_SECRET','TOKEN_PEPPER','CURSOR_SECRET']){
  const value=process.env[key]?.trim();
  if(!value || !/^[A-Za-z0-9_\-]+$/.test(value))throw new Error('Unsupported/missing credential format: '+key);
  credentials[key]=value;
}
writeFileSync(join(root,'transfer-credentials.json'),JSON.stringify(credentials),{flag:'wx',mode:0o600});
const secrets=JSON.parse(readFileSync(join(localRoot,'secrets.json'),'utf8').replace(/^\uFEFF/,''));
const bin=[process.env.YOTICK_POSTGRES_BIN,join(process.env.ProgramFiles,'PostgreSQL','17','bin'),'D:\\PostgreSQL\\17\\bin'].filter(Boolean).find(p=>existsSync(join(p,'pg_dump.exe')));
if(!bin)throw new Error('PG17 tools missing');
const dump=join(root,'initial-20261008.dump');
if(existsSync(dump))throw new Error('Existing transfer snapshot preserved; choose a new filename');
try{
 execFileSync(join(bin,'pg_dump.exe'),['-h','127.0.0.1','-p','5433','-U','yotick_admin','-d','yotick','--format=custom','--no-owner','--no-privileges','--file='+dump],{env:{...process.env,PGPASSWORD:secrets.adminPassword},stdio:['ignore','pipe','pipe'],timeout:60000});
 const plain=execFileSync(join(bin,'pg_restore.exe'),['--data-only','--no-owner','--no-privileges','--file=-',dump],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
 const tables={};
 for(const block of plain.matchAll(/COPY public\.([a-z_]+) \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/gm)){
  const text=block[3].replace(/\r\n/g,'\n').replace(/\n$/,'');
  const rows=text?text.split('\n'):[];
  tables[block[1]]={columns:block[2],count:rows.length,sha256:createHash('sha256').update(rows.sort().join('\n')).digest('hex')};
 }
 if(Object.keys(tables).length!==17)throw new Error('Unexpected source table count');
 const evidence={capturedAt:new Date().toISOString(),sha256:createHash('sha256').update(readFileSync(dump)).digest('hex'),bytes:readFileSync(dump).length,tables};
 writeFileSync(join(root,'initial-20261008-manifest.json'),JSON.stringify(evidence,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({prepared:true,bytes:evidence.bytes,tables:Object.keys(tables).length,sha256:evidence.sha256}));
}catch{throw new Error('Private snapshot preparation failed; files preserved, no credentials printed');}
