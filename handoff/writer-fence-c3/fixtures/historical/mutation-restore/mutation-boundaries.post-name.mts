import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
process.umask(0o077);
const source=process.argv[2], label=process.argv[3]; assert(source && label);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),'9a1a7541d53f6e5f26e26b44a5806e0d09c81903');
const root=fs.mkdtempSync('${DISPOSABLE_RUNTIME}/writer-fence-mutation-'); fs.mkdirSync(path.join(root,'tmp'),{mode:0o700});
for (const p of [root,path.join(root,'tmp')]) assert.equal(fs.statSync(p).mode&0o777,0o700);
Object.assign(process.env,{TMPDIR:path.join(root,'tmp'),OPENCLAW_STATE_DIR:path.join(root,'state'),OPENCLAW_HOME:path.join(root,'home'),OPENCLAW_CONFIG_PATH:path.join(root,'no-config.json'),OPENCLAW_BUNDLED_PLUGINS_DIR:path.join(source,'extensions'),NODE_ENV:'test'});
const load=(p:string)=>import(pathToFileURL(path.join(source,p)).href);
const tmp=await load('src/infra/tmp-openclaw-dir.ts'); assert(tmp.resolvePreferredOpenClawTmpDir().startsWith(path.join(root,'tmp')+path.sep));
const k=await load('src/plugin-state/plugin-state-store.kernel.ts'), m=await load('src/plugin-state/plugin-state-store.mutations.ts'), r=await load('src/plugin-state/plugin-state-store.retention.ts'), mv=await load('src/plugin-state/plugin-state-store.moves.worker.ts'), codec=await load('src/plugin-state/plugin-state-native-binding-codec.ts'), tx=await load('src/infra/sqlite-transaction.ts'), op=await load('src/plugin-state/plugin-state-operation.kernel.ts');
const scope={pluginId:'codex',namespace:'app-server-thread-bindings'};
if(codec.preparePluginStateNativeBindingMutation) codec.preparePluginStateNativeBindingMutation(scope,process.env);
await codec.preparePluginStateNativeBindingCodec({codec:'codex'},process.env);
const v1={version:1,state:'active',sessionId:'fixture',binding:{threadId:'thread',cwd:'/synthetic'}};
const future={version:5,opaque:'future-owner-data',authority:'none'};
const schema=fs.readFileSync(path.join(source,'src/state/openclaw-state-schema.sql'),'utf8');
function fixture(){ const db=new DatabaseSync(':memory:'); db.exec(schema); return {db,path:':memory:'}; }
function seed(s:any,key:string,value:any,expires:number|null=null,namespace=scope.namespace,pluginId=scope.pluginId,created=1){s.db.prepare('INSERT INTO plugin_state_records VALUES (?,?,?,?,?,?)').run(pluginId,namespace,key,JSON.stringify(value),created,expires);}
function rows(s:any){return s.db.prepare('SELECT * FROM plugin_state_records ORDER BY plugin_id,namespace,entry_key').all();}
function run(s:any,f:()=>any){return tx.runSqliteImmediateTransactionSync(s.db,f);}
const entry=(key:string,value:any)=>({...scope,key,valueJson:JSON.stringify(value),maxEntries:10,overflowPolicy:'evict-oldest'});
function refuses(s:any,f:()=>any){const before=rows(s);assert.throws(()=>run(s,f),/unsupported|newer|preserv|native.*binding/i);assert.deepEqual(rows(s),before);}
const results:any[]=[];
function test(name:string,f:(s:any)=>void){const s=fixture();try{f(s);results.push({name,status:'passed'});}catch(e){results.push({name,status:'failed',error:String(e),stack:e instanceof Error?e.stack:undefined});}finally{s.db.close();}process.stdout.write(JSON.stringify(results.at(-1))+'\n');}
test('generic-upsert-refuses-future-original',s=>{seed(s,'saved',future); refuses(s,()=>r.registerPluginStateEntry(s,entry('saved',v1)));});
test('generic-upsert-refuses-future-postimage',s=>{seed(s,'saved',v1); refuses(s,()=>r.registerPluginStateEntry(s,entry('saved',future)));});
test('generic-delete-refuses-future-original',s=>{seed(s,'saved',future);refuses(s,()=>k.deletePluginStateEntry(s.db,{...scope,key:'saved'}));});
test('consume-refuses-future-original',s=>{seed(s,'saved',future);refuses(s,()=>m.consumePluginStateEntry(s,{...scope,key:'saved'}));});
test('namespace-clear-refuses-future-and-preserves-ordinary',s=>{seed(s,'saved',future);seed(s,'ordinary',v1);refuses(s,()=>m.clearPluginStateNamespace(s.db,scope));});
test('expiry-refuses-expired-future-original',s=>{seed(s,'saved',future,1);refuses(s,()=>k.deleteExpiredPluginStateEntries(s.db,Date.now(),scope));});
test('insert-if-absent-refuses-expired-future-original',s=>{seed(s,'saved',future,1);refuses(s,()=>m.registerPluginStateEntryIfAbsent(s,entry('saved',v1)));});
test('quota-refuses-future-victim-and-rolls-back-insert',s=>{seed(s,'saved',future);refuses(s,()=>r.registerPluginStateEntry(s,{...entry('new',v1),maxEntries:1}));});
test('move-refuses-future-source',s=>{seed(s,'saved',future);refuses(s,()=>mv.movePluginStateEntries(s,{pluginId:'codex',sourceNamespace:scope.namespace,namespace:'@retained.'+scope.namespace,entries:[{sourceKey:'saved',targetKey:'saved'}]}));});
test('move-refuses-expired-future-destination',s=>{seed(s,'saved',v1);seed(s,'saved',future,1,'@retained.'+scope.namespace);refuses(s,()=>mv.movePluginStateEntries(s,{pluginId:'codex',sourceNamespace:scope.namespace,namespace:'@retained.'+scope.namespace,entries:[{sourceKey:'saved',targetKey:'saved'}]}));});
test('unknown-V1-field-cannot-be-stripped-by-canonical-codec',s=>{seed(s,'saved',{...v1,producingWindow:{sessionId:'future-window'}});refuses(s,()=>k.deletePluginStateEntry(s.db,{...scope,key:'saved'}));});
test('typed-delete-refuses-unknown-V1-envelope',s=>{const lease={token:'token',expiresAt:Date.now()+60_000};seed(s,'saved',{...v1,lease,producingWindow:{sessionId:'future-window'}});const before=rows(s);let result:any;try{result=run(s,()=>m.deletePluginStateNativeBinding(s,{...scope,key:'saved',codec:'codex',predicate:{kind:'leased',token:'token',value:v1},maxEntries:10,overflowPolicy:'reject-new',staleMs:1000,deletionChanged:'changed',rollbackChanged:'changed'}));}catch(e){assert.match(String(e),/unsupported|newer|preserv|native.*binding/i);}if(result)assert.equal(result.status,'conflict');assert.deepEqual(rows(s),before);});
test('ordinary-V1-upsert-delete-positive',s=>{run(s,()=>r.registerPluginStateEntry(s,entry('saved',v1)));assert.equal(rows(s).length,1);assert.equal(run(s,()=>k.deletePluginStateEntry(s.db,{...scope,key:'saved'})),1);assert.equal(rows(s).length,0);});
test('ordinary-other-namespace-future-shaped-value-positive',s=>{run(s,()=>r.registerPluginStateEntry(s,{...entry('saved',future),namespace:'ordinary'}));assert.equal(run(s,()=>k.deletePluginStateEntry(s.db,{...scope,namespace:'ordinary',key:'saved'})),1);});
test('other-plugin-same-namespace-positive',s=>{run(s,()=>r.registerPluginStateEntry(s,{...entry('saved',future),pluginId:'other'}));assert.equal(run(s,()=>k.deletePluginStateEntry(s.db,{...scope,pluginId:'other',key:'saved'})),1);});
test('ordinary-V1-retained-move-positive',s=>{seed(s,'saved',v1);assert.equal(run(s,()=>mv.movePluginStateEntries(s,{pluginId:'codex',sourceNamespace:scope.namespace,namespace:'@retained.'+scope.namespace,entries:[{sourceKey:'saved',targetKey:'saved'}]})),1);assert.equal(rows(s)[0].namespace,'@retained.'+scope.namespace);});
const paths=['plugin-state-native-binding-codec.ts','plugin-state-store.kernel.ts','plugin-state-store.mutations.ts','plugin-state-store.retention.ts','plugin-state-store.moves.worker.ts','plugin-state-store.sqlite.ts','plugin-state.worker.ts','plugin-state-operation.kernel.ts'].map(n=>'src/plugin-state/'+n);
const hashes=Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(fs.readFileSync(path.join(source,p))).digest('hex')]));
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),`mutation-post-name-${label}-results.json`),JSON.stringify({head:'9a1a7541d53f6e5f26e26b44a5806e0d09c81903',runtime:process.version,root,label,boundary:'actual production mutation/retention/typed-delete/move functions inside actual immediate transaction on official current DDL; data-only future fixture, no native authority',hashes,results},null,2)+'\n');
if(results.some(r=>r.status==='failed'))process.exitCode=1;
