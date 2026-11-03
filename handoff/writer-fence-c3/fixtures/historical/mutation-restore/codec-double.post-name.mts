import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
process.umask(0o077);
const source=process.argv[2],mode=process.argv[3];assert(source&&mode);
const root=fs.mkdtempSync('${DISPOSABLE_RUNTIME}/writer-fence-codec-');
for(const p of ['tmp','plugins','plugins/codex'])fs.mkdirSync(path.join(root,p),{mode:0o700});
assert.equal(fs.statSync(root).mode&0o777,0o700);
const namespace=mode==='changed-namespace'?'changed-by-newer-plugin':'app-server-thread-bindings';
const double=`export const nativeSessionBindingNamespace = ${JSON.stringify(namespace)}; export function readNativeSessionBindingRecord(value) { return value; }\n`;
fs.writeFileSync(path.join(root,'plugins/codex/package.json'),'{"type":"module","name":"codec-contract-double"}\n');
fs.writeFileSync(path.join(root,'plugins/codex/native-session-binding-api.js'),double);
// Supported test-only bundled-root override; these codec doubles grant no native authorization.
Object.assign(process.env,{TMPDIR:path.join(root,'tmp'),OPENCLAW_STATE_DIR:path.join(root,'state'),OPENCLAW_HOME:path.join(root,'home'),OPENCLAW_CONFIG_PATH:path.join(root,'no-config.json'),OPENCLAW_BUNDLED_PLUGINS_DIR:path.join(root,'plugins'),OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR:'1',VITEST:'true',NODE_ENV:'test'});
const load=(p:string)=>import(pathToFileURL(path.join(source,p)).href);
const codec=await load('src/plugin-state/plugin-state-native-binding-codec.ts');
const k=await load('src/plugin-state/plugin-state-store.kernel.ts');
const tx=await load('src/infra/sqlite-transaction.ts');
using db=new DatabaseSync(':memory:');db.exec('CREATE TABLE plugin_state_records (plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL, value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY(plugin_id, namespace, entry_key)) STRICT');
const scope={pluginId:'codex',namespace:'app-server-thread-bindings',key:'saved'};
const future={version:5,opaque:'data-only-future-codec-contract'};
db.prepare('INSERT INTO plugin_state_records VALUES (?,?,?,?,?,NULL)').run(scope.pluginId,scope.namespace,scope.key,JSON.stringify(future),1);
const before=db.prepare('SELECT * FROM plugin_state_records').all();
if(mode==='newer-decoder'){
 codec.preparePluginStateNativeBindingMutation(scope,process.env);
 assert.deepEqual(codec.readPreparedPluginStateNativeBinding({codec:'codex'},future),future,'double genuinely recognizes future payload');
 assert.throws(()=>tx.runSqliteImmediateTransactionSync(db,()=>k.deletePluginStateEntry(db,scope)),/Unsupported native session binding/);
}else if(mode==='changed-namespace'){
 assert.throws(()=>codec.preparePluginStateNativeBindingMutation(scope,process.env),/Unsupported native session binding namespace/);
}else if(mode==='ordinary-no-native-codec'){
 fs.unlinkSync(path.join(root,'plugins/codex/native-session-binding-api.js'));
 codec.preparePluginStateNativeBindingMutation({...scope,namespace:'ordinary'},process.env);
 tx.runSqliteImmediateTransactionSync(db,()=>k.upsertPluginStateEntry(db,{plugin_id:'codex',namespace:'ordinary',entry_key:'positive',value_json:JSON.stringify(future),created_at:2,expires_at:null}));
 assert.equal(db.prepare("SELECT count(*) AS n FROM plugin_state_records WHERE namespace='ordinary'").get()!.n,1);
}else throw new Error('unknown mode');
assert.deepEqual(db.prepare("SELECT * FROM plugin_state_records WHERE namespace='app-server-thread-bindings'").all(),before);
const result={mode,status:'passed',root,runtime:process.version,boundary:'synthetic decoder/metadata contract through real public-artifact loader and transaction owner on minimal physical-table fixture; no native authorization',doubleSha256:createHash('sha256').update(double).digest('hex'),codecSourceSha256:createHash('sha256').update(fs.readFileSync(path.join(source,'src/plugin-state/plugin-state-native-binding-codec.ts'))).digest('hex')};
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),`codec-post-name-${mode}-result.json`),JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');
