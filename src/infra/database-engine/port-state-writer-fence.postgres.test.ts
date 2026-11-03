import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { portBackupFixture } from "./port-backup.test-support.js";
import { stateWriterFenceFixtureDescriptor } from "./port-provider-fixture.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);
const future = '{"version":5,"original":"A","producingWindow":"B","future":{"retained":true}}';

describe.skipIf(!connection)("canonical state guard database port", () => {
  const client = new Client({ connectionString: connection });
  beforeAll(() => client.connect());
  afterAll(() => client.end());

  async function fixture() {
    const directory = directories.make("state-guard-port-");
    const descriptor = stateWriterFenceFixtureDescriptor();
    const sourcePath = path.join(directory, "source.sqlite");
    using db = openNodeSqliteDatabase(sourcePath);
    db.exec(descriptor.sqlite);
    db.prepare("INSERT INTO plugin_state_records VALUES (?, ?)").run("future", future);
    db.prepare("INSERT INTO plugin_state_records VALUES (?, ?)").run("ordinary", '{"version":1}');
    return { ...portBackupFixture(client, directory, descriptor), sourcePath, directory };
  }

  it("exports and restores exact records with the nonforwarding retired-name guard", async () => {
    const f = await fixture();
    try {
      const before = await fs.readFile(f.sourcePath);
      const verification = await f.forward(f.sourcePath);
      expect(Object.keys(verification.tables)).toEqual(["plugin_state_records"]);
      expect(verification.tables.plugin_state_records?.rows).toBe(2);
      const manifest = await f.export(f.sourcePath);
      expect(manifest.verification).toEqual(verification);
      using image = openNodeSqliteDatabase(f.file("backup/database.sqlite"), { readOnly: true });
      expect(image.prepare("SELECT * FROM plugin_state_entries").get()).toEqual({
        unsupported_format: "upgrade-required",
      });
      expect(
        image.prepare("SELECT value FROM plugin_state_records WHERE id='future'").get(),
      ).toEqual({
        value: future,
      });
      const restored = await f.restore(manifest, path.join(f.directory, "restored-anchor.sqlite"));
      expect(await f.query(`SELECT * FROM "${restored.namespace}".plugin_state_entries`)).toEqual([
        { unsupported_format: "upgrade-required" },
      ]);
      expect(
        await f.query(
          `SELECT value FROM "${restored.namespace}".plugin_state_records WHERE id='future'`,
        ),
      ).toEqual([{ value: future }]);
      await expect(
        client.query(`DROP TABLE IF EXISTS "${restored.namespace}".plugin_state_entries`),
      ).rejects.toMatchObject({ code: "42809" });
      await expect(
        client.query(`DELETE FROM "${restored.namespace}".plugin_state_entries`),
      ).rejects.toMatchObject({ code: "55000" });
      expect(
        await f.query(
          `UPDATE "${restored.namespace}".plugin_state_records SET value='{"version":1,"updated":true}' WHERE id='ordinary' RETURNING id`,
        ),
      ).toEqual([{ id: "ordinary" }]);
      expect(await fs.readFile(f.sourcePath)).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    ["missing", "DROP VIEW plugin_state_entries"],
    [
      "constant",
      "CREATE OR REPLACE VIEW plugin_state_entries AS SELECT 'changed' AS unsupported_format",
    ],
    ["column", "ALTER VIEW plugin_state_entries RENAME COLUMN unsupported_format TO value_json"],
    [
      "extra column",
      "CREATE OR REPLACE VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format, 'extra' AS more",
    ],
    [
      "forwarding",
      "DROP VIEW plugin_state_entries; CREATE VIEW plugin_state_entries AS SELECT value AS unsupported_format FROM plugin_state_records",
    ],
    ["unknown view", "CREATE VIEW unrelated_view AS SELECT 'unrelated' AS value"],
    [
      "materialized",
      "DROP VIEW plugin_state_entries; CREATE MATERIALIZED VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format",
    ],
    [
      "write trigger",
      "CREATE FUNCTION guard_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$; CREATE TRIGGER guard_delete INSTEAD OF DELETE ON plugin_state_entries FOR EACH ROW EXECUTE FUNCTION guard_write()",
    ],
    [
      "write rule",
      "CREATE RULE guard_delete AS ON DELETE TO plugin_state_entries DO INSTEAD NOTHING",
    ],
  ])("refuses %s guard drift during ordinary backup inspection", async (_name, sql) => {
    const f = await fixture();
    try {
      await f.forward(f.sourcePath);
      await client.query(`SET search_path TO "${f.namespace}"; ${sql}`);
      await expect(f.inspect()).rejects.toThrow(
        /state writer fence|Unknown PostgreSQL trigger or view/,
      );
      expect(
        await f.query(`SELECT value FROM "${f.namespace}".plugin_state_records WHERE id='future'`),
      ).toEqual([{ value: future }]);
    } finally {
      await f.cleanup();
    }
  });
});
