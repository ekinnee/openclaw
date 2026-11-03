import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

process.umask(0o077);
const source = process.argv[2];
assert(source, "exact source checkout argument required");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
assert.equal(head, "9a1a7541d53f6e5f26e26b44a5806e0d09c81903");
const artifacts = path.dirname(fileURLToPath(import.meta.url));
const runRoot = fs.mkdtempSync("${DISPOSABLE_RUNTIME}/writer-fence-restore-");
const taskTmp = path.join(runRoot, "tmp");
fs.mkdirSync(taskTmp, { mode: 0o700 });
for (const directory of [runRoot, taskTmp]) {
  const stat = fs.statSync(directory);
  assert.equal(stat.uid, process.getuid!());
  assert.equal(stat.mode & 0o777, 0o700);
}
process.env.TMPDIR = taskTmp;
process.env.OPENCLAW_STATE_DIR = path.join(runRoot, "import-state");
process.env.OPENCLAW_CONFIG_PATH = path.join(runRoot, "no-import-config.json");
process.env.OPENCLAW_HOME = path.join(runRoot, "import-home");
const oldName = "plugin_state_entries";
const newName = "plugin_state_entries_cutover_probe";
const guardSql = `CREATE VIEW ${oldName} AS SELECT 'upgrade-required' AS unsupported_format`;
const sentinelFloor = 2_000_000_039; // Disposable experiment marker; no schema allocation.
const future = JSON.stringify({ version: 5, fixture: "opaque-future-binding", authority: "none" });
const schema = fs.readFileSync(path.join(source, "src/state/openclaw-state-schema.sql"), "utf8");
const results: object[] = [];
const hashes: Record<string, string> = {};
for (const name of ["src/infra/sqlite-migration-scoped-snapshot.ts", "src/commands/doctor-migration-backup-restore.ts", "src/infra/sqlite-strict.ts", "src/state/openclaw-state-schema.sql"]) {
  hashes[name] = createHash("sha256").update(fs.readFileSync(path.join(source, name))).digest("hex");
}
const load = (name: string) => import(pathToFileURL(path.join(source, name)).href);
const tempOwner = await load("src/infra/tmp-openclaw-dir.ts");
const resolvedTemp = tempOwner.resolvePreferredOpenClawTmpDir();
assert(resolvedTemp.startsWith(taskTmp + path.sep), `Canonical temp owner escaped task root: ${resolvedTemp}`);
const snapshot = await load("src/infra/sqlite-migration-scoped-snapshot.ts");
const strict = await load("src/infra/sqlite-strict.ts");

function fixture(name: string) {
  const stateDir = path.join(runRoot, name);
  const state = path.join(stateDir, "state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const filename = path.join(state, "openclaw.sqlite");
  using db = new DatabaseSync(filename);
  db.exec(schema);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    INSERT INTO schema_meta VALUES ('primary', 'global', 39, NULL, 'synthetic-current-official-fixture', 1, 1);
    PRAGMA user_version = 39;`);
  db.prepare(`INSERT INTO ${oldName} VALUES (?, ?, ?, ?, ?, NULL)`).run("codex", "app-server-thread-bindings", "fixture", JSON.stringify({ version: 1, state: "active", sessionId: "fixture", binding: { threadId: "legacy-thread", cwd: "/synthetic" } }), 1);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "no-config.json"), OPENCLAW_HOME: stateDir, NODE_ENV: "test" };
  return { filename, stateDir, env, backupPath: path.join(stateDir, "before.scoped.bak") };
}
function withDb<T>(filename: string, run: (db: DatabaseSync) => T): T { using db = new DatabaseSync(filename); return run(db); }
function cutover(filename: string) {
  withDb(filename, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}; ${guardSql}; PRAGMA user_version = ${sentinelFloor};`);
      db.prepare("UPDATE schema_meta SET schema_version = ?").run(sentinelFloor);
      db.prepare("INSERT OR REPLACE INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES (?,?,?)").run("state.schema.contentVersion", String(sentinelFloor), 2);
      db.prepare(`INSERT INTO ${newName} VALUES (?, ?, ?, ?, ?, NULL)`).run("codex", "app-server-thread-bindings", "future", future, 2);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}
function evidence(filename: string) {
  return withDb(filename, (db) => ({
    floor: db.prepare("PRAGMA user_version").get()!.user_version,
    metadata: db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get()!.schema_version,
    guard: db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(oldName),
    future: db.prepare(`SELECT value_json FROM ${newName} WHERE entry_key='future'`).get()!.value_json,
  }));
}
function assertGuard(filename: string) {
  const state = evidence(filename);
  assert.equal(state.guard?.type, "view"); assert.equal(state.guard?.sql, guardSql); assert.equal(state.future, future);
  withDb(filename, (db) => assert.throws(() => db.exec(`DELETE FROM ${oldName}`), /view|column/i));
  return state;
}
async function capture(f: ReturnType<typeof fixture>, tables: string[]) {
  await snapshot.createScopedMigrationSnapshot({ sourcePath: f.filename, targetPath: f.backupPath, tables, beforePublish() { assert(fs.existsSync(f.filename)); } });
}
async function runCase(name: string, run: () => Promise<void>) {
  const started = new Date().toISOString();
  process.stdout.write(JSON.stringify({ case: name, status: "started", started }) + "\n");
  try { await run(); results.push({ name, status: "passed", started, ended: new Date().toISOString() }); process.stdout.write(JSON.stringify(results.at(-1)) + "\n"); }
  catch (error) { results.push({ name, status: "failed", started, error: error instanceof Error ? { name: error.name, message: error.message, cause: String(error.cause ?? "") } : String(error) }); throw error; }
}
let failure: unknown;
try {
  await runCase("production-raw-scoped-table-restore-refuses-before-drops", async () => {
    const f = fixture("raw-table"); await capture(f, ["plugin_state_entries", "schema_meta", "config_machine_state"]); cutover(f.filename);
    const before = evidence(f.filename);
    assert.throws(() => snapshot.restoreScopedMigrationSnapshot({ sourcePath: f.filename, backupPath: f.backupPath, assertCurrent() { assert(fs.existsSync(f.filename)); } }), /nonordinary table: plugin_state_entries/);
    assert.deepEqual(evidence(f.filename), before); assertGuard(f.filename);
  });
  await runCase("production-raw-metadata-restore-lowers-floor-but-preserves-guard-data", async () => {
    const f = fixture("raw-metadata"); await capture(f, ["schema_meta", "config_machine_state"]); cutover(f.filename);
    snapshot.restoreScopedMigrationSnapshot({ sourcePath: f.filename, backupPath: f.backupPath, assertCurrent() { assert(fs.existsSync(f.filename)); } });
    const state = assertGuard(f.filename); assert.equal(state.floor, 39); assert.equal(state.metadata, 39);
  });
  await runCase("production-old-full-strict-attempt-rolls-back-guard", async () => {
    const f = fixture("strict-full"); cutover(f.filename); const before = evidence(f.filename);
    withDb(f.filename, (db) => assert.throws(() => strict.migrateSqliteSchemaToStrict(db, schema, { databaseLabel: f.filename }), /column|disappeared|table|view/i));
    assert.deepEqual(evidence(f.filename), before); assertGuard(f.filename);
  });
  await runCase("production-unrelated-strict-rebuild-recreates-exact-guard", async () => {
    const f = fixture("strict-unrelated"); cutover(f.filename);
    withDb(f.filename, (db) => {
      db.exec("CREATE TABLE unrelated_fixture (value TEXT); INSERT INTO unrelated_fixture VALUES ('retained');");
      const outcome = strict.migrateSqliteSchemaToStrict(db, "CREATE TABLE IF NOT EXISTS unrelated_fixture(value TEXT) STRICT;", { databaseLabel: f.filename });
      assert.deepEqual(outcome.migratedTables, ["unrelated_fixture"]);
      assert.equal(db.prepare("SELECT value FROM unrelated_fixture").get()!.value, "retained");
    });
    assertGuard(f.filename);
  });
  await runCase("production-supported-Doctor-scoped-restore-refuses-before-drops", async () => {
    const f = fixture("doctor-table"); await capture(f, ["plugin_state_entries", "schema_meta", "config_machine_state"]); cutover(f.filename); const before = evidence(f.filename);
    const doctor = await load("src/commands/doctor-migration-backup-restore.ts");
    await assert.rejects(doctor.restoreDoctorMigrationBackup({ sourcePath: f.filename, backupPath: f.backupPath, env: f.env }), /nonordinary table: plugin_state_entries/);
    assert.deepEqual(evidence(f.filename), before); assertGuard(f.filename);
  });
} catch (error) { failure = error; }
finally {
  fs.writeFileSync(path.join(artifacts, "restore-results.json"), JSON.stringify({ head, runtime: process.version, startedSource: source, runRoot, taskTmp, resolvedTemp, boundary: "canonical official current-schema DDL fixture, actual production restore/STRICT/Doctor functions; cutover is experimental fixture DDL, not candidate implementation", hashes, results, failure: failure instanceof Error ? String(failure.stack) : failure }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ head, runRoot, results }) + "\n");
}
if (failure) throw failure;
