import "./server-node-events.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
import type { NodeEventHandlerOptions } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const { buildNodeEventContext, buildSessionLookup, runtimeMocks } =
  await import("./server-node-events.test-support.js");
const {
  agentCommandFromIngress: dispatch,
  sendDurableMessageBatch: sendBatch,
  persistInboundImagesForTranscript: persistImages,
} = runtimeMocks;

function nodeFixture(nodeId: string, overrides: Parameters<typeof buildNodeEventContext>[0] = {}) {
  const ctx = buildNodeEventContext(overrides);
  return {
    ctx,
    request: (payload: Record<string, unknown>, connection?: NodeEventHandlerOptions) =>
      handleNodeEvent(
        ctx,
        nodeId,
        {
          event: "agent.request",
          payloadJSON: JSON.stringify({
            message: "request",
            sessionKey: "agent:main:main",
            ...payload,
          }),
        },
        connection,
      ),
  };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  dispatch.mockReset().mockResolvedValue(undefined);
  persistImages.mockReset().mockResolvedValue({ entries: [], omission: "none" });
  sendBatch.mockReset().mockResolvedValue({
    status: "sent",
    results: [],
    receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
  });
  runtimeMocks.deleteMediaBuffer.mockClear();
  runtimeMocks.loadSessionEntry
    .mockReset()
    .mockImplementation((key: string) => buildSessionLookup(key));
  runtimeMocks.upsertSessionEntryCore
    .mockReset()
    .mockImplementation(async (_scope, patch) => patch);
});
afterEach(resetGatewayWorkAdmission);

function eventResult(event: string, reason: string) {
  return { ok: true, event, handled: false, reason };
}

describe("agent request retries", () => {
  it.each([false, true])(
    "deduplicates accepted agent requests (concurrent=%s)",
    async (concurrent) => {
      const { request } = nodeFixture("node-share-retry");
      const payload = { key: "same-logical-share" };
      if (concurrent) {
        await Promise.all([request(payload), request(payload)]);
      } else {
        await request(payload);
        await request(payload);
      }

      // Both valid requests reached admission; only the logical share may dispatch.
      expect(persistImages).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["new request", 2],
    ["another node", 2],
    ["re-paired node", 2],
    ["within window", 1],
    ["expired", 2],
    ["restart", 2],
    ["unkeyed", 2],
  ] as const)("scopes agent-request deduplication: %s", async (variant, expected) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const first = nodeFixture("node-share-window");
      const payload = variant === "unkeyed" ? {} : { key: "logical-share" };
      await first.request(payload, {
        deviceId: "share-device",
        pairingGeneration: { nodeId: "node-share-window", key: "generation-one" },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);

      const nodeId = variant === "another node" ? "other-node" : "node-share-window";
      const second = nodeFixture(nodeId, {
        dedupe: variant === "restart" ? new Map() : first.ctx.dedupe,
      });
      clock.mockReturnValue(
        now +
          (variant === "expired"
            ? DEDUPE_TTL_MS
            : variant === "within window"
              ? DEDUPE_TTL_MS - 1
              : 0),
      );
      await second.request(variant === "new request" ? { key: "new-logical-share" } : payload, {
        deviceId: "share-device",
        pairingGeneration: {
          nodeId,
          key: variant === "re-paired node" ? "generation-two" : "generation-one",
        },
      });
      expect(dispatch).toHaveBeenCalledTimes(expected);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not consume an agent-request key when admission is rejected", async () => {
    const { ctx, request } = nodeFixture("node-share-rejected");
    const payload = { key: "retry-after-rejection" };
    await expect(request(payload, { isConnectionCurrent: () => false })).resolves.toEqual(
      eventResult("agent.request", "pairing_changed"),
    );
    expect(ctx.dedupe.size).toBe(0);
    expectNoCalls(dispatch);

    await request(payload);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not resend an accepted share receipt on retry", async () => {
    const { request } = nodeFixture("node-share-receipt");
    const payload = {
      key: "share-with-receipt",
      deliver: true,
      receipt: true,
      channel: "telegram",
      to: "123",
    };
    await request(payload);
    await request(payload);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it("retains the winning session identity when concurrent retries create a default session", async () => {
    const nodeId = "node-new-session";
    runtimeMocks.loadSessionEntry.mockReturnValue({
      ...buildSessionLookup(`node-${nodeId}`),
      entry: undefined,
      store: {},
    });
    let storedSessionId: string | undefined;
    runtimeMocks.upsertSessionEntryCore.mockImplementation(async (_scope, patch) => {
      // Model the accessor's fields patch: omitted identity preserves the stored
      // row, and the owner creates an ID only when no row exists yet.
      storedSessionId = patch.sessionId ?? storedSessionId ?? "store-created-session";
      return { ...patch, sessionId: storedSessionId };
    });
    const { request } = nodeFixture(nodeId);
    const payload = { key: "same-new-session-share", sessionKey: undefined };
    await Promise.all([request(payload), request(payload)]);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(storedSessionId).toBe(dispatch.mock.calls[0]?.[0]?.sessionId);
  });

  it("releases a retry key if pairing is revoked during the accepted session write", async () => {
    let current = true;
    runtimeMocks.upsertSessionEntryCore.mockImplementationOnce(async (_scope, patch) => {
      current = false;
      return patch;
    });
    const { ctx, request } = nodeFixture("node-revoked-on-write");
    const payload = { key: "retry-revoked-on-write" };
    await request(payload, { isConnectionCurrent: () => current });
    await vi.waitFor(() => expect(ctx.dedupe.size).toBe(0));
    expectNoCalls(dispatch);

    current = true;
    await request(payload, { isConnectionCurrent: () => current });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });

  it("cleans only media staged by the duplicate request", async () => {
    const media = (id: string) => ({
      entries: [
        {
          id,
          path: `/media/inbound/${id}.png`,
          sourceIndex: 0,
          imageKind: "inline" as const,
          fact: { url: `media://inbound/${id}.png`, contentType: "image/png" },
        },
      ],
      omission: "none" as const,
    });
    persistImages
      .mockResolvedValueOnce(media("original-share"))
      .mockResolvedValueOnce(media("duplicate-share"));
    const { request } = nodeFixture("node-share-media");
    await request({ key: "share-media" });
    await request({ key: "share-media" });

    await vi.waitFor(() =>
      expect(runtimeMocks.deleteMediaBuffer).toHaveBeenCalledExactlyOnceWith("duplicate-share"),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.transcriptMedia).toEqual([
      { url: "media://inbound/original-share.png", contentType: "image/png" },
    ]);
  });
});
