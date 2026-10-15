// Administrator-only, fresh single-host bootstrap. Never overwrites a database.
// Inputs are private files transferred over verified SSH, never CLI secrets.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, chownSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const [releaseArg, credentialFile, dumpFile] = process.argv.slice(2);
const release = resolve(releaseArg || '');
if (process.getuid?.() !== 0 || !/^\/opt\/yotick\/releases\/[a-zA-Z0-9-]+$/.test(release))
  throw new Error('Run as root with a versioned YoTick release path');
function run(bin, args, input) {
  try { return execFileSync(bin, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64*1024*1024 }); }
  catch (error) {
    // SQL/tool errors may contain private rows. Preserve restricted diagnostics.
    writeFileSync('/root/yotick-configure-error.log', error.stderr || error.message, { mode: 0o600 });
    throw new Error(bin + ' failed; inspect root-only yotick-configure-error.log');
  }
}
function sql(query, db='postgres') {
  return run('/usr/sbin/runuser', ['-u','postgres','--','/usr/bin/psql','-X','-v','ON_ERROR_STOP=1','-At','-d',db], query);
}
if (sql("SELECT count(*) FROM pg_database WHERE datname='yotick';").trim() !== '0' || existsSync('/etc/yotick/server.env'))
  throw new Error('Existing YoTick deployment detected; bootstrap refuses overwrite');
const credentials = JSON.parse(readFileSync(credentialFile, 'utf8'));
for (const key of ['WECHAT_APP_ID','WECHAT_APP_SECRET','TOKEN_PEPPER','CURSOR_SECRET']) {
  if (typeof credentials[key] !== 'string' || !/^[A-Za-z0-9_\-]+$/.test(credentials[key]))
    throw new Error('Missing or unsafe private credential format: ' + key);
}
if (!existsSync(release+'/dist/src/index.js') || !existsSync(dumpFile)) throw new Error('Release/dump unavailable');
if (!run('/usr/bin/getent',['passwd']).split('\n').some(x=>x.startsWith('yotick:')))
  run('/usr/sbin/useradd',['--system','--user-group','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','yotick']);
mkdirSync('/etc/yotick',{recursive:true,mode:0o750});
const gid = Number(run('/usr/bin/id',['-g','yotick']).trim());
chownSync('/etc/yotick',0,gid); chmodSync('/etc/yotick',0o750);
const tls='/root/yotick-pg-tls'; mkdirSync(tls,{recursive:true,mode:0o700});
run('/usr/bin/openssl',['req','-x509','-newkey','rsa:3072','-nodes','-sha256','-days','3650','-subj','/CN=YoTick Private PostgreSQL CA','-keyout',tls+'/ca.key','-out',tls+'/ca.crt','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
run('/usr/bin/openssl',['req','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',tls+'/server.key','-out',tls+'/server.csr']);
writeFileSync(tls+'/server.ext','subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',{mode:0o600});
run('/usr/bin/openssl',['x509','-req','-in',tls+'/server.csr','-CA',tls+'/ca.crt','-CAkey',tls+'/ca.key','-CAcreateserial','-out',tls+'/server.crt','-days','365','-sha256','-extfile',tls+'/server.ext']);
run('/usr/bin/install',['-o','root','-g','root','-m','644',tls+'/ca.crt','/etc/yotick/postgres-ca.crt']);
run('/usr/bin/install',['-o','postgres','-g','postgres','-m','600',tls+'/server.key','/etc/postgresql/17/main/yotick-server.key']);
run('/usr/bin/install',['-o','postgres','-g','postgres','-m','644',tls+'/server.crt','/etc/postgresql/17/main/yotick-server.crt']);
for (const file of ['ca.key','server.key']) chmodSync(tls+'/'+file,0o600);
const pgconf=readFileSync(release+'/deploy/linux/postgresql-yotick.conf','utf8');
writeFileSync('/etc/postgresql/17/main/conf.d/yotick.conf',pgconf+"\nssl=on\nssl_cert_file='/etc/postgresql/17/main/yotick-server.crt'\nssl_key_file='/etc/postgresql/17/main/yotick-server.key'\n",{mode:0o644});
chmodSync('/etc/postgresql/17/main/conf.d/yotick.conf',0o644);
// The host was audited fresh. Preserve original HBA before applying dedicated rules.
if (!existsSync('/root/yotick-original-pg_hba.conf'))
  writeFileSync('/root/yotick-original-pg_hba.conf',readFileSync('/etc/postgresql/17/main/pg_hba.conf'),{flag:'wx',mode:0o600});
writeFileSync('/etc/postgresql/17/main/pg_hba.conf','local all postgres peer\nlocal all all peer\nhostnossl all all 127.0.0.1/32 reject\nhostssl yotick yotick_app 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n',{mode:0o640});
const postgresGid=Number(run('/usr/bin/id',['-g','postgres']).trim());
chownSync('/etc/postgresql/17/main/pg_hba.conf',0,postgresGid);
chmodSync('/etc/postgresql/17/main/pg_hba.conf',0o640);
run('/usr/bin/systemctl',['restart','postgresql@17-main']);
const appPassword=randomBytes(32).toString('hex');
sql("CREATE ROLE yotick_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;\nCREATE ROLE yotick_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '"+appPassword+"';\nCREATE DATABASE yotick OWNER yotick_migrator TEMPLATE template0;\nREVOKE ALL ON DATABASE yotick FROM PUBLIC;\nGRANT CONNECT ON DATABASE yotick TO yotick_app;\n");
run('/usr/bin/install',['-o','postgres','-g','postgres','-m','600',dumpFile,'/var/lib/postgresql/yotick-initial.dump']);
run('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/pg_restore','--exit-on-error','--no-owner','--no-privileges','--role=yotick_migrator','--dbname=yotick','/var/lib/postgresql/yotick-initial.dump']);
if (sql('SELECT max(version) FROM schema_migrations;','yotick').trim()!=='5') throw new Error('Unexpected schema version');
sql('REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n'+readFileSync(release+'/deploy/permissions.sql','utf8'),'yotick');
const appUrl='postgresql://yotick_app:'+appPassword+'@127.0.0.1:5432/yotick';
const environment={NODE_ENV:'production',HOST:'127.0.0.1',PORT:'3000',DATABASE_URL:appUrl,MIGRATION_DATABASE_URL:'postgresql://yotick_unavailable@127.0.0.1:5432/yotick',DATABASE_SSL:'true',DB_POOL_MAX:'5',...credentials};
writeFileSync('/etc/yotick/server.env',Object.entries(environment).map(([k,v])=>k+'='+v).join('\n')+'\n',{flag:'wx',mode:0o640});
chownSync('/etc/yotick/server.env',0,gid); chmodSync('/etc/yotick/server.env',0o640);
if (existsSync('/opt/yotick/current')) throw new Error('Existing release selector; inspect before switching');
symlinkSync(release,'/opt/yotick/current');
run('/usr/bin/install',['-o','root','-g','root','-m','644',release+'/deploy/linux/yotick.service','/etc/systemd/system/yotick.service']);
run('/usr/bin/systemctl',['daemon-reload']);
run('/usr/bin/systemctl',['enable','--now','yotick.service']);
console.log('YOTICK_CONFIGURED_PRIVATE_API');
