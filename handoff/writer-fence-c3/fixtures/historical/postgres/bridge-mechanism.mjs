import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Worker,MessageChannel} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
const root='${OPENCLAW_CHECKOUT}/.worktrees/retained-binding-writer-fence';
const require=createRequire(root+'/package.json');
const {Client}=require('pg');
const receipt=JSON.parse(readFileSync(new URL('./bridge-inputs.json',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function verifyInputs(){for(const input of [...receipt.inputs,receipt.output])assert.equal(sha(readFileSync(input.path)),input.sha256,'pinned bridge input changed: '+input.path);}
verifyInputs();
const port=Number(execFileSync('docker',['port','openclaw-writer-fence-pg-20261102-1743','5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1));
const connection=`postgresql://fence_owner@127.0.0.1:${port}/writer_fence`;
const admin=new Client({connectionString:connection,application_name:'wf_bridge_observer'});
admin.on('error',()=>{});
const host=new MessageChannel();
const serviceSignal=new SharedArrayBuffer(8);
const worker=new Worker(new URL('./compiled/bridge.worker.cjs',import.meta.url),{workerData:{host:host.port2,signal:serviceSignal,peers:[]},transferList:[host.port2]});
const endpoints=new Set();
const runTag=Date.now().toString(36);
const events=[];let assertions=0;const started=new Date().toISOString(),start=performance.now();
const record=(event,details={})=>{const row={event,ms:Math.round(performance.now()-start),...details};events.push(row);process.stdout.write(JSON.stringify(row)+'\n');};
const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);assertions++;record('PASS',{label});};
const check=(condition,label,details={})=>{assert(condition,label);assertions++;record('PASS',{label,...details});};
function deadline(promise,label,ms=6000){let t;return Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error(label+' timed out')),ms);})]).finally(()=>clearTimeout(t));}
const ready=deadline(new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>reject(new Error('bridge exited before readiness '+code)));}),'bridge readiness');
function observe(promise){const value={settled:false};value.promise=promise.then(result=>{value.settled=true;return{ok:true,result};},error=>{value.settled=true;return{ok:false,error};});return value;}
async function endpoint(schema){
 const channel=new MessageChannel(),signal=new SharedArrayBuffer(8),pending=new Map();let id=0,closed=false;
 const fail=error=>{for(const request of pending.values())request.reject(error);pending.clear();};
 channel.port1.on('message',reply=>{const request=pending.get(reply.id);if(!request)return;pending.delete(reply.id);if(reply.error){const error=new Error(reply.error.message);Object.assign(error,reply.error);request.reject(error);}else request.resolve(reply.result??reply.reusable);});
 const workerFailure=error=>fail(error instanceof Error?error:new Error('bridge service exited '+error));
 worker.on('error',workerFailure);worker.on('exit',workerFailure);
 host.port1.postMessage({connection:{port:channel.port2,signal,url:connection,schema,connectTimeoutMs:3000,lockTimeoutMs:5000,statementTimeoutMs:5000}},[channel.port2]);
 const request=command=>deadline(new Promise((resolve,reject)=>{if(closed)return reject(new Error('endpoint closed'));const next=++id;pending.set(next,{resolve,reject});channel.port1.postMessage({...command,id:next});}),'bridge SQL');
 const ep={schema,request,query:(sql,parameters=[],extra={})=>request({operation:'query',schema,sql,parameters,...extra}),async close(){if(closed)return;try{await request({operation:'close'});}catch{}finally{closed=true;channel.port1.close();worker.off('error',workerFailure);worker.off('exit',workerFailure);endpoints.delete(ep);fail(new Error('endpoint closed'));}}};
 endpoints.add(ep);await request({operation:'connect',schema});ep.pid=(await ep.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return ep;
}
async function refuses(operation,codes,label){let error;try{await operation();}catch(e){error=e;}record('REFUSAL_OBSERVED',{label,sqlstate:error?.code,message:error?.message});check(error&&codes.includes(error.code),label,{sqlstate:error?.code});}
async function waitLock(pid,operation){const limit=performance.now()+3000;while(performance.now()<limit){if(operation.settled)throw new Error('operation settled before SQL lock boundary');if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rowCount){record('LOCK_REACHED',{pid});return;}await new Promise(r=>setTimeout(r,10));}throw new Error('unreached lock boundary');}
const key=['codex','app-server-thread-bindings','bound'];
const commands=[
 ['read','SELECT value_json FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',key],
 ['upsert','INSERT INTO plugin_state_entries(plugin_id,namespace,entry_key,value_json,created_at,expires_at) VALUES($1,$2,$3,$4,1,NULL) ON CONFLICT(plugin_id,namespace,entry_key) DO UPDATE SET value_json=excluded.value_json',[...key,'{"old":"upsert"}']],
 ['cas','UPDATE plugin_state_entries SET value_json=$4 WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3 AND value_json=$5',[...key,'{"old":"cas"}','{"seed":1}']],
 ['delete','DELETE FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',key],
 ['clear','DELETE FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2',key.slice(0,2)],
 ['expiry','DELETE FROM plugin_state_entries WHERE plugin_id=$1 AND namespace=$2 AND expires_at<=$3',[...key.slice(0,2),10]],
 ['move','UPDATE plugin_state_entries SET namespace=$4 WHERE plugin_id=$1 AND namespace=$2 AND entry_key=$3',[...key,'replacement']],
];
async function runMode(mode){
 const schema='wf_bridge_'+mode+'_'+runTag;
 await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".plugin_state_entries(plugin_id text,namespace text,entry_key text,value_json text,created_at bigint,expires_at bigint,PRIMARY KEY(plugin_id,namespace,entry_key)); INSERT INTO "${schema}".plugin_state_entries VALUES('codex','app-server-thread-bindings','bound','{"seed":1}',1,0),('other','ordinary','legacy','{"version":1}',1,NULL)`);
 const old=await endpoint(schema),queued=await endpoint(schema);
 for(const ep of [old,queued])await ep.query('SET plan_cache_mode=force_'+mode+'_plan');
 for(const [,sql,values]of commands){await old.query('BEGIN');await old.query(sql,values);await old.query('ROLLBACK');}
 await old.query('SELECT * FROM plugin_state_entries WHERE entry_key=$1',['bound']);
 const update='UPDATE plugin_state_entries SET value_json=$1 WHERE entry_key=$2';
 await queued.query('BEGIN');await queued.query(update,['{"warm":1}','bound']);await queued.query('ROLLBACK');
 const plans=(await old.query('SELECT name,generic_plans::int,custom_plans::int FROM pg_prepared_statements')).rows;
 check(plans.length>=commands.length&&plans.every(p=>p[mode+'_plans']>0),'bridge '+mode+' actual server cache populated',{plans});
 await old.query('BEGIN');await old.query(update,['{"held":1}','bound']);
 const migration=new Client({connectionString:connection,application_name:'wf_bridge_migration_'+mode});migration.on('error',()=>{});await migration.connect();
 try{
  await migration.query(`SET search_path TO "${schema}"; BEGIN`);
  const migrationPid=(await migration.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const rename=observe(migration.query('ALTER TABLE plugin_state_entries RENAME TO plugin_state_records'));await waitLock(migrationPid,rename);
  const waiting=observe(queued.query(update,['{"queued":"forbidden"}','bound']));await waitLock(queued.pid,waiting);
  await old.query('COMMIT');check((await rename.promise).ok,'bridge '+mode+' original acknowledged writer drains before rename');
  check(!waiting.settled,'bridge '+mode+' queued writer held through cutover transaction');
  await migration.query("CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required'::text AS unsupported_format; COMMIT");
  const result=await waiting.promise;check(!result.ok&&['42703','55000','42809'].includes(result.error.code),'bridge '+mode+' actual queued cached writer refuses',{sqlstate:result.error?.code});
  for(const [name,sql,values]of commands)await refuses(()=>old.query(sql,values),['42703','55000','42809'],'bridge '+mode+' cached '+name+' refused');
  equal((await old.query('SELECT * FROM plugin_state_entries WHERE entry_key=$1',['bound']).catch(error=>({error:error.code}))),{error:'42703'},'bridge '+mode+' SELECT-star with old predicate cannot read new data');
  await refuses(()=>old.query('DROP TABLE IF EXISTS plugin_state_entries'),['42809'],'bridge '+mode+' old DROP TABLE refuses guard view');
  equal((await admin.query(`SELECT value_json FROM "${schema}".plugin_state_records WHERE entry_key='bound'`)).rows,[{value_json:'{"held":1}'}],'bridge '+mode+' no queued or denied mutation effect');
  const fresh=await endpoint(schema);await refuses(()=>fresh.query(commands[0][1],key),['42703'],'bridge '+mode+' new old-name connection refused');
  equal((await fresh.query("UPDATE plugin_state_records SET value_json=$1 WHERE namespace='ordinary' RETURNING value_json",['{"version":1,"current":true}'])).rows,[{value_json:'{"version":1,"current":true}'}],'bridge '+mode+' current-name ordinary V1 positive');
  // A returned idle transport may reconnect; it still receives no name translation.
  equal(await fresh.request({operation:'release'}),true,'bridge '+mode+' idle transport released outside transaction');
  await admin.query('SELECT pg_terminate_backend($1)',[fresh.pid]);
  await refuses(()=>fresh.query(commands[0][1],key,{reconnectIfIdle:true,validateIfIdle:true}),['42703'],'bridge '+mode+' transport reconnect preserves old-format refusal');
  await fresh.close();
 }finally{await old.close();await queued.close();await migration.end().catch(()=>{});}
}
let failure;
try{await ready;await admin.connect();record('READY',{base:receipt.base,inputs:receipt.inputs.length,compiled:receipt.output,pgClient:require('pg/package.json').version,server:(await admin.query('SHOW server_version')).rows[0]});await runMode('generic');await runMode('custom');verifyInputs();record('COMPLETE',{assertions,sourceGuard:'unchanged'});}
catch(error){failure={message:error.message,code:error.code,stack:error.stack};record('FAIL',failure);process.exitCode=1;}
finally{for(const ep of [...endpoints])await ep.close();await admin.end().catch(()=>{});host.port1.close();await worker.terminate();writeFileSync(new URL('./bridge-result.json',import.meta.url),JSON.stringify({kind:'supporting-pinned-production-bridge-proof',started,ended:new Date().toISOString(),elapsedMs:performance.now()-start,assertions,passed:!failure,failure,inputReceipt:'bridge-inputs.json',events},null,2)+'\n');}
