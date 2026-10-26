import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ServerConfig } from './config.js';
import { authenticate } from './auth.js';
import { requireValue, uuid } from './protocol.js';
import { transaction } from './sync.js';

// Short-lived advisory presence, never a study record or a remote timer command.
export function registerFocusPresence(app:FastifyInstance,pool:Pool,config:ServerConfig) {
  app.post('/api/v1/focus/presence',async r=>{
    const who=await authenticate(pool,config,r), b=r.body as any;
    requireValue(b && uuid(b.deviceId) && ['check','active','stopped'].includes(b.state));
    if(b.state!=='check')requireValue(uuid(b.sessionId));
    if(b.state==='active')requireValue(Number.isSafeInteger(b.startedAtSec)&&b.startedAtSec>0);
    return transaction(pool,async db=>{
      const space=(await db.query('SELECT generation FROM spaces WHERE id=$1 AND user_id=$2 FOR UPDATE',[who.spaceId,who.userId])).rows[0];
      requireValue(space && String(space.generation)===String(b.generation),'GENERATION_MISMATCH');
      const now=new Date(), expires=new Date(now.getTime()+120000);
      await db.query('DELETE FROM focus_presence WHERE space_id=$1 AND expires_at<=$2',[who.spaceId,now]);
      if(b.state==='active')await db.query(
        'INSERT INTO focus_presence(space_id,device_id,generation,session_id,started_at_sec,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(space_id,device_id) DO UPDATE SET generation=excluded.generation,session_id=excluded.session_id,started_at_sec=excluded.started_at_sec,expires_at=excluded.expires_at',
        [who.spaceId,b.deviceId,space.generation,b.sessionId,b.startedAtSec,expires]);
      if(b.state==='stopped')await db.query('DELETE FROM focus_presence WHERE space_id=$1 AND device_id=$2 AND session_id=$3',[who.spaceId,b.deviceId,b.sessionId]);
      const rows=(await db.query('SELECT started_at_sec FROM focus_presence WHERE space_id=$1 AND generation=$2 AND device_id<>$3 AND expires_at>$4',[who.spaceId,space.generation,b.deviceId,now])).rows;
      return {available:true,otherDevices:rows.map(row=>({startedAtSec:Number(row.started_at_sec)})),ttlSeconds:120};
    });
  });
}
