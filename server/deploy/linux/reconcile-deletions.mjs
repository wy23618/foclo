// Offline restore gate, root-only Unix-socket administrator connection.
// Never targets the running yotick database or changes ledger records.
import pg from 'pg';
import { reconcileDeletionLedger } from '../../dist/src/account-deletion.js';
const database=process.argv[2];
if(process.getuid?.()!==0 || !/^yotick_restore_[a-z0-9_]+$/.test(database||''))
  throw new Error('Root and a new isolated restore database are required');
const pool=new pg.Pool({host:'/var/run/postgresql',user:'postgres',database,max:2,ssl:false});
try {
 const result=await reconcileDeletionLedger(pool,'/var/lib/yotick-deletion-ledger');
 console.log(JSON.stringify({...result,verifiedAt:new Date().toISOString(),ledgerFreshnessExternallyVerified:false}));
}finally{await pool.end();}
