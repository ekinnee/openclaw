import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// Supporting native-engine proof. This does not instantiate the OpenClaw store or migration owner.
const require = createRequire('${OPENCLAW_CHECKOUT}/.worktrees/n1-physical-origin/package.json');
const { Client } = require('pg');
const pgPackage = require.resolve('pg/package.json');
const artifact = new URL('./native-result.json', import.meta.url);
const container = 'openclaw-writer-fence-pg-20261102-1743';
const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], {encoding:'utf8'}).trim().split(':').at(-1));
const clients = new Set();
const events = [];
const started = new Date().toISOString();
const start = performance.now();
let assertions = 0;
const record = (event, details = {}) => { const row = {event, ms:Math.round(performance.now()-start), ...details}; events.push(row); process.stdout.write(JSON.stringify(row)+'\n'); };
const check = (condition, label, details={}) => { assert(condition, label); assertions++; record('PASS', {label,...details}); };
const equal = (actual, expected, label) => { assert.deepEqual(actual,expected,label); assertions++; record('PASS',{label}); };
async function client(name, schema) {
  const c = new Client({host:'127.0.0.1',port,user:'fence_owner',database:'writer_fence',application_name:'wf_'+name,statement_timeout:10000});
  c.on('error',()=>{});
  await c.connect(); clients.add(c);
  if(schema) await c.query(`SET search_path TO "${schema}"`);
  c.proofPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return c;
}
async function close(c) {clients.delete(c); await c.end().catch(()=>{});}
async function refusal(operation, codes, label) {
  let error;
  try {await operation();} catch(e) {error=e;}
  check(error && codes.includes(error.code), label, {sqlstate:error?.code});
  return error;
}
async function waitForLock(observer, c, operation) {
  const deadline=performance.now()+4000;
  while(performance.now()<deadline) {
    if(operation?.settled) throw new Error('Operation settled before intended lock boundary: '+JSON.stringify(operation.result));
    const rows=(await observer.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[c.proofPid])).rows;
    if(rows[0]?.wait_event_type==='Lock') return record('LOCK_REACHED',{pid:c.proofPid,wait:rows[0].wait_event});
    await new Promise(r=>setTimeout(r,10));
  }
  throw new Error('Intended PostgreSQL lock boundary was not reached');
}
function observe(promise) {
  const state={settled:false,result:undefined};
  state.promise=promise.then(value=>{state.settled=true;state.result={ok:true};return {ok:true,value};},error=>{state.settled=true;state.result={ok:false,code:error.code};return {ok:false,error};});
  return state;
}
async function setup(admin,schema) {
  await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
    CREATE TABLE plugin_state_entries(plugin_id text NOT NULL,namespace text NOT NULL,entry_key text NOT NULL,value_json text NOT NULL,created_at bigint NOT NULL,expires_at bigint,PRIMARY KEY(plugin_id,namespace,entry_key));
    CREATE TABLE mechanism_marker(phase text NOT NULL);
    CREATE TABLE unrelated_table(value int NOT NULL);
    INSERT INTO mechanism_marker VALUES('before'); INSERT INTO unrelated_table VALUES(1);
    INSERT INTO plugin_state_entries VALUES('codex','app-server-thread-bindings','bound','{"synthetic":1}',1,0),('other','ordinary','legacy','{"version":1}',1,NULL);`);
}
async function cutover(c) {
  await c.query("BEGIN; ALTER TABLE plugin_state_entries RENAME TO plugin_state_records; CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required'::text AS unsupported_format; UPDATE mechanism_marker SET phase='after'; COMMIT");
}
const key=['codex','app-server-thread-bindings','bound'];
const commands=[
 ['read','SELECT value_json FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',key],
 ['upsert','INSERT INTO plugin_state_entries(plugin_id,namespace,entry_key,value_json,created_at) VALUES($1,$2,$3,$4,1) ON CONFLICT(plugin_id,namespace,entry_key) DO UPDATE SET value_json=excluded.value_json',[...key,'{"old":"upsert"}']],
 ['update','UPDATE plugin_state_entries SET value_json=$4 WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',[...key,'{"old":"update"}']],
 ['cas','UPDATE plugin_state_entries SET value_json=$4 WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3 AND value_json=$5',[...key,'{"old":"cas"}','{"synthetic":1}']],
 ['delete','DELETE FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',key],
 ['clear','DELETE FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2',key.slice(0,2)],
 ['expiry','DELETE FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2 AND expires_at<=$3',[...key.slice(0,2),10]],
 ['move','UPDATE plugin_state_entries SET namespace=$4 WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',[...key,'replacement']],
];
async function preparedMode(admin, mode) {
 const schema='wf_'+mode;
 await setup(admin,schema);
 const old=await client(mode+'_old',schema), queued=await client(mode+'_queued',schema), migrate=await client(mode+'_migration',schema);
 await old.query('SET plan_cache_mode=force_'+mode+'_plan');
 await queued.query('SET plan_cache_mode=force_'+mode+'_plan');
 for(const [name,text,values] of commands) {
   await old.query('BEGIN'); await old.query({name:mode+'_'+name,text,values}); await old.query('ROLLBACK');
 }
 const update=commands.find(([name])=>name==='update');
 await queued.query('BEGIN'); await queued.query({name:mode+'_queued_update',text:update[1],values:update[2]}); await queued.query('ROLLBACK');
 const plans=(await old.query('SELECT name,generic_plans::int,custom_plans::int FROM pg_prepared_statements ORDER BY name')).rows;
 check(plans.length===commands.length && plans.every(p=>p[mode+'_plans']>0),mode+' native cached '+mode+' plans reached',{plans});
 await old.query('BEGIN');
 await old.query({name:mode+'_update',text:update[1],values:[...key,'{"held":"before-cutover"}']});
 await migrate.query('BEGIN');
 const rename=observe(migrate.query('ALTER TABLE plugin_state_entries RENAME TO plugin_state_records'));
 await waitForLock(admin,migrate,rename);
 const waiting=observe(queued.query({name:mode+'_queued_update',text:update[1],values:[...key,'{"queued":"must-not-commit"}']}));
 await waitForLock(admin,queued,waiting);
 check(!rename.settled && !waiting.settled,mode+' active writer and queued writer boundary held');
 await old.query('COMMIT');
 const renamed=await rename.promise; check(renamed.ok,mode+' migration joins pre-cutover writer');
 check(!waiting.settled,mode+' queued writer stays blocked during rename transaction');
 await migrate.query("CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required'::text AS unsupported_format; UPDATE mechanism_marker SET phase='after'");
 equal((await admin.query(`SELECT phase FROM "${schema}".mechanism_marker`)).rows,[{phase:'before'}],mode+' publication marker invisible before commit');
 await migrate.query('COMMIT');
 const queuedResult=await waiting.promise;
 check(!queuedResult.ok && ['42703','55000','42809','42P01'].includes(queuedResult.error.code),mode+' queued pre-cutover prepared writer refuses after commit',{sqlstate:queuedResult.error?.code});
 equal((await admin.query(`SELECT value_json FROM "${schema}".plugin_state_records WHERE entry_key='bound'`)).rows,[{value_json:'{"held":"before-cutover"}'}],mode+' only acknowledged original writer effect retained');
 for(const [name,text,values] of commands) await refusal(()=>old.query({name:mode+'_'+name,text,values}),['42703','55000','42809','42P01'],mode+' warm prepared '+name+' refused');
 await refusal(()=>old.query('TRUNCATE plugin_state_entries'),['42809'],mode+' old truncate refused');
 await refusal(()=>old.query('DROP TABLE IF EXISTS plugin_state_entries'),['42809'],mode+' old scoped DROP TABLE refuses view');
 equal((await old.query('SELECT * FROM plugin_state_entries')).rows,[{unsupported_format:'upgrade-required'}],mode+' tombstone exposes constant only');
 await old.query('UPDATE unrelated_table SET value=value+1');
 equal((await old.query('SELECT value FROM unrelated_table')).rows,[{value:2}],mode+' unrelated old-table writes remain available');
 const fresh=await client(mode+'_reconnect',schema);
 await refusal(()=>fresh.query(commands[0][1],key),['42703'],mode+' reconnected old SQL refused');
 await refusal(()=>fresh.query('CREATE TABLE plugin_state_entries(value text)'),['42P07'],mode+' old-name table recreation refused');
 const current=await client(mode+'_current',schema);
 equal((await current.query("UPDATE plugin_state_records SET value_json=$1 WHERE plugin_id='other' AND namespace='ordinary' AND entry_key='legacy' RETURNING value_json",['{"version":1,"updated":true}'])).rows,[{value_json:'{"version":1,"updated":true}'}],mode+' current-name ordinary V1 positive');
 equal((await current.query('SELECT phase FROM mechanism_marker')).rows,[{phase:'after'}],mode+' marker and canonical relation committed');
 equal((await current.query("SELECT relname,relkind FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('plugin_state_entries','plugin_state_records') ORDER BY relname",[schema])).rows,[{relname:'plugin_state_entries',relkind:'v'},{relname:'plugin_state_records',relkind:'r'}],mode+' one canonical table plus constant guard view');
 await current.query('DROP TABLE unrelated_table');
 check(true,mode+' ordinary DROP TABLE control succeeds');
 for(const c of [current,fresh,migrate,queued,old]) await close(c);
}
async function rollbackControl(admin) {
 const schema='wf_rollback'; await setup(admin,schema);
 const old=await client('rollback_old',schema), migrate=await client('rollback_migration',schema);
 await old.query({name:'rollback_read',text:commands[0][1],values:key});
 await migrate.query("BEGIN; ALTER TABLE plugin_state_entries RENAME TO plugin_state_records; CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required'::text AS unsupported_format; UPDATE mechanism_marker SET phase='after'; ROLLBACK");
 equal((await old.query({name:'rollback_read',text:commands[0][1],values:key})).rows,[{value_json:'{"synthetic":1}'}],'rollback restores warm old prepared access and original data');
 equal((await old.query('SELECT phase FROM mechanism_marker')).rows,[{phase:'before'}],'rollback restores publication marker');
 equal((await old.query("SELECT relname,relkind FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('plugin_state_entries','plugin_state_records') ORDER BY relname",[schema])).rows,[{relname:'plugin_state_entries',relkind:'r'}],'rollback restores original relation and removes guard');
 await close(old); await close(migrate);
}
async function readonlyControl(admin) {
 const schema='wf_readonly'; await setup(admin,schema);
 const old=await client('snapshot_old',schema), migrate=await client('snapshot_migration',schema);
 await old.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await old.query(commands[0][1],key);
 const operation=observe(cutover(migrate)); await waitForLock(admin,migrate,operation);
 check(!operation.settled,'read-only old transaction retains relation lock and delays cutover');
 await old.query('ROLLBACK'); check((await operation.promise).ok,'cutover joins read-only transaction before publication');
 await refusal(()=>old.query(commands[0][1],key),['42703'],'released old snapshot cannot start old-name read');
 await close(old); await close(migrate);
}
async function interrupted(admin, sendCommit) {
 const schema='wf_interrupted_'+Number(sendCommit); await setup(admin,schema);
 const migrate=await client('interrupt_'+Number(sendCommit),schema);
 await migrate.query("BEGIN; ALTER TABLE plugin_state_entries RENAME TO plugin_state_records; CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required'::text AS unsupported_format; UPDATE mechanism_marker SET phase='after'");
 let outcome;
 if(sendCommit) { outcome=observe(migrate.query('COMMIT')); migrate.connection.stream.destroy(); await outcome.promise; }
 else {migrate.connection.stream.destroy();}
 await close(migrate);
 const deadline=performance.now()+3000;
 while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[migrate.proofPid])).rowCount && performance.now()<deadline) await new Promise(r=>setTimeout(r,10));
 const phase=(await admin.query(`SELECT phase FROM "${schema}".mechanism_marker`)).rows[0].phase;
 const relations=(await admin.query("SELECT relname,relkind FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('plugin_state_entries','plugin_state_records') ORDER BY relname",[schema])).rows;
 const before=[{relname:'plugin_state_entries',relkind:'r'}];
 const after=[{relname:'plugin_state_entries',relkind:'v'},{relname:'plugin_state_records',relkind:'r'}];
 equal(relations,phase==='before'?before:after,'interrupted '+sendCommit+' leaves coherent physical publication');
 if(!sendCommit) equal(phase,'before','pre-COMMIT connection loss rolls back');
 else record('UNCERTAIN_COMMIT_RECONCILED',{phase,reply:outcome.result,replayed:false});
}
let failure;
try {
 const admin=await client('observer');
 const server=(await admin.query('SELECT version() AS version,current_setting(\'server_version_num\') AS server_version_num')).rows[0];
 record('VERSIONS',{base:'9a1a7541d53f6e5f26e26b44a5806e0d09c81903',node:process.version,pgClient:require(pgPackage).version,pgPackage,server,container,port});
 await preparedMode(admin,'generic'); await preparedMode(admin,'custom');
 await rollbackControl(admin); await readonlyControl(admin); await interrupted(admin,false); await interrupted(admin,true);
 record('COMPLETE',{assertions});
} catch(error) {failure={message:error.message,stack:error.stack,code:error.code};record('FAIL',failure);process.exitCode=1;}
finally {
 for(const c of [...clients]) await close(c);
 const bytes=readFileSync(new URL(import.meta.url));
 writeFileSync(artifact,JSON.stringify({kind:'supporting-native-engine-proof',started,ended:new Date().toISOString(),elapsedMs:performance.now()-start,assertions,passed:!failure,failure,scriptSha256:createHash('sha256').update(bytes).digest('hex'),events},null,2)+'\n');
}
