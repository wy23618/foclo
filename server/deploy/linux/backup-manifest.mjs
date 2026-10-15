// Derive verification data from the exact archive, never from a later live DB.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [source,target]=process.argv.slice(2);
if(process.getuid?.()!==0 || !/^\/root\/yotick_restore_drill_[a-f0-9]{12}\.dump$/.test(source||'') || target!==source+'.manifest.json')throw new Error('Use exact private drill files');
const text=execFileSync('/usr/bin/pg_restore',['--data-only','--no-owner','--no-privileges','--file=-',source],{encoding:'utf8',maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
const tables={};
for(const block of text.matchAll(/COPY public\.([a-z_]+) \(([^\n]+)\) FROM stdin;\r?\n([\s\S]*?)^\\\.\r?$/gm)){
 const plain=block[3].replace(/\r\n/g,'\n').replace(/\n$/,'');const rows=plain?plain.split('\n'):[];
 tables[block[1]]={columns:block[2],count:rows.length,sha256:createHash('sha256').update(rows.sort().join('\n')).digest('hex')};
}
if(Object.keys(tables).length!==17)throw new Error('Unexpected archive schema');
writeFileSync(target,JSON.stringify({tables}),{flag:'wx',mode:0o600});
