import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { runPackageUpdateDoctor } from "../cli/update-cli/update-command-package.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  createGitUpdateFixture,
  expectNoGitRuntimeStagingPaths,
  runFixtureGit as git,
  resolveCandidateNodeRuntimeForTest,
  writeGitFixtureManifest,
  type GitUpdateFixture,
} from "./update-runner-git-candidate.test-support.js";

describe("Git update Node prerequisites", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  let state: GitUpdateFixture;

  beforeEach(async () => {
    state = await createGitUpdateFixture(directories.make("git-prerequisites-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const runDoctor = async (root: string) =>
    runPackageUpdateDoctor({
      root,
      progress: {},
      managedServiceEnv: {
        OPENCLAW_STATE_DIR: path.join(state.directory, "state"),
        OPENCLAW_CONFIG_PATH: path.join(state.directory, "state", "openclaw.json"),
      },
      nodeRunner: (await resolveCandidateNodeRuntimeForTest()).path,
    });

  async function requireUnavailableNode(marker?: string) {
    await writeGitFixtureManifest(state.remote, { engines: { node: ">=999.0.0" } });
    if (marker) {
      await fs.writeFile(
        path.join(state.remote, ".gitattributes"),
        "payload filter=prerequisite\n",
      );
      await fs.writeFile(path.join(state.remote, "payload"), "fixture\n");
      const script =
        "require('node:fs').writeFileSync(process.argv[1], 'checkout'); process.stdout.write(require('node:fs').readFileSync(0))";
      await git(
        state.root,
        "config",
        "filter.prerequisite.smudge",
        [
          resolveTestNodeExecPath().replaceAll("\\", "/"),
          "-e",
          script,
          marker.replaceAll("\\", "/"),
        ]
          .map(quoteCliArg)
          .join(" "),
      );
    }
    await git(state.remote, "add", ".");
    await git(state.remote, "commit", "-m", "require unavailable Node");
    return git(state.remote, "rev-parse", "HEAD");
  }

  it("rejects incompatible Node before materializing candidate files", async () => {
    // A checkout filter represents work that must not run for an incompatible target.
    const marker = path.join(state.directory, "checkout-filter-ran");
    const selected = await requireUnavailableNode(marker);
    const beforeGitStaging = vi.fn(async () => {
      throw new Error("incompatible candidate reached staging");
    });
    const inspectGitTarget = vi.fn(async () => {});
    const result = await state.update({
      devTarget: { mode: "detached", ref: selected },
      beforeGitStaging,
      inspectGitTarget,
      runGitDoctor: runDoctor,
    });
    expect(result).toMatchObject({
      status: "error",
      reason: "preflight-node-runtime-incompatible",
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.events).toEqual([]);
    expect(beforeGitStaging).not.toHaveBeenCalled();
    expect(inspectGitTarget).not.toHaveBeenCalled();
    expect(state.stopped).toBe(false);
    expect(await git(state.root, "rev-parse", "HEAD")).toBe(state.beforeSha);
    await expectNoGitRuntimeStagingPaths(state.root, state.inspectionRoots);
  });

  it("keeps a compatible older development candidate eligible", async () => {
    const compatible = await state.advanceRemote();
    const marker = path.join(state.directory, "rejected-candidate-checkout");
    await requireUnavailableNode(marker);
    const result = await state.update({ runGitDoctor: runDoctor });
    expect(result, result.reason).toMatchObject({
      status: "ok",
      after: { sha: compatible },
    });
    expect(state.events.filter((event) => event === "build")).toHaveLength(1);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks the resulting manifest when local commits relax the upstream Node requirement", async () => {
    // The upstream keeps the original engine while the operator relaxes it locally.
    await writeGitFixtureManifest(state.remote, { engines: { node: ">=999.0.0" } });
    await git(state.remote, "add", "package.json");
    await git(state.remote, "commit", "-m", "upstream engine");
    await git(state.root, "fetch", "origin");
    await git(state.root, "merge", "--ff-only", "origin/main");
    await writeGitFixtureManifest(state.root, { engines: { node: ">=24.0.0" } });
    await git(state.root, "add", "package.json");
    await git(state.root, "commit", "-m", "local engine");
    state.beforeSha = await git(state.root, "rev-parse", "HEAD");
    await state.writeRuntime();
    await state.advanceRemote();
    const result = await state.update({ runGitDoctor: runDoctor });
    expect(result.status, result.reason).toBe("ok");
    expect(
      JSON.parse(await fs.readFile(path.join(state.root, "package.json"), "utf8")),
    ).toMatchObject({
      engines: { node: ">=24.0.0" },
    });
  });
});
