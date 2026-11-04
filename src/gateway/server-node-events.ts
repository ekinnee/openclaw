// Handles device/node-originated events and routes them to sessions/channels.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import {
  validateNodeHostStatsPayload,
  validateNodePresenceActivityPayload,
} from "../../packages/gateway-protocol/src/index.js";
import { DesktopAvailabilitySchema } from "../../packages/gateway-protocol/src/schema/environments.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { updatePairedDevicePresence } from "../infra/device-pairing.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NODE_HOST_STATS_EVENT } from "../shared/node-host-stats.js";
import {
  NODE_PRESENCE_ALIVE_EVENT,
  NODE_PRESENCE_ACTIVITY_EVENT,
  normalizeNodePresenceAliveReason,
} from "../shared/node-presence.js";
import {
  pruneBoundedTimestampMap,
  withNodeEventSessionSource,
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
  type NodeEventSessionSource,
} from "./server-node-event-source.js";
import {
  handleNodeAgentRequest,
  type NodeAgentRequestPayload,
} from "./server-node-events-agent.js";
import { registerNodeApnsEvent } from "./server-node-events-apns.js";
import { handleNodeExecEvent } from "./server-node-events-exec-notice.js";
import { handleNodeNotificationEvent } from "./server-node-events-notifications.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { formatForLog } from "./ws-log.js";

const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;
const NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS = 60_000;
const MAX_RECENT_NODE_PRESENCE_KEYS = 1024;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();
type VoiceTranscriptReservationAdmission = { work: Promise<unknown> } | null;
type VoiceTranscriptReservation = {
  fingerprint: string;
  receivedAt: number;
  status: "pending" | "ready" | "checking" | "rejected";
  isConnectionCurrent?: () => boolean | Promise<boolean>;
  assertCurrent?: () => void;
  start?: () => Promise<unknown>;
  resolve: (admission: VoiceTranscriptReservationAdmission) => void;
  rejectDecision: (reason: unknown) => void;
};
const pendingVoiceTranscriptReservations = new Map<string, VoiceTranscriptReservation[]>();
const recentNodePresencePersistAt = new Map<string, number>();

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function resolveVoiceTranscriptFingerprint(obj: Record<string, unknown>, text: string): string {
  const eventId =
    normalizeOptionalString(obj.eventId) ??
    normalizeOptionalString(obj.providerEventId) ??
    normalizeOptionalString(obj.transcriptId);
  if (eventId) {
    return `event:${eventId}`;
  }

  const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
  const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
  if (callId && sequence !== null) {
    return `call-seq:${callId}:${sequence}`;
  }

  const eventTimestamp =
    normalizeFiniteInteger(obj.timestamp) ??
    normalizeFiniteInteger(obj.ts) ??
    normalizeFiniteInteger(obj.eventTimestamp);
  if (callId && eventTimestamp !== null) {
    return `call-ts:${callId}:${eventTimestamp}`;
  }

  if (eventTimestamp !== null) {
    return `timestamp:${eventTimestamp}|text:${text}`;
  }

  return `text:${text}`;
}

function shouldDropDuplicateVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  now: number;
}): boolean {
  // Voice providers can replay identical transcript fragments during reconnect.
  // Keep only a bounded last fingerprint per session to avoid duplicate sends.
  const previous = recentVoiceTranscripts.get(params.sessionKey);
  if (
    previous &&
    previous.fingerprint === params.fingerprint &&
    params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  recentVoiceTranscripts.set(params.sessionKey, {
    fingerprint: params.fingerprint,
    ts: params.now,
  });

  if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
    const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
    for (const [key, value] of recentVoiceTranscripts) {
      if (value.ts < cutoff) {
        recentVoiceTranscripts.delete(key);
      }
      if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) {
        break;
      }
    }
    pruneMapToMaxSize(recentVoiceTranscripts, MAX_RECENT_VOICE_TRANSCRIPTS);
  }

  return false;
}

type LoadedSessionEntry = Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;

async function touchSessionStore(params: {
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  sessionId: string;
  now: number;
  assertCurrent?: () => void;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await upsertSessionEntryCore(
    {
      sessionKey: params.canonicalKey,
      storePath,
    },
    {
      sessionId: params.sessionId,
      updatedAt: params.now,
    },
    { workerGuard: { assertCurrent: params.assertCurrent } },
  );
}

function queueSessionStoreTouch(
  params: Parameters<typeof touchSessionStore>[0] & {
    ctx: NodeEventContext;
    isConnectionCurrent?: () => boolean | Promise<boolean>;
  },
): Promise<void> {
  // Voice dispatch intentionally does not wait for persistence, but a host
  // snapshot must not race the accepted write after its node RPC returns.
  return runWithGatewayIndependentRootWorkContinuation(async () => {
    if (params.isConnectionCurrent && !(await params.isConnectionCurrent())) {
      return;
    }
    await touchSessionStore(params);
  }, "node-events:voice-persist").catch((err: unknown) => {
    params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(err));
  });
}

export const handleNodeEvent = (
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult | undefined> =>
  withNodeEventSessionSource(evt, opts, (preparedOptions, source) =>
    handlePreparedNodeEvent(ctx, nodeId, evt, preparedOptions, source),
  );

async function handlePreparedNodeEvent(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
  source?: NodeEventSessionSource,
): Promise<NodeEventHandleResult | undefined> {
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  switch (evt.event) {
    case "node.desktop.availability": {
      const availability = parseNodeEventPayload(evt.payloadJSON);
      if (!Value.Check(DesktopAvailabilitySchema, availability)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const updated = ctx.updateNodeDesktopAvailability?.({
        nodeId,
        connId: opts?.connId,
        availability,
      });
      if (updated === null || updated === undefined) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      return {
        ok: true,
        event: evt.event,
        handled: true,
        reason: updated ? "updated" : "unchanged",
      };
    }
    case "voice.transcript": {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const text = normalizeOptionalString(obj.text) ?? "";
      if (!text) {
        return undefined;
      }
      if (text.length > 20_000) {
        return undefined;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
      const cfg = getRuntimeConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
      const { storePath, entry, canonicalKey } =
        source?.loaded ??
        (await loadGatewaySessionEntryReadOnlyInWorker({
          cfg,
          key: sessionKey,
          excludeInternalEffects: true,
        }));
      if (resolveAgentHarnessSessionContextError(canonicalKey, entry)) {
        return undefined;
      }
      const receivedAt = Date.now();
      const fingerprint = resolveVoiceTranscriptFingerprint(obj, text);
      const sessionId = entry?.sessionId ?? randomUUID();
      const runId = randomUUID();
      source?.assertCurrent();
      // Resolve reservations in receipt order so delayed currentness checks cannot
      // change the dedupe window, while rejected connections leave no committed state.
      const decision = createDeferredCore<VoiceTranscriptReservationAdmission>();
      const reservation: VoiceTranscriptReservation = {
        fingerprint,
        receivedAt,
        status: "pending",
        resolve: decision.resolve,
        rejectDecision: decision.reject,
        assertCurrent: source?.assertCurrent,
      };
      const queue = pendingVoiceTranscriptReservations.get(canonicalKey) ?? [];
      queue.push(reservation);
      pendingVoiceTranscriptReservations.set(canonicalKey, queue);

      const drain = () => {
        while (queue[0]?.status === "rejected") {
          queue.shift()?.resolve(null);
        }
        const next = queue[0];
        if (!next) {
          pendingVoiceTranscriptReservations.delete(canonicalKey);
          return;
        }
        if (next.status !== "ready") {
          return;
        }
        next.status = "checking";
        void (async () => {
          try {
            const isCurrent = next.isConnectionCurrent ? await next.isConnectionCurrent() : true;
            next.assertCurrent?.();
            const admission =
              isCurrent &&
              !shouldDropDuplicateVoiceTranscript({
                sessionKey: canonicalKey,
                fingerprint: next.fingerprint,
                now: next.receivedAt,
              }) &&
              next.start
                ? { work: next.start() }
                : null;
            next.resolve(admission);
          } catch (err) {
            next.rejectDecision(err);
          } finally {
            queue.shift();
            drain();
          }
        })();
      };
      const settle = (status: "ready" | "rejected") => {
        if (reservation.status !== "pending") {
          return;
        }
        reservation.status = status;
        drain();
      };

      const isConnectionCurrent = opts?.isConnectionCurrent;
      const voiceWork = runWithGatewayIndependentRootWorkContinuation(async () => {
        if (isConnectionCurrent && !(await isConnectionCurrent())) {
          settle("rejected");
          return;
        }
        reservation.isConnectionCurrent = isConnectionCurrent;
        reservation.start = () => {
          const touch = queueSessionStoreTouch({
            ctx,
            storePath,
            canonicalKey,
            sessionId,
            now: receivedAt,
            assertCurrent: source?.assertCurrent,
            isConnectionCurrent: opts?.isConnectionCurrent,
          });

          source?.pending.push(touch);

          // Voice now has a unique per-turn run id, so it is also the stable
          // client identity for chat streaming and abort lifecycle ownership.
          ctx.addChatRun(runId, {
            sessionKey: canonicalKey,
            clientRunId: runId,
          });
          return agentCommandFromIngress(
            {
              runId,
              message: text,
              sessionId,
              sessionKey: canonicalKey,
              thinking: "low",
              deliver: false,
              messageChannel: "node",
              inputProvenance: {
                kind: "external_user",
                sourceChannel: "voice",
                sourceTool: "gateway.voice.transcript",
              },
              allowModelOverride: false,
            },
            defaultRuntime,
            ctx.deps,
          );
        };
        settle("ready");
        const admission = await decision.promise;
        if (!admission) {
          return;
        }
        await admission.work;
      }, "node-events:voice-turn").catch((err: unknown) => {
        settle("rejected");
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      source?.pending.push(voiceWork);
      return undefined;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return undefined;
      }
      let link: NodeAgentRequestPayload | null;
      try {
        link = JSON.parse(evt.payloadJSON) as NodeAgentRequestPayload;
      } catch {
        return undefined;
      }
      return handleNodeAgentRequest(ctx, nodeId, evt, link, opts, source);
    }
    case "notifications.changed":
      return handleNodeNotificationEvent(ctx, nodeId, evt, opts, source);
    case "chat.subscribe":
    case "chat.unsubscribe": {
      const sessionKey = normalizeOptionalString(
        parseNodeEventPayload(evt.payloadJSON)?.sessionKey,
      );
      if (!sessionKey) {
        return undefined;
      }
      const { canonicalKey } = resolveSessionStoreIdentity({ cfg: getRuntimeConfig(), sessionKey });
      // Fanout is keyed by the canonical session; retain the connection owner for safe reconnect.
      if (evt.event === "chat.subscribe") {
        await ctx.nodeSubscribe(nodeId, canonicalKey, opts?.connId);
      } else {
        await ctx.nodeUnsubscribe(nodeId, canonicalKey, opts?.connId);
      }
      return undefined;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied":
      return handleNodeExecEvent(ctx, nodeId, evt.event, evt.payloadJSON, opts);
    case "push.apns.register": {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const result = await registerNodeApnsEvent(ctx, nodeId, obj, opts);
      return result === "pairing-changed" ? pairingChangedResult(evt.event) : undefined;
    }
    case NODE_HOST_STATS_EVENT: {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj || !validateNodeHostStatsPayload(obj)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const hostStats = ctx.updateNodeHostStats?.({ nodeId, connId: opts?.connId, stats: obj });
      if (!hostStats) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      ctx.broadcast("node.hostStats", { nodeId, hostStats }, { dropIfSlow: true });
      return { ok: true, event: evt.event, handled: true, reason: "updated" };
    }
    case NODE_PRESENCE_ACTIVITY_EVENT: {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj || !validateNodePresenceActivityPayload(obj)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      if ("action" in obj) {
        const cleared = ctx.clearNodePresenceActivity?.({ nodeId, connId: opts?.connId });
        if (cleared === null || cleared === undefined) {
          return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
        }
        if (cleared) {
          ctx.broadcast(
            "node.presence",
            { nodeId, lastActiveAtMs: null, presenceUpdatedAtMs: null },
            { dropIfSlow: true },
          );
        }
        return {
          ok: true,
          event: evt.event,
          handled: true,
          reason: cleared ? "cleared" : "already_clear",
        };
      }
      if (obj.source !== "app" && opts?.presenceAllowed !== true) {
        return { ok: true, event: evt.event, handled: false, reason: "permission_required" };
      }
      const updated = ctx.updateNodePresenceActivity?.({
        nodeId,
        connId: opts?.connId,
        ...obj,
      });
      if (!updated) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      ctx.broadcast("node.presence", { nodeId, ...updated }, { dropIfSlow: true });
      return { ok: true, event: evt.event, handled: true, reason: "updated" };
    }
    case NODE_PRESENCE_ALIVE_EVENT: {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const deviceId = normalizeOptionalString(opts?.deviceId);
      if (!deviceId) {
        return { ok: true, event: evt.event, handled: false, reason: "missing_device_identity" };
      }
      const pairingGeneration = opts?.pairingGeneration;
      if (!pairingGeneration || pairingGeneration.nodeId !== deviceId) {
        return pairingChangedResult(evt.event);
      }
      const now = Date.now();
      const presenceOwnerKey = `${deviceId}\0${pairingGeneration.key}`;
      const lastPersistedAt = recentNodePresencePersistAt.get(presenceOwnerKey) ?? 0;
      if (now - lastPersistedAt < NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS) {
        return { ok: true, event: evt.event, handled: true, reason: "throttled" };
      }

      const lastSeenReason = normalizeNodePresenceAliveReason(obj.trigger);
      try {
        // Node last-seen lives on the device record; node.pair.list projects
        // it from there, so one write covers both surfaces.
        const deviceUpdated = await updatePairedDevicePresence(
          deviceId,
          {
            lastSeenAtMs: now,
            lastSeenReason,
          },
          pairingGeneration,
        );
        if (!deviceUpdated) {
          return pairingChangedResult(evt.event);
        }
        recentNodePresencePersistAt.set(presenceOwnerKey, now);
        pruneBoundedTimestampMap(recentNodePresencePersistAt, {
          now,
          ttlMs: NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS * 10,
          maxEntries: MAX_RECENT_NODE_PRESENCE_KEYS,
        });
        return { ok: true, event: evt.event, handled: true, reason: "persisted" };
      } catch (err) {
        ctx.logGateway.warn(`node presence alive failed node=${nodeId}: ${formatForLog(err)}`);
        return { ok: true, event: evt.event, handled: false, reason: "persist_failed" };
      }
    }
    default:
      return { ok: true, event: evt.event, handled: false, reason: "unsupported_event" };
  }
}
