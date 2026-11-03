import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";

export const PLUGIN_STATE_WRITER_FENCE_SQL =
  "CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format";

export function assertSupportedStateProtectionHistory(
  tables: Iterable<string>,
  hasExperimentalApprovalProvenance: boolean,
): void {
  if (
    hasExperimentalApprovalProvenance ||
    [...tables].some((name) => name.startsWith("operator_approval_publication_"))
  ) {
    throw new SqliteSchemaMismatchError(
      "Experimental shared-state protection history is not an upstream format; preserve this store and use its matching OpenClaw build.",
    );
  }
}

/** Preserve the released predecessor, including its SQL name, for migration and backup. */
export function withLegacyPluginStateStorage(schema: string): string {
  return schema
    .replace(
      /\nCREATE VIEW(?: IF NOT EXISTS)? "?plugin_state_entries"? AS\s+SELECT 'upgrade-required'(?:::text)? AS "?unsupported_format"?;\n?/gu,
      "\n",
    )
    .replace(/\bplugin_state_records\b/gu, "plugin_state_entries");
}

/** Classify retained layouts before repair, credentials, or journal configuration can write. */
export function assertStatePluginStorageLayout(database: DatabaseSync, version: number): void {
  const facts = getAdmittedSqliteSchemaFacts(database);
  if (!facts) {
    throw new SqliteSchemaMismatchError(
      "Shared-state format classification requires admitted catalog facts.",
    );
  }
  assertSupportedStateProtectionHistory(
    facts.tables,
    /\bsource_provenance_json\b/u.test(facts.tableSql.get("operator_approvals") ?? ""),
  );
  const current = facts.tables.has("plugin_state_records");
  const oldTable = facts.tables.has("plugin_state_entries");
  const guard = facts.views.has("plugin_state_entries");
  const refuses = () => {
    throw new SqliteSchemaMismatchError(
      "Unsupported or conflicting shared-state writer-fence layout; preserve this store and use its matching OpenClaw build. Experimental stores are not converted.",
    );
  };
  if (current && oldTable) {
    refuses();
  }
  if (facts.tables.has("openclaw_engine_anchor")) {
    if (
      [...facts.tables, ...facts.views, ...facts.triggers.keys()].some(
        (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
      )
    ) {
      refuses();
    }
    // Backend admission can retain the server's floor on its local anchor.
    // This catalog contains no payload; the engine owner still admits its identity.
    return;
  }
  if (version < PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION) {
    if (current || guard) {
      refuses();
    }
    return;
  }
  if (
    !current ||
    oldTable ||
    !guard ||
    normalizeSchemaSql(facts.viewSql.get("plugin_state_entries") ?? null) !==
      normalizeSchemaSql(PLUGIN_STATE_WRITER_FENCE_SQL) ||
    [...facts.triggers.values()].some((trigger) => trigger.table === "plugin_state_entries")
  ) {
    refuses();
  }
}

export const statePluginStorageMigration = {
  version: PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION,
  tables: ["plugin_state_entries", "plugin_state_records"],
  columns: [],
  migrate(database: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= PLUGIN_STATE_WRITER_FENCE_SCHEMA_VERSION) {
      return false;
    }
    // The existing schema-maintenance owner holds the transaction. Native DDL
    // drains active writers; the old-name view keeps warm old SQL fenced afterward.
    const facts = getAdmittedSqliteSchemaFacts(database);
    if (facts?.tables.has("plugin_state_entries")) {
      database.exec("ALTER TABLE plugin_state_entries RENAME TO plugin_state_records;");
      // ALTER quotes the table name in existing index SQL. The caller installs
      // the exact canonical projections again inside this same transaction.
      database.exec("DROP INDEX IF EXISTS idx_plugin_state_expiry;");
      database.exec("DROP INDEX IF EXISTS idx_plugin_state_listing;");
    }
    database.exec(`${PLUGIN_STATE_WRITER_FENCE_SQL};`);
    return true;
  },
  applied: "Fenced older plugin-state writers at the retired SQL relation (local staging v40)",
};
