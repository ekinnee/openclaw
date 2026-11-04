import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import { deleteMediaBuffer } from "../media/store.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { resolveChatAttachmentMaxBytes } from "./chat-attachment-policy.js";
import {
  INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
} from "./chat-attachments.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./server-methods/attachment-normalize.js";
import {
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  type NodeEventSessionSource,
} from "./server-node-event-source.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { resolveGatewayModelSupportsImages, resolveSessionModelRef } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

export type NodeAgentRequestPayload = {
  message?: string;
  sessionKey?: string | null;
  thinking?: string | null;
  deliver?: boolean;
  attachments?: Array<{
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
  }> | null;
  receipt?: boolean;
  receiptText?: string | null;
  to?: string | null;
  channel?: string | null;
  timeoutSeconds?: number | null;
  key?: string | null;
};

type NodeAgentCommandInput = Parameters<typeof agentCommandFromIngress>[0];

async function cleanupNodeEventMedia(
  media: Iterable<{ id: string }>,
  ctx: Pick<NodeEventContext, "logGateway">,
): Promise<void> {
  for (const { id } of media) {
    try {
      await deleteMediaBuffer(id);
    } catch (cleanupErr) {
      ctx.logGateway.warn(
        `Failed to cleanup orphaned media ${id}: ${formatErrorMessage(cleanupErr)}`,
      );
    }
  }
}

export async function handleNodeAgentRequest(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  link: NodeAgentRequestPayload | null,
  opts?: NodeEventHandlerOptions,
  source?: NodeEventSessionSource,
): Promise<NodeEventHandleResult | undefined> {
  const requestKey = normalizeOptionalString(link?.key);
  const requestDedupeKey = requestKey
    ? `node-agent:${JSON.stringify([nodeId, opts?.deviceId ?? null, opts?.pairingGeneration?.key ?? null, requestKey])}`
    : undefined;
  const sessionKeyRaw = (link?.sessionKey ?? "").trim();
  const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
  const cfg = getRuntimeConfig();
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

  let message = (link?.message ?? "").trim();
  let transcriptMessage = message;
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    link?.attachments ?? undefined,
  );
  let images: Awaited<ReturnType<typeof parseMessageWithAttachments>>["images"] = [];
  let imageOrder: PromptImageOrderEntry[] = [];
  let offloadedRefs: Awaited<ReturnType<typeof parseMessageWithAttachments>>["offloadedRefs"] = [];
  if (!message && normalizedAttachments.length === 0) {
    return undefined;
  }
  if (message.length > 20_000) {
    return undefined;
  }
  if (normalizedAttachments.length > 0) {
    const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
    const supportsInlineImages = await resolveGatewayModelSupportsImages({
      loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot: ctx.loadGatewayModelCatalogSnapshot,
      agentId: sessionAgentId,
      provider: modelRef.provider,
      model: modelRef.model,
    });
    if (!(await isNodeEventConnectionCurrent(opts))) {
      return pairingChangedResult(evt.event);
    }
    try {
      const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
        maxBytes: resolveChatAttachmentMaxBytes(cfg),
        log: ctx.logGateway,
        supportsInlineImages,
        // server-node-events dispatches via agentCommandFromIngress which
        // has no structured media wiring; reject non-image attachments
        // explicitly rather than saving them where the agent cannot reach them.
        acceptNonImage: false,
      });
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(parsed.offloadedRefs ?? [], ctx);
        return pairingChangedResult(evt.event);
      }
      message = parsed.message.trim();
      images = parsed.images;
      imageOrder = parsed.imageOrder;
      offloadedRefs = parsed.offloadedRefs;
      if (message.length > 20_000) {
        ctx.logGateway.warn(
          `agent.request message exceeds limit after attachment parsing (length=${message.length})`,
        );
        if (parsed.offloadedRefs && parsed.offloadedRefs.length > 0) {
          await cleanupNodeEventMedia(parsed.offloadedRefs, ctx);
        }
        return undefined;
      }
    } catch (err) {
      ctx.logGateway.warn(`agent.request attachment parse failed: ${formatErrorMessage(err)}`);
      return undefined;
    }
  }

  if (!message && images.length === 0) {
    return undefined;
  }

  const channelRaw = normalizeOptionalString(link?.channel) ?? "";
  let channel = normalizeChannelId(channelRaw) ?? undefined;
  let to = normalizeOptionalString(link?.to);
  const deliverRequested = Boolean(link?.deliver);
  const wantsReceipt = Boolean(link?.receipt);
  const receiptText =
    normalizeOptionalString(link?.receiptText) ||
    "Just received your iOS share + request, working on it.";

  const now = Date.now();
  let sessionId = entry?.sessionId ?? randomUUID();
  if (!(await isNodeEventConnectionCurrent(opts))) {
    await cleanupNodeEventMedia(offloadedRefs ?? [], ctx);
    return pairingChangedResult(evt.event);
  }

  if (storePath) {
    // The store owns creation. A concurrent retry must touch the canonical row,
    // not replace its identity with another UUID captured before either write.
    const touched = await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { updatedAt: now },
      { workerGuard: { assertCurrent: source?.assertCurrent } },
    );
    sessionId = touched?.sessionId ?? sessionId;
  }
  if (!(await isNodeEventConnectionCurrent(opts))) {
    await cleanupNodeEventMedia(offloadedRefs ?? [], ctx);
    return pairingChangedResult(evt.event);
  }

  if (deliverRequested && (!channel || !to)) {
    const entryContext = deliveryContextFromSession(entry);
    const entryChannel = entryContext?.channel
      ? normalizeChannelId(entryContext.channel)
      : undefined;
    const entryTo = normalizeOptionalString(entryContext?.to) ?? "";
    if (!channel && entryChannel) {
      channel = entryChannel;
    }
    if (!to && entryTo) {
      to = entryTo;
    }
  }
  const deliver = deliverRequested && Boolean(channel && to);
  const deliveryChannel = deliver ? channel : undefined;
  const deliveryTo = deliver ? to : undefined;
  if (deliverRequested && !deliver) {
    ctx.logGateway.warn(
      `agent delivery disabled node=${nodeId}: missing session delivery route (channel=${channel ?? "-"} to=${to ?? "-"})`,
    );
  }

  if (!(await isNodeEventConnectionCurrent(opts))) {
    await cleanupNodeEventMedia(offloadedRefs ?? [], ctx);
    return pairingChangedResult(evt.event);
  }
  const persistedTranscriptMedia = await persistInboundImagesForTranscript({
    images,
    offloadedRefs,
    log: ctx.logGateway,
    logContext: "agent.request",
  });
  if (!(await isNodeEventConnectionCurrent(opts))) {
    await cleanupNodeEventMedia(persistedTranscriptMedia.entries, ctx);
    return pairingChangedResult(evt.event);
  }
  if (persistedTranscriptMedia.omission === "inline-image-save-failed") {
    transcriptMessage = [transcriptMessage, INLINE_IMAGE_DURABLE_OMISSION_MARKER]
      .filter(Boolean)
      .join("\n");
  }
  const transcriptMedia = persistedTranscriptMedia.entries.map((media) => media.fact);

  const nodeAgentInput: NodeAgentCommandInput = {
    runId: sessionId,
    message,
    images,
    imageOrder,
    ...(transcriptMedia.length > 0 ||
    persistedTranscriptMedia.omission === "inline-image-save-failed"
      ? { transcriptMessage, ...(transcriptMedia.length > 0 ? { transcriptMedia } : {}) }
      : {}),
    sessionId,
    sessionKey: canonicalKey,
    thinking: link?.thinking ?? undefined,
    deliver,
    to: deliveryTo,
    channel: deliveryChannel,
    timeout: typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
    messageChannel: "node",
    allowModelOverride: false,
  };
  const nodeAdmissionConnectionCurrent = opts?.isConnectionCurrent;
  const onNodeAdmissionRejected = () =>
    cleanupNodeEventMedia(persistedTranscriptMedia.entries, ctx);
  // The node RPC can finish before the agent starts its own session admission.
  // Reserve a root now so suspension cannot acknowledge and then strand the turn,
  // but recheck the admitted connection before agent work actually starts.
  const agentWork = runWithGatewayIndependentRootWorkContinuation(async () => {
    if (nodeAdmissionConnectionCurrent && !(await nodeAdmissionConnectionCurrent())) {
      await onNodeAdmissionRejected();
      return;
    }
    source?.assertCurrent();
    if (requestDedupeKey) {
      const admittedAt = Date.now();
      const previous = ctx.dedupe.get(requestDedupeKey);
      if (previous && admittedAt - previous.ts < DEDUPE_TTL_MS) {
        await onNodeAdmissionRejected();
        return;
      }
      // Reuse the existing process-local window; expiry or restart permits replay.
      ctx.dedupe.set(requestDedupeKey, { ts: admittedAt, ok: true, effectAccepted: true });
    }

    if (wantsReceipt && deliveryChannel && deliveryTo) {
      // Delivery stays detached from agent startup, but remains part of the
      // accepted node request until the durable send settles.
      const receipt = runWithGatewayIndependentRootWorkContinuation(async () => {
        if (!(await isNodeEventConnectionCurrent(opts))) {
          return;
        }
        const receiptDeps = ctx.deps;
        const resolved = await resolveOutboundTarget({
          channel: deliveryChannel,
          to: deliveryTo,
          cfg,
          mode: "explicit",
        });
        if (!resolved.ok) {
          throw new Error(String(resolved.error));
        }
        const session = buildOutboundSessionContext({
          cfg,
          sessionKey: canonicalKey,
        });
        const send = await sendDurableMessageBatchCore({
          cfg,
          channel: deliveryChannel,
          to: resolved.to,
          payloads: [{ text: receiptText }],
          session,
          bestEffort: true,
          durability: "best_effort",
          deps: createOutboundSendDeps(receiptDeps),
        });
        if (send.status === "failed") {
          throw send.error;
        }
      }, "node-events:delivery").catch((err: unknown) => {
        ctx.logGateway.warn(`agent receipt failed node=${nodeId}: ${formatForLog(err)}`);
      });
      source?.pending.push(receipt);
    } else if (wantsReceipt) {
      ctx.logGateway.warn(
        `agent receipt skipped node=${nodeId}: missing delivery route (channel=${deliveryChannel ?? "-"} to=${deliveryTo ?? "-"})`,
      );
    }

    await agentCommandFromIngress(nodeAgentInput, defaultRuntime, ctx.deps);
  }, "node-events:agent-turn").catch((err: unknown) => {
    ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
  });
  source?.pending.push(agentWork);
  return undefined;
}
