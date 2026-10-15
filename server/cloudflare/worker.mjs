import { registerAuth } from '../src/auth.ts';
import { registerRoutes } from '../src/routes.ts';
import { FetchRouter } from './router.mjs';
import { SqlitePool } from './pool.mjs';
import schema from './schema.sql';
import {restoreEmptyStore} from './restore.mjs';

const restoreTables=['users','spaces','auth_identities','auth_sessions','auth_session_refresh_history','projects','study_sessions','pauses','account_preferences','sync_operations','sync_changes','sync_snapshots','snapshot_items','import_jobs','import_items','account_deletion_requests'];

export class FocloDatabase {
  constructor(ctx, env) {
    this.ctx=ctx; this.env=env; this.queue=Promise.resolve();
    const pool=new SqlitePool({exec:(sql,bindings)=>{
      const rows=ctx.storage.sql.exec(sql,...bindings).toArray();
      const rowCount=/^SELECT\b/i.test(sql.trim())?rows.length:ctx.storage.sql.exec('SELECT changes() AS n').one().n;
      return {rows,rowCount};
    },transaction:fn=>ctx.storage.transaction(fn)});
    this.ready=ctx.blockConcurrencyWhile(async()=>{
      ctx.storage.transactionSync(()=>{ctx.storage.sql.exec(schema);});
      // No PostgreSQL server is used in Cloudflare. Retain the existing service config shape.
      const config={nodeEnv:'production',host:'127.0.0.1',port:3000,databaseUrl:'',migrationDatabaseUrl:'',databaseSsl:true,dbPoolMax:1,
        wechatAppId:env.WECHAT_APP_ID||'',wechatAppSecret:env.WECHAT_APP_SECRET||'',tokenPepper:env.TOKEN_PEPPER||'',cursorSecret:env.CURSOR_SECRET||'',
        accessTokenTtlSeconds:900,refreshTokenTtlSeconds:2592000,refreshGraceSeconds:30};
      this.app=new FetchRouter();
      this.app.get('/health/live',async()=>({status:'ok'}));
      this.app.get('/health/ready',async()=>({status:'ok',storage:'durable-object-sqlite'}));
      registerAuth(this.app,pool,config);
      registerRoutes(this.app,pool,config);
    });
  }
  fetch(request) {
    const task=this.queue.then(async()=>{
      await this.ready;
      const url=new URL(request.url);
      if(url.pathname==='/_maintenance/restore')return restoreEmptyStore(request,this.ctx.storage,this.env.MIGRATION_TOKEN,{format:'foclo-cloudflare-backup',tables:restoreTables,appId:this.env.WECHAT_APP_ID});
      if(url.pathname.startsWith('/api/') && (!this.env.WECHAT_APP_ID || !this.env.WECHAT_APP_SECRET || (this.env.TOKEN_PEPPER?.length||0)<32 || (this.env.CURSOR_SECRET?.length||0)<32 || this.env.TOKEN_PEPPER===this.env.CURSOR_SECRET))
        return Response.json({error:{code:'SERVICE_NOT_CONFIGURED',message:'账号服务尚未配置完成'}},{status:503});
      return this.app.fetch(request);
    });
    this.queue=task.catch(()=>{});return task;
  }
}

export default {
  fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/')return Response.json({service:'Foclo API',runtime:'Cloudflare Workers',health:'/health/ready'});
    return env.FOCLO_DB.get(env.FOCLO_DB.idFromName('foclo-v1')).fetch(request);
  }
};
