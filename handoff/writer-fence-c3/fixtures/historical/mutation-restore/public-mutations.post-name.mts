import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
process.umask(0o077);
const source=process.argv[2];assert(source);assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),'9a1a7541d53f6e5f26e26b44a5806e0d09c81903');
const root=fs.mkdtempSync('${DISPOSABLE_RUNTIME}/writer-fence-public-');const tmp=path.join(root,'tmp');fs.mkdirSync(tmp,{mode:0o700});
for(const p of [root,tmp])assert.equal(fs.statSync(p).mode&0o777,0o700);
Object.assign(process.env,{TMPDIR:tmp,OPENCLAW_STATE_DIR:path.join(root,'state'),OPENCLAW_HOME:path.join(root,'home'),OPENCLAW_CONFIG_PATH:path.join(root,'no-config.json'),OPENCLAW_AGENT_DIR:path.join(root,'agent'),OPENCLAW_BUNDLED_PLUGINS_DIR:path.join(source,'extensions'),NODE_ENV:'test'});
const load=(p:string)=>import(pathToFileURL(path.join(source,p)).href);
const tmpOwner=await load('src/infra/tmp-openclaw-dir.ts');assert(tmpOwner.resolvePreferredOpenClawTmpDir().startsWith(tmp+path.sep));
const stores=await load('src/plugin-state/plugin-state-store.ts');
const state=await load('src/state/openclaw-state-db.ts');
const db=state.openOpenClawStateDatabase({env:process.env}).db;
const scope={pluginId:'codex',namespace:'app-server-thread-bindings'};
const v1={version:1,state:'active',sessionId:'fixture',binding:{threadId:'thread',cwd:'/synthetic'}};
const future={version:5,opaque:'preexisting-future-data-only',authority:'none'};
const futureJson=JSON.stringify(future);
// Test fixture setup precedes all store observations. This raw seed claims no native authority.
for(const key of ['sync-register','sync-update','sync-deleteIf','sync-delete','sync-consume','sync-clear','async-register','async-delete','async-consume','async-clear','async-cas','doctor-bulk']) {
 db.prepare('INSERT INTO plugin_state_records VALUES (?,?,?,?,?,?)').run('codex',scope.namespace,key,futureJson,1,key==='async-expired-ifabsent'?1:null);
}
const sync=stores.createPluginStateSyncKeyedStore('codex',{namespace:scope.namespace,maxEntries:64,env:process.env});
const asyncStore=stores.createPluginStateKeyedStore('codex',{namespace:scope.namespace,maxEntries:64,env:process.env});
const readAll=()=>db.prepare('SELECT * FROM plugin_state_records WHERE plugin_id=? AND namespace=? ORDER BY entry_key').all('codex',scope.namespace);
let initial=readAll();const results:any[]=[];
async function test(name:string,run:()=>unknown|Promise<unknown>){try{await run();results.push({name,status:'passed'});}catch(e){results.push({name,status:'failed',error:String(e),stack:e instanceof Error?e.stack:undefined});}process.stdout.write(JSON.stringify(results.at(-1))+'\n');}
async function refuses(name:string,run:()=>unknown|Promise<unknown>){await test(name,async()=>{let error:unknown;try{await run();}catch(e){error=e;}assert(error,'actual API mutation must reject');assert.match(String(error),/unsupported.*native.*binding|preserv/i);assert.deepEqual(readAll(),initial);});}
try {
 await refuses('actual-sync-register-preserves-future',()=>sync.register('sync-register',v1));
 await refuses('actual-sync-update-preserves-future',()=>sync.update('sync-update',()=>v1));
 await refuses('actual-sync-deleteIf-preserves-future',()=>sync.deleteIf('sync-deleteIf',()=>true));
 await refuses('actual-sync-delete-preserves-future',()=>sync.delete('sync-delete'));
 await refuses('actual-sync-consume-preserves-future',()=>sync.consume('sync-consume'));
 await refuses('actual-sync-clear-preserves-future',()=>sync.clear());
 await refuses('actual-async-worker-register-preserves-future',()=>asyncStore.register('async-register',v1));
 await refuses('actual-async-worker-delete-preserves-future',()=>asyncStore.delete('async-delete'));
 await refuses('actual-async-worker-consume-preserves-future',()=>asyncStore.consume('async-consume'));
 await refuses('actual-async-worker-clear-preserves-future',()=>asyncStore.clear());
 await refuses('actual-async-worker-CAS-preserves-future',async()=>{const observed=await asyncStore.observe('async-cas');assert.deepEqual(observed.value,future);await asyncStore.compareAndApply('async-cas',observed.comparison,{operation:'update',action:'set',value:v1});});
 await refuses('actual-Doctor-bulk-delete-preserves-future',()=>stores.pluginStateDeleteEntriesIfUnchanged({...scope,env:process.env,entries:[{key:'doctor-bulk',valueJson:futureJson,createdAt:1,expiresAt:null}],assertOwnedInTransaction(database:any){assert.equal(database,db);}}));
 await test('actual-sync-ordinary-V1-positive',()=>{const ordinary=stores.createPluginStateSyncKeyedStore('codex',{namespace:scope.namespace,maxEntries:64,env:process.env});ordinary.register('positive',v1);assert.deepEqual(ordinary.lookup('positive'),v1);assert.equal(ordinary.delete('positive'),true);});
 await refuses('actual-async-worker-future-postimage-rejects-before-effect',()=>asyncStore.register('future-postimage',future));
 await test('actual-async-worker-canonical-V1-positive',async()=>{await asyncStore.register('positive',v1);assert.deepEqual(await asyncStore.lookup('positive'),v1);assert.equal(await asyncStore.delete('positive'),true);});
 db.prepare('INSERT INTO plugin_state_records VALUES (?,?,?,?,?,?)').run('codex',scope.namespace,'async-expired-ifabsent',futureJson,1,1); initial=readAll();
 await refuses('actual-async-worker-expired-if-absent-preserves-future',()=>asyncStore.registerIfAbsent('async-expired-ifabsent',v1));
 await test('actual-async-worker-other-namespace-positive',async()=>{const ordinary=stores.createPluginStateKeyedStore('codex',{namespace:'ordinary',maxEntries:64,env:process.env});await ordinary.register('positive',future);assert.deepEqual(await ordinary.lookup('positive'),future);assert.equal(await ordinary.delete('positive'),true);});
} finally {await state.closeOpenClawStateDatabaseAsync();}
const inputs=['src/plugin-state/plugin-state-native-binding-codec.ts','src/plugin-state/plugin-state-store.kernel.ts','src/plugin-state/plugin-state-store.mutations.ts','src/plugin-state/plugin-state-store.retention.ts','src/plugin-state/plugin-state-store.sqlite.ts','src/plugin-state/plugin-state.worker.ts','extensions/codex/native-session-binding-api.ts'];
const hashes=Object.fromEntries(inputs.map(p=>[p,createHash('sha256').update(fs.readFileSync(path.join(source,p))).digest('hex')]));
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'public-mutations-post-name-results.json'),JSON.stringify({runtime:process.version,root,head:'9a1a7541d53f6e5f26e26b44a5806e0d09c81903',hashes,results,boundary:'actual sync SDK / async worker / Doctor bulk-delete transaction owners on newly admitted private state; preexisting future JSON seed is data-only, no native authorization'},null,2)+'\n');
if(results.some(r=>r.status==='failed'))process.exitCode=1;
