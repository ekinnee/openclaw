import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { pluginStateObservationRelation } from "../../scripts/e2e/lib/plugin-state-observation.mjs";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertImportedAssignments,
  assertPublishedAssignments,
} from "../../scripts/e2e/lib/upgrade-survivor/native-assignments.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  backupRollbackProof,
  readJson,
  successSummary,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const owner = {
  parentThreadId: "native-upgrade-parent",
  sessionId: "synthetic-original-session",
  lifecycleRevision: "synthetic-original-lifecycle",
  connectionFingerprint: "1".repeat(64),
};
const dirs = useAutoCleanupTempDirTracker(afterEach);

function publish(snapshot: unknown) {
  const root = dirs.make("native-upgrade-publication-");
  const output = path.join(root, "public");
  writeJson(path.join(root, "summary.json"), snapshot);
  fs.writeFileSync(path.join(root, "native-assignment-server.log"), "native fixture diagnostic");
  publishDiagnostics(root, output, (value: string) => value, "passed");
  return readJson(path.join(output, "summary.json"));
}

const running = "codex-thread:native-upgrade-running";
const completed = "codex-thread:native-upgrade-complete";

function releasedState() {
  return {
    tasks: [running, completed].map((runId, index) => ({
      task_id: `released-${index}`,
      run_id: runId,
      owner_key: "agent:native-proof:upgrade-native-proof",
      scope_kind: "session",
      detail_json: JSON.stringify({ nativeHistory: owner }),
      status: index === 0 ? "running" : "succeeded",
      delivery_status: index === 0 ? "not_applicable" : "pending",
      terminal_summary: index === 0 ? null : "NATIVE_UPGRADE_PENDING_RESULT",
    })),
    binding: { key: "original-binding", value: { sessionId: owner.sessionId } },
  };
}

function importedState() {
  const before = releasedState();
  return {
    ...before,
    binding: {
      key: before.binding.key,
      value: {
        sessionId: owner.sessionId,
        nativeSubagentTaskImport: { version: 1, taskIds: ["released-0", "released-1"] },
        nativeSubagentAssignments: {
          assignments: before.tasks.map(({ run_id: runId, terminal_summary }) => ({
            runId,
            owner,
            recordedCompletion:
              terminal_summary === null ? undefined : { result: terminal_summary },
          })),
        },
      },
    },
  };
}

it("accepts authentic 9.4 initial locators without inventing later turn metadata", () => {
  const before = releasedState();
  expect(() => assertPublishedAssignments(before)).not.toThrow();
  expect(() => assertImportedAssignments(before, importedState())).not.toThrow();
  before.tasks[0]!.detail_json = JSON.stringify({
    nativeHistory: owner,
    nativeTurnId: "invented",
  });
  expect(() => assertPublishedAssignments(before)).toThrow("must not fabricate");
});

it("rejects a no-op import, dropped result, changed owner, and mutated source", () => {
  const before = releasedState();
  expect(() => assertImportedAssignments(before, before)).toThrow("did not import");
  const dropped = importedState();
  dropped.binding.value.nativeSubagentAssignments.assignments.pop();
  expect(() => assertImportedAssignments(before, dropped)).toThrow("both native assignments");
  const reowned = importedState();
  reowned.binding.value.nativeSubagentAssignments.assignments[0]!.owner = {
    ...owner,
    sessionId: "successor",
  };
  expect(() => assertImportedAssignments(before, reowned)).toThrow();
  const changed = importedState();
  changed.tasks[1]!.terminal_summary = "changed";
  expect(() => assertImportedAssignments(before, changed)).toThrow(
    "changed released native source rows",
  );
});

it("requires package-bound proof before publishing a successful retirement cell", () => {
  const versions = { baselineVersion: "2026.9.4", candidateVersion: "2026.9.6" };
  const digest = "a".repeat(64);
  // The native lane completes 66 phases, including overlapping and repeated spans.
  const phases = [
    ["prepare-native-assignment-proof", "started"],
    ["repeated-phase", "started"],
    ["prepare-native-assignment-proof", "passed"],
    ["repeated-phase", "passed"],
    ...Array.from({ length: 64 }, () => [
      ["repeated-phase", "started"],
      ["repeated-phase", "passed"],
    ]).flat(),
  ].map(([phase, status], index) => ({
    phase,
    status,
    at: new Date(Date.UTC(2026, 8, 4) + index).toISOString(),
  }));
  const snapshot = {
    ...successSummary(versions.baselineVersion, versions.candidateVersion),
    phases,
    backupRollback: backupRollbackProof(versions.baselineVersion, versions.candidateVersion),
    nativeAssignmentEligibility: {
      status: "required",
      candidateVersion: "2026.9.6",
      candidateSha256: digest,
      companionSha256: "b".repeat(64),
      sourceSha: "c".repeat(40),
    },
    nativeAssignments: {
      status: "passed",
      ...versions,
      candidateSha256: digest,
      source: "published-gateway-agent-native-events",
      backend: "synthetic-codex-websocket",
      baselineCore: "OpenClaw 2026.9.4 (3a9d69d)",
      sessionKey: "agent:native-proof:upgrade-native-proof",
      recoveredRunIds: [running, completed],
      baselineCodex: {
        name: "@openclaw/codex",
        version: "2026.9.4",
        integrity: "sha512-c3ludGhldGlj",
      },
      firstHopImported: true,
      retainedHistory: true,
      retainedCompletion: true,
      unconfirmedClosePreserved: true,
      confirmedCloseSettled: true,
      noReplay: true,
      incidentalPath: "/private/not-for-publication",
    },
  };
  const report = publish(snapshot);
  expect(report.phases).toEqual(phases);
  expect(report.logs["native-assignment-server.log"]).toBe("native fixture diagnostic");
  expect(report.nativeAssignments).toMatchObject({
    status: "passed",
    sourceSha: "c".repeat(40),
  });
  expect(JSON.stringify(report)).not.toContain("incidentalPath");
  const rejects = (patch: Partial<typeof snapshot>, error: string) =>
    expect(() => publish({ ...snapshot, ...patch })).toThrow(error);
  rejects({ nativeAssignmentEligibility: undefined }, "Missing native assignment eligibility");
  const skipped = publish({
    ...snapshot,
    nativeAssignmentEligibility: {
      status: "not-applicable",
      reason: "candidate retains the Task runtime SDK",
    },
    nativeAssignments: undefined,
  });
  expect(skipped.logs).not.toHaveProperty("native-assignment-server.log");
  rejects({ nativeAssignments: undefined }, "omitted native assignment proof");
  for (const patch of [{ candidateSha256: "d".repeat(64) }, { unconfirmedClosePreserved: false }]) {
    rejects(
      { nativeAssignments: { ...snapshot.nativeAssignments, ...patch } },
      "Invalid native assignment preservation",
    );
  }
  const invalidPhases = [...phases];
  invalidPhases[131] = { ...invalidPhases[131]!, status: "omitted" };
  for (const invalid of [undefined, {}, invalidPhases]) {
    expect(() => publish({ ...snapshot, phases: invalid })).toThrow();
  }
  expect(() => publish({ ...snapshot, padding: "x".repeat(256 * 1024) })).toThrow();
});

it.each(["legacy", "current"])(
  "observes retained binding rows through the %s physical relation",
  (layout) => {
    using database = new DatabaseSync(":memory:");
    database.exec(
      "CREATE TABLE plugin_state_entries (value_json TEXT NOT NULL); INSERT INTO plugin_state_entries VALUES ('{\"retained\":true}')",
    );
    if (layout === "current") {
      database.exec(
        "ALTER TABLE plugin_state_entries RENAME TO plugin_state_records; CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format",
      );
    }
    const relation = pluginStateObservationRelation(database);
    expect(database.prepare(`SELECT value_json FROM ${relation}`).get()?.value_json).toBe(
      '{"retained":true}',
    );
  },
);

it.each([
  "CREATE TABLE unrelated (value_json TEXT)",
  "CREATE TABLE plugin_state_entries (value_json TEXT); CREATE TABLE plugin_state_records (value_json TEXT)",
  "CREATE TABLE plugin_state_records (value_json TEXT)",
  "CREATE TABLE plugin_state_records (value_json TEXT); CREATE VIEW plugin_state_entries AS SELECT * FROM plugin_state_records",
  "CREATE TABLE plugin_state_records (value_json TEXT); CREATE VIEW plugin_state_entries AS SELECT 'upgrade-required' AS unsupported_format; CREATE TRIGGER legacy_write INSTEAD OF INSERT ON plugin_state_entries BEGIN SELECT 1; END",
])("refuses mixed or unknown retained binding observation layouts (%s)", (sql) => {
  using database = new DatabaseSync(":memory:");
  database.exec(sql);
  expect(() => pluginStateObservationRelation(database)).toThrow(
    "Unrecognized plugin-state observation layout",
  );
});
