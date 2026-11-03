// Preparation only: execute after the coordinator approves the reviewed package.
// This trusted operator fixture uses the public SDK export; it is not a loaded plugin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  "package-root": { type: "string" }, "evidence-dir": { type: "string" },
} });
assert(values["package-root"] && values["evidence-dir"], "package-root and fresh evidence-dir required");
const packageRoot = realpathSync(values["package-root"]);
const evidence = resolve(values["evidence-dir"]);
mkdirSync(evidence, { mode: 0o700 });
const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(metadata.name, "openclaw");
const publicTarget = metadata.exports?.["./plugin-sdk/plugin-state-store-runtime"]?.default;
assert.equal(publicTarget, "./dist/plugin-sdk/plugin-state-store-runtime.js");
const sdkPath = createRequire(join(packageRoot, "package.json"))
  .resolve("openclaw/plugin-sdk/plugin-state-store-runtime");
assert.equal(realpathSync(sdkPath), realpathSync(resolve(packageRoot, publicTarget)));

const scratch = mkdtempSync("${DISPOSABLE_RUNTIME}/writer-fence-built-sdk-");
assert.equal(statSync(scratch).mode & 0o777, 0o700);
const directories = Object.fromEntries(["home", "state", "tmp", "cache", "workspace"]
  .map((name) => { const path = join(scratch, name); mkdirSync(path, { mode: 0o700 }); return [name, path]; }));
const config = join(directories.state, "openclaw.json");
writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace: directories.workspace } },
  plugins: { allow: [] } }), { mode: 0o600 });
const taskPath = process.env.PATH;
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: taskPath, HOME: directories.home, TMPDIR: directories.tmp,
  XDG_CACHE_HOME: directories.cache, OPENCLAW_STATE_DIR: directories.state,
  OPENCLAW_CONFIG_PATH: config, NO_COLOR: "1", CI: "1" });
process.chdir(scratch);
const sdk = await import(pathToFileURL(sdkPath).href);
assert.equal(typeof sdk.createPluginStateSyncKeyedStore, "function");
const bounded = (namespace) => ({ namespace, maxEntries: 64, overflowPolicy: "reject-new" });
// An explicit trusted SDK caller id is not registered-plugin provenance or native authority.
const ordinary = sdk.createPluginStateSyncKeyedStore("codex", bounded("writer-fence-proof-ordinary"));
ordinary.register("positive-before", "ordinary");
assert.equal(ordinary.lookup("positive-before"), "ordinary");
const managed = sdk.createPluginStateSyncKeyedStore("codex", bounded("app-server-thread-bindings"));
const legacy = { version: 1, state: "active", sessionId: "fixture",
  binding: { threadId: "thread", cwd: "/synthetic" }, opaqueFixture: { retained: true } };
managed.register("v1-control", legacy);
assert.deepEqual(managed.lookup("v1-control"), legacy);
assert.equal(managed.delete("v1-control"), true);
const databasePath = join(directories.state, "state", "openclaw.sqlite");
const physical = statSync(databasePath);
const database = new DatabaseSync(databasePath);
const rows = () => database.prepare("SELECT plugin_id,namespace,entry_key,value_json,created_at,expires_at FROM plugin_state_records ORDER BY plugin_id,namespace,entry_key").all();
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receipt = { supportingBuiltSdkOnly: true, packageRoot, sdkPath, scratch,
  startUtc: new Date().toISOString(), managedV1Positive: true,
  physicalIdentity: [physical.dev, physical.ino], attempts: [] };
try {
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 40);
  assert.equal(database.prepare("SELECT type FROM sqlite_schema WHERE name='plugin_state_entries'").get().type, "view");
  // Raw saved-data fixture only. These bytes confer no native content/action authority.
  const future = JSON.stringify({ version: 5, opaque: "synthetic saved unsupported record" });
  const insert = database.prepare("INSERT INTO plugin_state_records(plugin_id,namespace,entry_key,value_json,created_at,expires_at) VALUES ('codex','app-server-thread-bindings',?,?,1,?)");
  insert.run("future", future, null);
  insert.run("expired-future", future, 1);
  const saved = rows();
  /** @type {Array<[string, () => unknown]>} */
  const attempts = [
    ["overwrite", () => managed.register("future", legacy)],
    ["delete", () => managed.delete("future")],
    ["clear", () => managed.clear()],
    ["expiry-trigger", () => managed.register("new-valid", legacy)],
    ["consume", () => managed.consume("future")],
  ];
  for (const [operation, run] of attempts) {
    let failure;
    try { run(); } catch (error) { failure = error; }
    assert(failure, `unexpected-success:${operation}`);
    const messages = [];
    for (let cause = failure; cause && messages.length < 8; cause = cause.cause) messages.push(String(cause.message));
    assert.match(messages.join(" "), /Unsupported native session binding\. Use a compatible OpenClaw build; the saved binding has been preserved\./u,
      `unqualified-refusal:${operation}`);
    assert.deepEqual(rows(), saved, `saved-bytes-changed:${operation}`);
    receipt.attempts.push({ operation, refusedUnsupportedBinding: true, exactRowsPreserved: true });
  }
  ordinary.register("positive-after", "ordinary");
  assert.equal(ordinary.lookup("positive-after"), "ordinary");
  const now = statSync(databasePath);
  assert.deepEqual([now.dev, now.ino], receipt.physicalIdentity);
  receipt.savedRowsHash = fingerprint(saved);
  receipt.ordinaryBeforeAndAfter = true;
  receipt.result = "selected-public-sync-sdk-guard-assertions-reached";
} finally {
  database.close();
  receipt.endUtc = new Date().toISOString();
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
