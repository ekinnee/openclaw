// Fixture observation only: catalog selection does not grant runtime or migration authority.
export function pluginStateObservationRelation(database) {
  const objects = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name IN ('plugin_state_entries', 'plugin_state_records')",
    )
    .all();
  const legacy = objects.find((entry) => entry.name === "plugin_state_entries");
  const current = objects.find((entry) => entry.name === "plugin_state_records");
  if (legacy?.type === "table" && !current) {
    return "plugin_state_entries";
  }
  if (
    current?.type === "table" &&
    legacy?.type === "view" &&
    legacy.sql?.replace(/\s+/gu, " ").trim() ===
      "CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format" &&
    !database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'plugin_state_entries'",
      )
      .get()
  ) {
    return "plugin_state_records";
  }
  throw new Error("Unrecognized plugin-state observation layout");
}
