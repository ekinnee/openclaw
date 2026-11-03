import { readFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { openTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import {
  runStateSchemaMigrationTransaction,
  writeCurrentStateSchemaMetadata,
} from "./openclaw-state-db-maintenance.js";
import { statePluginStorageMigration } from "./openclaw-state-db-schema-v40-plugin-state.js";
import { resolvePluginStateReadRelation } from "./openclaw-state-db-schema-version.js";
import {
  openOpenClawStateDatabase,
  openExistingOpenClawStateDatabaseReadOnly,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
const ordinary = '{"ordinary":"retained bytes"}';

// Exact affected DDL from upstream 9a1a7541:openclaw-state-schema.sql (1222–1237).
// Reversing ALTER TABLE would retain successor quoting in the index catalog.
const OFFICIAL39_PLUGIN_STATE_SQL = `CREATE TABLE IF NOT EXISTS plugin_state_entries (
  plugin_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (plugin_id, namespace, entry_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_plugin_state_expiry
  ON plugin_state_entries(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_state_listing
  ON plugin_state_entries(plugin_id, namespace, created_at, entry_key, expires_at);`;

async function fixture(previous = false) {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("state-writer-fence-") } };
  const current = openOpenClawStateDatabase(options);
  current.db
    .prepare(
      "INSERT INTO plugin_state_records VALUES ('ordinary', 'history', 'retained', ?, 1, NULL)",
    )
    .run(ordinary);
  const file = current.path;
  await closeStateDatabaseForTest();
  if (previous) {
    using db = openTrackedStateDatabase(file);
    admitSqliteSchema(db);
    // Keep unchanged bootstrap state, replacing only this table/index contract
    // with the actual predecessor producer instead of deriving it by rename.
    runSqliteImmediateTransactionSync(db, () =>
      db.exec(`
      DROP VIEW plugin_state_entries;
      DROP INDEX idx_plugin_state_expiry;
      DROP INDEX idx_plugin_state_listing;
      ${OFFICIAL39_PLUGIN_STATE_SQL}
      INSERT INTO plugin_state_entries SELECT * FROM plugin_state_records;
      DROP TABLE plugin_state_records;
      PRAGMA user_version = 39;
      UPDATE schema_meta SET schema_version = 39 WHERE meta_key = 'primary';
      UPDATE config_machine_state SET value_json = '39'
        WHERE state_key = 'state.schema.contentVersion';
    `),
    );
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 39 });
    expect(
      db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get(),
    ).toEqual({ schema_version: 39 });
    expect(
      db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key='state.schema.contentVersion'",
        )
        .get(),
    ).toEqual({ value_json: "39" });
    expect(
      db
        .prepare(
          "SELECT name, type FROM sqlite_schema WHERE name IN ('plugin_state_entries', 'plugin_state_records') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "plugin_state_entries", type: "table" }]);
    expect(db.prepare("SELECT value_json FROM plugin_state_entries").all()).toEqual([
      { value_json: ordinary },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='plugin_state_entries' AND sql IS NOT NULL ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "idx_plugin_state_expiry" }, { name: "idx_plugin_state_listing" }]);
  }
  return { options, file };
}

it("upgrades official39 without changing retained rows, and reopens the ordinary API", async () => {
  const f = await fixture(true);
  // This independent native connection models an older process. Maintenance
  // must not close it; its completed statements hold no transaction across repair.
  using older = new DatabaseSync(f.file);
  const oldRead = older.prepare("SELECT * FROM plugin_state_entries");
  const oldUpdate = older.prepare(
    "UPDATE plugin_state_entries SET value_json=? WHERE entry_key='retained'",
  );
  const oldDelete = older.prepare("DELETE FROM plugin_state_entries WHERE entry_key='retained'");
  expect(oldUpdate.run(ordinary).changes).toBe(1);
  const originalRows = oldRead.all();
  expect(originalRows).toEqual([
    {
      plugin_id: "ordinary",
      namespace: "history",
      entry_key: "retained",
      value_json: ordinary,
      created_at: 1,
      expires_at: null,
    },
  ]);
  const repair = await withStateMigrationBackupForTest(f.options, () =>
    repairOpenClawStateDatabaseSchema(f.options),
  );
  expect(repair.warnings).toEqual([]);
  const upgraded = openOpenClawStateDatabase(f.options);
  expect(upgraded.db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(originalRows);
  expect(oldRead.all()).toEqual([{ unsupported_format: "upgrade-required" }]);
  for (const write of [() => oldUpdate.run("changed"), () => oldDelete.run()]) {
    expect(write).toThrow(
      expect.objectContaining({
        code: "ERR_SQLITE_ERROR",
        message: expect.stringContaining("view"),
      }),
    );
    expect(upgraded.db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(originalRows);
  }
  expect(upgraded.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 40 });
  expect(upgraded.db.prepare("SELECT value_json FROM plugin_state_records").all()).toEqual([
    { value_json: ordinary },
  ]);
  expect(upgraded.db.prepare("SELECT * FROM plugin_state_entries").all()).toEqual([
    { unsupported_format: "upgrade-required" },
  ]);
  expect(
    upgraded.db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      )
      .get(),
  ).toEqual({ value_json: "40" });
  await closeStateDatabaseForTest();
  const reopened = await openExistingOpenClawStateDatabaseReadOnly(f.options);
  expect(reopened).toBeDefined();
  expect(resolvePluginStateReadRelation(requireNativeSqliteDatabase(reopened!.db))).toBe(
    "plugin_state_records",
  );
  expect(
    reopened!.db.prepare("SELECT value_json FROM plugin_state_records").get()?.value_json,
  ).toBe(ordinary);
});

it.each([
  ["missing guard", "DROP VIEW plugin_state_entries"],
  [
    "mixed anchor and payload",
    "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
  ],
  [
    "changed constant",
    "DROP VIEW plugin_state_entries; CREATE VIEW plugin_state_entries AS SELECT 'wrong' AS unsupported_format",
  ],
  [
    "forwarding guard",
    "DROP VIEW plugin_state_entries; CREATE VIEW plugin_state_entries AS SELECT value_json AS unsupported_format FROM plugin_state_records",
  ],
  [
    "extra column",
    "DROP VIEW plugin_state_entries; CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format, 1 AS extra",
  ],
  [
    "write trigger",
    "CREATE TRIGGER old_delete INSTEAD OF DELETE ON plugin_state_entries BEGIN DELETE FROM plugin_state_records; END",
  ],
  [
    "two data relations",
    "CREATE TABLE plugin_state_entries_backup (value_json TEXT); DROP VIEW plugin_state_entries; CREATE TABLE plugin_state_entries (value_json TEXT)",
  ],
  [
    "lowered floors",
    "PRAGMA user_version=39; UPDATE schema_meta SET schema_version=39 WHERE meta_key='primary'; UPDATE config_machine_state SET value_json='39' WHERE state_key='state.schema.contentVersion'",
  ],
])("refuses %s before serving or changing stored bytes", async (_label, sql) => {
  const f = await fixture();
  {
    using db = openTrackedStateDatabase(f.file);
    admitSqliteSchema(db);
    db.exec(sql);
  }
  const before = readFileSync(f.file);
  expect(() => openOpenClawStateDatabase(f.options)).toThrow(/writer-fence layout/);
  expect(readFileSync(f.file)).toEqual(before);
});

it.each([37, 38, 39, 40])(
  "preserves and refuses experimental protection at numeric version%s",
  async (version) => {
    const f = await fixture(true);
    {
      using db = openTrackedStateDatabase(f.file);
      admitSqliteSchema(db);
      db.exec(`ALTER TABLE operator_approvals ADD COLUMN source_provenance_json TEXT;
      PRAGMA user_version=${version};
      UPDATE schema_meta SET schema_version=${version} WHERE meta_key='primary';
      UPDATE config_machine_state SET value_json='${version}' WHERE state_key='state.schema.contentVersion';`);
    }
    const before = readFileSync(f.file);
    expect(() => openOpenClawStateDatabase(f.options)).toThrow(
      /Experimental shared-state protection history/,
    );
    expect(readFileSync(f.file)).toEqual(before);
  },
);

it("rolls the rename, guard and floors back when the native commit refuses", async () => {
  const f = await fixture(true);
  using db = openTrackedStateDatabase(f.file);
  admitSqliteSchema(db);
  let commitAttempts = 0;
  let migrationFailure: unknown;
  try {
    runStateSchemaMigrationTransaction(
      db,
      f.file,
      () => {
        expect(statePluginStorageMigration.migrate(db, 39)).toBe(true);
        expect(db.prepare("SELECT * FROM plugin_state_entries").get()?.unsupported_format).toBe(
          "upgrade-required",
        );
        writeCurrentStateSchemaMetadata(db, Date.now());
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 40 });
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get(),
        ).toEqual({ schema_version: 40 });
        expect(
          db
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key='state.schema.contentVersion'",
            )
            .get(),
        ).toEqual({ value_json: "40" });
        // Custom authorizers deliberately suspend admitted catalog facts. Install
        // the fault only after migration consumes the actual predecessor facts.
        db.setAuthorizer((action, argument) => {
          if (action === constants.SQLITE_TRANSACTION && argument === "COMMIT") {
            commitAttempts++;
            return constants.SQLITE_DENY;
          }
          return constants.SQLITE_OK;
        });
      },
      { databaseLabel: f.file },
    );
  } catch (error) {
    migrationFailure = error;
  } finally {
    db.setAuthorizer(null);
  }
  expect(migrationFailure).toBeDefined();
  expect(commitAttempts, inspect(migrationFailure, { depth: 4 })).toBeGreaterThan(0);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 39 });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get(),
  ).toEqual({ schema_version: 39 });
  expect(
    db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key='state.schema.contentVersion'",
      )
      .get(),
  ).toEqual({ value_json: "39" });
  expect(db.prepare("SELECT value_json FROM plugin_state_entries").get()?.value_json).toBe(
    ordinary,
  );
  expect(
    db.prepare("SELECT type FROM sqlite_schema WHERE name='plugin_state_records'").get(),
  ).toBeUndefined();
  expect(
    resolveSchemaMigrationBackupTables({ kind: "state", foundVersion: 39, supportedVersion: 40 }),
  ).toBeUndefined();
});

it.each(["runtime", "selector"] as const)(
  "refuses future content41 under deferred header39 through %s",
  async (target) => {
    const f = await fixture();
    {
      using db = openTrackedStateDatabase(f.file);
      admitSqliteSchema(db);
      db.exec(`PRAGMA user_version=39;
      UPDATE schema_meta SET schema_version=39 WHERE meta_key='primary';
      UPDATE config_machine_state SET value_json='41' WHERE state_key='state.schema.contentVersion';`);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 39 });
      expect(
        db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key='state.schema.contentVersion'",
          )
          .get(),
      ).toEqual({ value_json: "41" });
      expect(
        db.prepare("SELECT type FROM sqlite_schema WHERE name='plugin_state_records'").get(),
      ).toEqual({ type: "table" });
      expect(db.prepare("SELECT * FROM plugin_state_entries").all()).toEqual([
        { unsupported_format: "upgrade-required" },
      ]);
    }
    const before = readFileSync(f.file);
    let refusal: unknown;
    let selected: unknown;
    try {
      if (target === "runtime") {
        selected = openOpenClawStateDatabase(f.options);
      } else {
        using db = openTrackedStateDatabase(f.file, { readOnly: true });
        selected = resolvePluginStateReadRelation(db);
      }
    } catch (error) {
      refusal = error;
    }
    await closeStateDatabaseForTest();
    expect(readFileSync(f.file)).toEqual(before);
    expect(
      refusal,
      `unexpected ${target} admission: ${inspect(selected, { depth: 1 })}`,
    ).toBeInstanceOf(Error);
    expect(String(refusal)).toMatch(/newer schema version/iu);
  },
);
