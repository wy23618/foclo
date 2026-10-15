import {createHash,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';

/** Optional maintenance channel: authenticated, empty-target-only, one successful import.
 * Remove MIGRATION_TOKEN after verification. Never serves account/client traffic.
 */
export async function restoreEmptyStore(request,storage,token,{format,tables,appId}){
  if(!token||token.length<43)return new Response(null,{status:404});
  const supplied=request.headers.get('authorization')||'';
  const expected='Bearer '+token;
  if(supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return new Response(null,{status:404});
  storage.sql.exec('CREATE TABLE IF NOT EXISTS cloud_import_receipts(id INTEGER PRIMARY KEY CHECK(id=1),sha256 TEXT NOT NULL,counts TEXT NOT NULL,created_at TEXT NOT NULL)');
  const receipt=storage.sql.exec('SELECT * FROM cloud_import_receipts WHERE id=1').toArray()[0];
  if(request.method==='GET')return Response.json({imported:!!receipt,receipt:receipt?{...receipt,counts:JSON.parse(receipt.counts)}:null},{headers:{'Cache-Control':'no-store'}});
  if(request.method!=='POST')return new Response(null,{status:405});
  if(receipt)return Response.json({error:'already_imported'},{status:409});
  const text=await request.text();
  if(Buffer.byteLength(text)>32*1024*1024)return new Response(null,{status:413});
  let payload;
  try{
    payload=JSON.parse(text);
    const {sha256,...data}=payload;
    if(data.format!==format||data.version!==1||!Array.isArray(data.tables)||data.tables.length!==tables.length||
      (appId&&data.appId!==appId)||createHash('sha256').update(JSON.stringify(data)).digest('hex')!==sha256)throw new Error('invalid_backup');
    const counts=storage.transactionSync(()=>{
      for(const name of tables)if(storage.sql.exec(`SELECT count(*) AS n FROM ${name}`).one().n!==0)throw new Error('target_not_empty');
      const result={};
      storage.sql.exec('PRAGMA defer_foreign_keys=ON');
      for(const [index,name] of tables.entries()){
        const table=data.tables[index];
        const columns=storage.sql.exec(`PRAGMA table_info(${name})`).toArray().map(x=>x.name);
        if(table.name!==name||!Array.isArray(table.columns)||table.columns.length!==columns.length||!table.columns.every(c=>columns.includes(c))||new Set(table.columns).size!==columns.length||!Array.isArray(table.rows))throw new Error('schema_mismatch');
        const sql=`INSERT INTO ${name} (${table.columns.map(c=>'"'+c+'"').join(',')}) VALUES (${columns.map(()=>'?').join(',')})`;
        for(const row of table.rows){
          if(!Array.isArray(row)||row.length!==columns.length)throw new Error('invalid_row');
          const values=row.map(value=>value&&typeof value==='object'&&Object.keys(value).length===1&&typeof value.base64==='string'?Buffer.from(value.base64,'base64'):typeof value==='boolean'?Number(value):value&&typeof value==='object'?JSON.stringify(value):value);
          storage.sql.exec(sql,...values);
        }
        result[name]=table.rows.length;
      }
      if(storage.sql.exec('PRAGMA foreign_key_check').toArray().length)throw new Error('invalid_references');
      storage.sql.exec('INSERT INTO cloud_import_receipts VALUES(1,?,?,?)',sha256,JSON.stringify(result),new Date().toISOString());
      return result;
    });
    return Response.json({imported:true,sha256,counts},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'restore_rejected',message:'Backup validation failed or destination is not empty. Original data was retained.'},{status:409});}
}
