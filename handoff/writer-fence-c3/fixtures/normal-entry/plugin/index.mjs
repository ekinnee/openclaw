import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const emit = (event) => process.stdout.write(`WRITER_FENCE_PROOF ${JSON.stringify(event)}\n`);
const options = (namespace) => ({ namespace, maxEntries: 32, overflowPolicy: "reject-new" });
function classify(error) {
  const causes = [];
  for (let current = error; current && causes.length < 6; current = current.cause) {
    causes.push({ code: typeof current.code === "string" ? current.code : undefined,
      name: typeof current.name === "string" ? current.name : undefined,
      message: typeof current.message === "string" ? current.message : "" });
  }
  const text = causes.map((cause) => cause.message).join(" ");
  const floor = /newer schema version (\d+); this build supports (\d+)/u.exec(text);
  return { code: causes[0]?.code ?? "untyped",
    ...(floor ? { newerFloor: Number(floor[1]), supportedMax: Number(floor[2]) } : {}), causeCodes: causes.map((cause) => cause.code).filter(Boolean),
    category: /plugin_state_entries|cannot modify.*view|no such column|no such table/iu.test(text)
      ? "retired-relation" : /schema|newer|unsupported.*version/iu.test(text)
        ? "schema-admission" : "unqualified-refusal" };
}
async function oldWriter(api) {
  const state = api.runtime.state;
  const sync = state.openSyncKeyedStore(options("held-sync"));
  const syncClear = state.openSyncKeyedStore(options("held-sync-clear"));
  const expiry = state.openSyncKeyedStore(options("held-expiry"));
  const v2Expiry = state.openKeyedStoreV2(options("held-v2-expiry"));
  const legacy = state.openKeyedStore(options("held-legacy"));
  const legacyClear = state.openKeyedStore(options("held-legacy-clear"));
  const v2 = state.openKeyedStoreV2(options("held-v2"));
  const v2Clear = state.openKeyedStoreV2(options("held-v2-clear"));
  const source = state.openKeyedStoreV2(options("held-move-source"));
  const target = state.openKeyedStoreV2({ namespace: "held-move-target", retention: "retained" });
  sync.register("sentinel", "original");
  assert.equal(sync.lookup("sentinel"), "original");
  sync.register("delete-control", true); assert.equal(sync.delete("delete-control"), true);
  syncClear.register("control", true); syncClear.clear(); syncClear.register("sentinel", "original");
  expiry.register("expired-control", "original", { ttlMs: 1 });
  await delay(5); assert.equal(expiry.lookup("expired-control"), undefined);
  expiry.register("positive-trigger", true);
  expiry.register("expired", "original", { ttlMs: 1 });
  await v2Expiry.register("expired-control", "original", { ttlMs: 1 });
  await delay(5); assert.equal(await v2Expiry.lookup("expired-control"), undefined);
  await v2Expiry.register("positive-trigger", true);
  await v2Expiry.register("expired", "original", { ttlMs: 1 });
  await legacy.register("sentinel", "original"); assert.equal(await legacy.lookup("sentinel"), "original");
  await legacy.register("delete-control", true); assert.equal(await legacy.delete("delete-control"), true);
  await legacyClear.register("control", true); await legacyClear.clear(); await legacyClear.register("sentinel", "original");
  await v2.register("sentinel", "original");
  let observed = await v2.observe("sentinel");
  assert.equal((await v2.compareAndApply("sentinel", observed.comparison,
    { operation: "update", action: "set", value: "positive" })).status, "applied");
  await v2.register("sentinel", "original"); observed = await v2.observe("sentinel");
  await v2.register("delete-control", true); assert.equal(await v2.delete("delete-control"), true);
  await v2Clear.register("control", true); await v2Clear.clear(); await v2Clear.register("sentinel", "original");
  await source.register("control", "original");
  assert.equal(await target.moveEntriesFrom({ namespace: "held-move-source",
    entries: [{ sourceKey: "control", targetKey: "control" }] }), 1);
  await source.register("held", "original");
  // The awaited command action retains normal plugin lifetime; no transaction spans this gate.
  emit({ boundary: "PRIMED", ordinaryPositive: true, processId: process.pid,
    families: ["sync", "legacy-async", "v2", "cas", "delete", "clear", "retained-move", "ttl"] });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line !== "RELEASE_AFTER_DOCTOR") throw new Error("invalid-proof-release");
      emit({ boundary: "RELEASED" });
      /** @type {Array<[string, () => unknown]>} */
      const attempts = [
        ["sync.register", () => sync.register("sentinel", "mutated")],
        ["sync.delete", () => sync.delete("sentinel")],
        ["sync.clear", () => syncClear.clear()],
        ["sync.expiry-trigger", () => expiry.register("trigger", true)],
        ["legacy.register", () => legacy.register("sentinel", "mutated")],
        ["legacy.delete", () => legacy.delete("sentinel")],
        ["legacy.clear", () => legacyClear.clear()],
        ["v2.register", () => v2.register("sentinel", "mutated")],
        ["v2.cas", () => v2.compareAndApply("sentinel", observed.comparison,
          { operation: "update", action: "set", value: "mutated" })],
        ["v2.delete", () => v2.delete("sentinel")],
        ["v2.clear", () => v2Clear.clear()],
        ["v2.expiry-trigger", () => v2Expiry.register("trigger", true)],
        ["v2.move", () => target.moveEntriesFrom({ namespace: "held-move-source",
          entries: [{ sourceKey: "held", targetKey: "held" }] })],
      ];
      for (const [operation, run] of attempts) {
        emit({ boundary: "INVOKED", operation });
        let value;
        try { value = await run(); }
        catch (error) { emit({ boundary: "REFUSED", operation, ...classify(error) }); continue; }
        if (operation === "v2.cas" && value?.status === "conflict") {
          emit({ boundary: "NO_EFFECT", operation, category: "comparison-conflict-native-write-unreached" });
          continue;
        }
        emit({ boundary: "UNEXPECTED_SUCCESS", operation });
        throw new Error("old-writer-bypass-stop");
      }
      emit({ boundary: "SETTLED" });
      return;
    }
    throw new Error("release-gate-closed-before-doctor");
  } finally { input.close(); }
}
async function ordinaryRpc(api, phase) {
  assert(["prime", "verify"].includes(phase), "invalid-proof-phase");
  const store = api.runtime.state.openKeyedStoreV2(options("gateway"));
  const clear = api.runtime.state.openKeyedStoreV2(options("gateway-clear"));
  const source = api.runtime.state.openKeyedStoreV2(options("gateway-source"));
  const retained = api.runtime.state.openKeyedStoreV2({ namespace: "gateway-target", retention: "retained" });
  if (phase === "prime") {
    await store.register("persistent", "original");
    await store.register("cas", "before"); const observed = await store.observe("cas");
    assert.equal((await store.compareAndApply("cas", observed.comparison,
      { operation: "update", action: "set", value: "after" })).status, "applied");
    await store.register("delete", true); assert.equal(await store.delete("delete"), true);
    await clear.register("clear", true); await clear.clear(); assert.equal(await clear.count(), 0);
    await source.register("move", "original");
    assert.equal(await retained.moveEntriesFrom({ namespace: "gateway-source",
      entries: [{ sourceKey: "move", targetKey: "move" }] }), 1);
    await store.register("ttl", true, { ttlMs: 1 }); await delay(30);
    assert.equal(await store.lookup("ttl"), undefined); await store.register("sweep", true);
  }
  assert.equal(await store.lookup("persistent"), "original");
  assert.equal(await store.lookup("cas"), "after");
  assert.equal(await retained.lookup("move"), "original");
  assert.equal(await source.lookup("move"), undefined);
  assert.equal(await store.lookup("delete"), undefined);
  return { proof: true, phase, ordinary: true, persisted: true, cas: true, retainedMove: true };
}
export default {
  id: "writer-fence-proof",
  register(api) {
    api.registerCli(({ program }) => {
      program.command("writer-fence-proof").description("Disposable writer-fence proof")
        .action(async () => { try { await oldWriter(api); }
          catch (error) { emit({ boundary: "FAILED", ...classify(error) }); throw new Error("writer-fence-proof-failed"); } });
    }, { descriptors: [{ name: "writer-fence-proof", description: "Disposable writer-fence proof", hasSubcommands: false }] });
    api.registerGatewayMethod("writer-fence-proof.crud", async ({ params }) =>
      ordinaryRpc(api, params?.phase), { scope: "operator.write" });
  },
};
