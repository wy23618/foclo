// Run as postgres against a NEW, non-public drill DB. No production writes.
import assert from 'node:assert/strict';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pull } from '../../dist/src/sync.js';
const db=process.argv[2];
if(process.getuid?.()===0 || !/^yotick_restore_drill_[a-f0-9]{12}$/.test(db)) throw new Error('Use postgres and a new isolated drill DB');
let input='';for await(const chunk of process.stdin)input+=chunk;
const source=JSON.parse(input);
const text=execFileSync('/usr/bin/pg_dump',['--data-only','--no-owner','--no-privileges','-d',db],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});
const tables={};
for(const block of text.matchAll(/COPY public\.([a-z_]+) \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/gm)){
 const plain=block[3].replace(/\r\n/g,'\n').replace(/\n$/,'');const rows=plain?plain.split('\n'):[];
 tables[block[1]]={columns:block[2],count:rows.length,sha256:createHash('sha256').update(rows.sort().join('\n')).digest('hex')};
}
assert.deepEqual(tables,source.tables,'Backup restore differs from initial snapshot');
const pool=new pg.Pool({host:'/var/run/postgresql',user:'postgres',database:db,max:2});
const spaces=(await pool.query('SELECT * FROM spaces')).rows;
const secret=randomBytes(32).toString('hex');const cursors=[];
for(const space of spaces){
 const who={userId:space.user_id,spaceId:space.id,generation:space.generation,sessionId:randomUUID()};
 const result=await pull(pool,who,{generation:space.generation},secret);
 cursors.push({who,cursor:result.cursor});
}
await pool.query('UPDATE spaces SET restore_epoch=gen_random_uuid()');
let rejected=0;
for(const {who,cursor} of cursors){
 await assert.rejects(pull(pool,who,{generation:who.generation,cursor},secret),error=>error.code==='CURSOR_EXPIRED');rejected++;
}
await pool.end();console.log(JSON.stringify({capturedAt:new Date().toISOString(),isolatedDatabase:db,restoredTables:Object.keys(tables).length,tableDataIdentical:true,oldCursorsRejected:rejected,sourceDatabaseUntouched:true}));
