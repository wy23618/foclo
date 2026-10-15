// Read-only verification against the just-restored private deployment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
const source=JSON.parse(readFileSync('/root/initial-20261008-manifest.json','utf8'));
const plain=execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/pg_dump','--data-only','--no-owner','--no-privileges','-d','yotick'],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
const target={};
for(const block of plain.matchAll(/COPY public\.([a-z_]+) \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/gm)){
 const text=block[3].replace(/\r\n/g,'\n').replace(/\n$/,''); const rows=text?text.split('\n'):[];
 target[block[1]]={columns:block[2],count:rows.length,sha256:createHash('sha256').update(rows.sort().join('\n')).digest('hex')};
}
assert.deepEqual(target,source.tables,'Cloud restored data differs from source snapshot');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:2});
const state=(await pool.query("SELECT current_user AS role, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls, has_schema_privilege(current_user,'public','CREATE') AS can_create, (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged")).rows[0];
assert.equal(state.role,'yotick_app'); assert.equal(state.tls,true); assert.equal(state.can_create,false); assert.equal(state.privileged,false);
const invalidCa=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true,ca:readFileSync('/etc/ssl/certs/ISRG_Root_X1.pem','utf8')},connectionTimeoutMillis:3000});
let caRejected=false;
try { await invalidCa.query('SELECT 1'); } catch(e) { caRejected=/certificate|issuer|self.signed/i.test(e.message); } finally {await invalidCa.end();}
assert.equal(caRejected,true,'Invalid CA must be rejected');
const clear=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,connectionTimeoutMillis:3000});
let clearRejected=false;
try {await clear.query('SELECT 1');} catch(e){clearRejected=/pg_hba|reject/i.test(e.message);}finally{await clear.end();}
assert.equal(clearRejected,true,'Unencrypted PostgreSQL must be rejected');
const live=await fetch('http://127.0.0.1:3000/health/live',{signal:AbortSignal.timeout(5000)});
const ready=await fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(5000)});
assert.equal(live.status,200); assert.equal(ready.status,200);
const evidence={capturedAt:new Date().toISOString(),restoredTables:Object.keys(target).length,tableDataIdentical:true,sourceSha256:source.sha256,appRole:state,invalidCaRejected:caRejected,plaintextRejected:clearRejected,live:live.status,ready:ready.status,publicWechatVerified:false};
writeFileSync('/root/yotick-cloud-verification.json',JSON.stringify(evidence,null,2),{mode:0o600});
await pool.end(); console.log(JSON.stringify(evidence));
