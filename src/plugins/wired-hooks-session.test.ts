/**
 * Test: session_start & session_end hook wiring
 *
 * Tests the hook runner methods directly since session init is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import {
  addTestHook,
  createHookRunnerWithRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-fixtures.js";
import type { PluginHookSessionContext } from "./session-end-transcript.js";
import { attachSessionEndTranscriptSource } from "./session-end-transcript.js";
import type {
  PluginHookHandlerMap,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
} from "./types.js";

type PluginHookSessionStartContext = Parameters<PluginHookHandlerMap["session_start"]>[1];

async function expectSessionHookCall(params: {
  hookName: "session_start" | "session_end";
  event: PluginHookSessionStartEvent | PluginHookSessionEndEvent;
  sessionCtx: PluginHookSessionStartContext & { sessionKey: string; agentId: string };
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "session_start") {
    await runner.runSessionStart(params.event as PluginHookSessionStartEvent, params.sessionCtx);
  } else {
    await runner.runSessionEnd(params.event as PluginHookSessionEndEvent, params.sessionCtx);
  }

  if (params.hookName === "session_end") {
    expect(handler).toHaveBeenCalledWith(params.event, {
      ...params.sessionCtx,
      endedTranscript: {
        available: false,
        reason: "conversation-access-required",
      },
    });
  } else {
    expect(handler).toHaveBeenCalledWith(params.event, params.sessionCtx);
  }
}

describe("session hook runner methods", () => {
  const sessionCtx = { sessionId: "abc-123", sessionKey: "agent:main:abc", agentId: "main" };

  it.each([
    {
      name: "runSessionStart invokes registered session_start hooks",
      hookName: "session_start" as const,
      event: { sessionId: "abc-123", sessionKey: "agent:main:abc", resumedFrom: "old-session" },
    },
    {
      name: "runSessionEnd invokes registered session_end hooks",
      hookName: "session_end" as const,
      event: {
        sessionId: "abc-123",
        sessionKey: "agent:main:abc",
        messageCount: 42,
        reason: "daily" as const,
        sessionFile: "/tmp/abc-123.jsonl.reset.2026-04-02T10-00-00.000Z",
        transcriptArchived: true,
        nextSessionId: "def-456",
      },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectSessionHookCall({ hookName, event, sessionCtx });
  });

  it("delivers the prior transcript to before_reset hooks registered after runner creation", async () => {
    const { registry, runner } = createHookRunnerWithRegistry([]);
    const handler = vi.fn(async () => {});
    addTestHook({ registry, pluginId: "reset-observer", hookName: "before_reset", handler });
    const event = {
      messages: [{ role: "user", content: "Keep this context before reset." }],
      sessionFile: "/tmp/prior-session.jsonl",
      reason: "new",
    };

    await expect(runner.runBeforeReset(event, TEST_PLUGIN_AGENT_CTX)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event, TEST_PLUGIN_AGENT_CTX);
  });

  it("scopes ended transcript access to an admitted session_end handler", async () => {
    let retained: PluginHookSessionContext["endedTranscript"];
    const readTail = vi.fn(async () => ({
      messages: [{ role: "user", content: "remember this" }],
      totalMessages: 1,
      truncated: false,
    }));
    const admitted = vi.fn(async (_event, context) => {
      const transcript = (context as PluginHookSessionContext).endedTranscript;
      expect(transcript?.available).toBe(true);
      if (!transcript?.available) {
        throw new Error("expected ended transcript reader");
      }
      retained = transcript;
      await expect(transcript.readTail({ maxMessages: 10, maxBytes: 4_096 })).resolves.toEqual({
        messages: [{ role: "user", content: "remember this" }],
        totalMessages: 1,
        truncated: false,
      });
    });
    const metadataOnly = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "session_end",
        pluginId: "reader",
        handler: admitted,
        conversationAccessAllowed: true,
      },
      { hookName: "session_end", pluginId: "metadata", handler: metadataOnly },
    ]);
    const context = { ...sessionCtx };
    attachSessionEndTranscriptSource(context, { available: true, readTail });

    await runner.runSessionEnd(
      { sessionId: sessionCtx.sessionId, messageCount: 1, reason: "reset" },
      context,
    );

    expect(metadataOnly).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        endedTranscript: {
          available: false,
          reason: "conversation-access-required",
        },
      }),
    );
    expect(readTail).toHaveBeenCalledOnce();
    expect(retained?.available).toBe(true);
    if (retained?.available) {
      await expect(retained.readTail({ maxMessages: 1, maxBytes: 1_024 })).rejects.toThrow(
        "no longer active",
      );
    }
  });

  it("rejects an in-flight transcript read after its handler returns", async () => {
    let resolveRead!: (value: {
      messages: readonly unknown[];
      totalMessages: number;
      truncated: boolean;
    }) => void;
    const underlying = new Promise<{
      messages: readonly unknown[];
      totalMessages: number;
      truncated: boolean;
    }>((resolve) => {
      resolveRead = resolve;
    });
    let inFlight: Promise<unknown> | undefined;
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "session_end",
        handler: async (_event, context) => {
          const transcript = (context as PluginHookSessionContext).endedTranscript;
          if (!transcript?.available) {
            throw new Error("expected ended transcript reader");
          }
          inFlight = transcript.readTail({ maxMessages: 1, maxBytes: 1_024 });
        },
        conversationAccessAllowed: true,
      },
    ]);
    const context = { ...sessionCtx };
    attachSessionEndTranscriptSource(context, {
      available: true,
      readTail: () => underlying,
    });

    await runner.runSessionEnd(
      { sessionId: sessionCtx.sessionId, messageCount: 1, reason: "reset" },
      context,
    );
    resolveRead({ messages: [], totalMessages: 0, truncated: false });

    await expect(inFlight).rejects.toThrow("no longer active");
  });

  it("rejects a detached immediately fulfilled read after its handler returns", async () => {
    let detachedRead: Promise<unknown> | undefined;
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "session_end",
        handler: (_event, context) => {
          const transcript = (context as PluginHookSessionContext).endedTranscript;
          if (!transcript?.available) {
            throw new Error("expected ended transcript reader");
          }
          detachedRead = transcript.readTail({ maxMessages: 1, maxBytes: 1_024 });
        },
        conversationAccessAllowed: true,
      },
    ]);
    const context = { ...sessionCtx };
    attachSessionEndTranscriptSource(context, {
      available: true,
      readTail: async () => ({
        messages: [{ role: "user", content: "invocation only" }],
        totalMessages: 1,
        truncated: false,
      }),
    });

    await runner.runSessionEnd(
      { sessionId: sessionCtx.sessionId, messageCount: 1, reason: "reset" },
      context,
    );

    await expect(detachedRead).rejects.toThrow("no longer active");
  });
});
