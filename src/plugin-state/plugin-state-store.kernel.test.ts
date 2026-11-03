import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION } from "../state/openclaw-schema-versions.js";
import { openTrackedStateDatabase } from "../state/openclaw-state-db-handle.js";
import { PLUGIN_STATE_WRITER_FENCE_SQL } from "../state/openclaw-state-db-schema-v40-plugin-state.js";
import { preparePluginStateNativeBindingMutation } from "./plugin-state-native-binding-codec.js";
import type { PluginStateOperationInput } from "./plugin-state-operation-contract.js";
import { executePluginStateOperation } from "./plugin-state-operation.kernel.js";
import {
  countLivePluginStateNamespaceEntries,
  hasPluginStateEntry,
  selectPluginStateEntriesInKeyRange,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  selectPluginStateEntry,
  upsertPluginStateEntry,
} from "./plugin-state-store.kernel.js";
import { movePluginStateEntries } from "./plugin-state-store.moves.worker.js";
import {
  clearPluginStateNamespace,
  consumePluginStateEntry,
  deletePluginStateNativeBinding,
  registerPluginStateEntryIfAbsent,
} from "./plugin-state-store.mutations.js";
import {
  lookupPluginStateEntries,
  selectPluginStateBatchRows,
} from "./plugin-state-store.reads.js";
import {
  countLivePluginStateEntries,
  readPluginStateRetention,
  readPluginStateRetentionBatch,
  registerPluginStateEntry,
} from "./plugin-state-store.retention.js";
import type { PluginStateOperationTransaction } from "./plugin-state-store.types.js";

function database() {
  const db = openTrackedStateDatabase(":memory:");
  db.exec(`CREATE TABLE plugin_state_records (
    plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
    value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    PRIMARY KEY (plugin_id, namespace, entry_key)
  ) STRICT;
  PRAGMA user_version = ${PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION};
  ${PLUGIN_STATE_WRITER_FENCE_SQL};`);
  return db;
}

function operation(db: DatabaseSync, namespaces: string[], maxEntries: number) {
  const input: PluginStateOperationInput = {
    module: {
      modulePath: import.meta.filename,
      boundaryRoot: import.meta.dirname,
      origin: "bundled",
      pluginId: "fixture",
    },
    exportName: "fixture",
    stores: namespaces.map((namespace) => ({
      pluginId: "fixture",
      namespace,
      maxEntries,
      overflowPolicy: "reject-new",
      defaultTtlMs: undefined,
    })),
    writeStores: namespaces.map((_, index) => index),
    command: { type: "fixture", input: null },
    receiptId: "fixture",
  };
  return (run: (tx: PluginStateOperationTransaction) => unknown) =>
    runSqliteImmediateTransactionSync(db, () =>
      executePluginStateOperation({ db, path: ":memory:" }, input, (_command, tx) => run(tx)),
    );
}

it("refuses NUL plugin keys before PostgreSQL reads or writes", () => {
  using db = new DatabaseSync(":memory:");
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
  const scope = { pluginId: "test", namespace: "test", key: "nul\0tail" };
  for (const run of [
    () => selectPluginStateEntry(db, { ...scope, now: 1 }),
    () =>
      upsertPluginStateEntry(db, {
        plugin_id: scope.pluginId,
        namespace: scope.namespace,
        entry_key: scope.key,
        value_json: "{}",
        created_at: 1,
        expires_at: null,
      }),
  ]) {
    expect(run).toThrow(
      expect.objectContaining({
        code: "PLUGIN_STATE_INVALID_INPUT",
        message: "PostgreSQL plugin state keys cannot contain NUL characters.",
      }),
    );
  }
});

it.each([
  { scanned: false, expiredCount: 1 },
  { scanned: true, expiredCount: 1 },
  { scanned: false, expiredCount: 1_025 },
])(
  "preserves cleanup, capacity, and read-own-write ($scanned, $expiredCount expired)",
  ({ scanned, expiredCount }) => {
    using db = database();
    db.exec(`INSERT INTO plugin_state_records VALUES
    ('fixture', 'bounded', 'live', '1', 1, NULL),
    ('fixture', 'bounded', 'removed', '2', 2, NULL),
    ('fixture', 'bounded', 'expired', '3', 3, 1);`);
    const insert = db.prepare(
      "INSERT INTO plugin_state_records VALUES ('fixture', 'bounded', ?, '0', 3, 1)",
    );
    for (let index = 1; index < expiredCount; index++) {
      insert.run(`expired-${index}`);
    }
    const run = operation(db, ["bounded"], 2);
    const result = run((tx) => {
      if (scanned) {
        tx.entries(0);
      }
      tx.delete(0, "removed");
      tx.set(0, "live", 4);
      tx.set(0, "new", 5);
      return tx.entries(0);
    });
    expect(result.value).toEqual([
      expect.objectContaining({ key: "live", value: 4 }),
      expect.objectContaining({ key: "new", value: 5 }),
    ]);
    expect(
      db.prepare("SELECT entry_key FROM plugin_state_records ORDER BY entry_key").all(),
    ).toEqual([{ entry_key: "live" }, { entry_key: "new" }]);
    expect(() =>
      run((tx) => {
        tx.set(0, "over-capacity", 6);
      }),
    ).toThrow(/reached its 2-row limit/);
  },
);

it.each([1, 4, 5])(
  "preserves namespace limits and rollback across retention batch sizes (%i scopes)",
  (scopeCount) => {
    using db = database();
    const namespaces = Array.from({ length: scopeCount }, (_, index) => `scope-${index}`);
    const seed = db.prepare("INSERT INTO plugin_state_records VALUES ('fixture', ?, ?, '0', 1, ?)");
    for (const namespace of namespaces) {
      seed.run(namespace, "live", null);
      seed.run(namespace, "expired", 1);
    }
    const run = operation(db, namespaces, 1);
    run((tx) => {
      tx.set(0, "live", 1);
      for (let index = 1; index < scopeCount; index++) {
        expect(tx.lookup(index, "live")).toBe(0);
        expect(tx.delete(index, "live")).toBe(true);
        tx.set(index, "replacement", index);
        expect(tx.lookup(index, "replacement")).toBe(index);
      }
      expect(() => tx.set(0, "over-capacity", 2)).toThrow(/1-row limit/);
      expect(tx.lookup(0, "live")).toBe(1);
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM plugin_state_records").get()).toEqual({
      count: scopeCount,
    });
    expect(() =>
      run((tx) => {
        tx.set(0, "live", 99);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(
      db.prepare("SELECT value_json FROM plugin_state_records WHERE namespace=?").get("scope-0"),
    ).toEqual({ value_json: "1" });
  },
);

it.each([false, true])(
  "isolates a scanned write from delete-only and unused siblings (scanned=%s)",
  (scanned) => {
    using db = database();
    db.exec(
      "INSERT INTO plugin_state_records VALUES ('fixture', 'other', 'removed', '0', 1, NULL)",
    );
    const run = operation(db, ["written", "other", "unused"], 1);
    run((tx) => {
      if (scanned) {
        tx.entries(0);
      }
      tx.set(0, "new", 1);
      expect(tx.delete(1, "removed")).toBe(true);
      expect(tx.lookup(0, "new")).toBe(1);
    });
    expect(db.prepare("SELECT namespace FROM plugin_state_records").all()).toEqual([
      { namespace: "written" },
    ]);
  },
);

const bindingScope = { pluginId: "codex", namespace: "app-server-thread-bindings" };
const legacyBinding = {
  version: 1,
  state: "active",
  sessionId: "fixture",
  binding: { threadId: "thread", cwd: "/synthetic" },
};
const futureBinding = { version: 5, opaque: "preexisting future data, no native authority" };

beforeAll(() => {
  preparePluginStateNativeBindingMutation(bindingScope, {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions", import.meta.url)),
  });
});

it("preserves unsupported physical bindings across generic, cleanup, move, and typed mutations", () => {
  const actions = [
    (store: { db: DatabaseSync; path: string }) =>
      deletePluginStateEntry(store.db, { ...bindingScope, key: "saved" }),
    (store: { db: DatabaseSync; path: string }) =>
      consumePluginStateEntry(store, { ...bindingScope, key: "saved" }),
    (store: { db: DatabaseSync; path: string }) =>
      clearPluginStateNamespace(store.db, bindingScope),
    (store: { db: DatabaseSync; path: string }) =>
      deleteExpiredPluginStateEntries(store.db, Date.now(), bindingScope),
    (store: { db: DatabaseSync; path: string }) =>
      registerPluginStateEntryIfAbsent(store, {
        ...bindingScope,
        key: "saved",
        valueJson: JSON.stringify(legacyBinding),
        maxEntries: 10,
        overflowPolicy: "reject-new",
      }),
    (store: { db: DatabaseSync; path: string }) =>
      registerPluginStateEntry(store, {
        ...bindingScope,
        key: "saved",
        valueJson: JSON.stringify(legacyBinding),
        maxEntries: 10,
        overflowPolicy: "reject-new",
      }),
  ];
  for (const action of actions) {
    using db = database();
    // Raw fixture admission represents a saved newer record; it grants no native authority.
    db.prepare("INSERT INTO plugin_state_records VALUES (?, ?, 'saved', ?, 1, 1)").run(
      bindingScope.pluginId,
      bindingScope.namespace,
      JSON.stringify(futureBinding),
    );
    const before = db.prepare("SELECT * FROM plugin_state_records").all();
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => action({ db, path: ":memory:" })),
    ).toThrow(/Unsupported native session binding/);
    expect(db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(before);
  }
  using db = database();
  const lease = { token: "fixture-token", expiresAt: Date.now() + 60_000 };
  const raw = {
    ...legacyBinding,
    version: 5,
    lease,
    producingWindow: { sessionId: "future-window" },
  };
  db.prepare("INSERT INTO plugin_state_records VALUES (?, ?, 'saved', ?, 1, NULL)").run(
    bindingScope.pluginId,
    bindingScope.namespace,
    JSON.stringify(raw),
  );
  const before = db.prepare("SELECT * FROM plugin_state_records").all();
  expect(
    runSqliteImmediateTransactionSync(db, () =>
      deletePluginStateNativeBinding(
        { db, path: ":memory:" },
        {
          ...bindingScope,
          key: "saved",
          codec: "codex",
          predicate: { kind: "leased", token: lease.token, value: legacyBinding },
          maxEntries: 10,
          overflowPolicy: "reject-new",
          staleMs: 1000,
          deletionChanged: "changed",
          rollbackChanged: "changed",
        },
      ),
    ),
  ).toEqual({ status: "conflict" });
  expect(db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(before);
  expect(() =>
    runSqliteImmediateTransactionSync(db, () =>
      movePluginStateEntries(
        { db, path: ":memory:" },
        {
          pluginId: bindingScope.pluginId,
          sourceNamespace: bindingScope.namespace,
          namespace: `@retained.${bindingScope.namespace}`,
          entries: [{ sourceKey: "saved", targetKey: "saved" }],
        },
      ),
    ),
  ).toThrow(/Unsupported native session binding/);
  expect(db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(before);
});

it("preserves supported V1 and ordinary values while refusing malformed and future binding formats", () => {
  using db = database();
  const register = (value: unknown, namespace = bindingScope.namespace) =>
    runSqliteImmediateTransactionSync(db, () =>
      registerPluginStateEntry(
        { db, path: ":memory:" },
        {
          ...bindingScope,
          namespace,
          key: "saved",
          valueJson: JSON.stringify(value),
          maxEntries: 10,
          overflowPolicy: "reject-new",
        },
      ),
    );
  register(legacyBinding);
  register({ ...legacyBinding, nativeSubagentTaskImport: { version: 999, opaque: true } });
  const opaqueLegacy = {
    ...legacyBinding,
    sessionId: " fixture ",
    ignoredByCodec: { keep: ["exact", 7] },
  };
  register(opaqueLegacy);
  expect(db.prepare("SELECT value_json FROM plugin_state_records").get()?.value_json).toBe(
    JSON.stringify(opaqueLegacy),
  );
  const before = db.prepare("SELECT * FROM plugin_state_records").all();
  expect(() => register(futureBinding)).toThrow(/Unsupported native session binding/);
  expect(() =>
    register({ ...legacyBinding, binding: { ...legacyBinding.binding, threadId: " " } }),
  ).toThrow(/Unsupported native session binding/);
  expect(db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(before);
  register(futureBinding, "ordinary");
  expect(db.prepare("SELECT count(*) AS n FROM plugin_state_records").get()).toEqual({ n: 2 });
});

it.each([null, 1])(
  "native typed deletion preserves unknown envelopes outside the original namespace (expiry %s)",
  (expiresAt) => {
    using db = database();
    const namespace = "other-binding-store";
    const lease = { token: "fixture-token", expiresAt: Date.now() + 60_000 };
    const raw = {
      ...legacyBinding,
      version: 5,
      lease,
      producingWindow: { sessionId: "future-window" },
    };
    db.prepare("INSERT INTO plugin_state_records VALUES (?, ?, 'saved', ?, 1, ?)").run(
      bindingScope.pluginId,
      namespace,
      JSON.stringify(raw),
      expiresAt,
    );
    const before = db.prepare("SELECT * FROM plugin_state_records").all();
    expect(
      runSqliteImmediateTransactionSync(db, () =>
        deletePluginStateNativeBinding(
          { db, path: ":memory:" },
          {
            ...bindingScope,
            namespace,
            key: "saved",
            codec: "codex",
            predicate:
              expiresAt === null
                ? { kind: "leased", token: lease.token, value: legacyBinding }
                : { kind: "absent" },
            maxEntries: 10,
            overflowPolicy: "reject-new",
            staleMs: 1000,
            deletionChanged: "changed",
            rollbackChanged: "changed",
          },
        ),
      ),
    ).toEqual({ status: "conflict" });
    expect(db.prepare("SELECT * FROM plugin_state_records").all()).toEqual(before);
  },
);

it("keys legacy and current read families by physical relation on the same connection", () => {
  using db = database();
  db.exec(
    `INSERT INTO plugin_state_records VALUES ('fixture', 'scope', 'kept', '{"keep":true}', 1, NULL)`,
  );
  const params = { pluginId: "fixture", namespace: "scope", key: "kept", now: 2 };
  const store = { db, path: ":memory:" };
  const read = () => {
    expect(selectPluginStateEntry(db, params)?.value_json).toBe('{"keep":true}');
    expect(hasPluginStateEntry(db, params)).toBe(true);
    expect(countLivePluginStateNamespaceEntries(db, params)).toBe(1);
    expect(countLivePluginStateEntries(db, params)).toBe(1);
    expect(readPluginStateRetention(db, params).namespaceCount).toBe(1);
    expect(lookupPluginStateEntries(store, { ...params, keys: [params.key] })[0]).toEqual({
      ok: true,
      value: { keep: true },
    });
    expect(selectPluginStateBatchRows(store, [params], 2)[0]?.value_json).toBe('{"keep":true}');
    expect(
      selectPluginStateEntriesInKeyRange(db, {
        ...params,
        keyStartInclusive: "k",
        keyEndExclusive: "l",
        order: "asc",
        limit: 2,
      }).map((row) => row.entry_key),
    ).toEqual(["kept"]);
    for (let count = 1; count <= 4; count++) {
      const namespaces = [
        "scope",
        ...Array.from({ length: count - 1 }, (_, index) => `missing-${index}`),
      ];
      expect(
        readPluginStateRetentionBatch(db, { ...params, namespaces }).get("scope")?.namespaceCount,
      ).toBe(1);
    }
  };
  read();
  // Explicit fixture projection, not migration authority: the physical format facts change.
  db.exec(`DROP VIEW plugin_state_entries;
    ALTER TABLE plugin_state_records RENAME TO plugin_state_entries;
    PRAGMA user_version = ${PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION - 1};`);
  read();
  db.exec(`ALTER TABLE plugin_state_entries RENAME TO plugin_state_records;
    ${PLUGIN_STATE_WRITER_FENCE_SQL};
    PRAGMA user_version = ${PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION};`);
  read();
});
