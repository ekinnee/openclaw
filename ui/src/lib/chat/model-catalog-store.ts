// Control UI model metadata boundary.
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { retryGatewayStartupRequest } from "../gateway-startup-retry.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
  inFlightRefresh?: boolean;
  inFlightRejects?: boolean;
  revalidationPending?: Promise<ModelCatalogEntry[]>;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

function modelCatalogCacheKey(agentId: string, preparedOnly: boolean): string {
  return `${agentId}\0${preparedOnly ? "prepared" : "exact"}`;
}

type LoadModelsOptions = {
  agentId: string;
  preparedOnly?: boolean;
  /** Bypass the Control UI cache without replacing Gateway's completed catalog generation. */
  revalidate?: boolean;
  refresh?: boolean;
  rejectOnFailure?: boolean;
  requestTimeoutMs?: number;
};

export function peekModels(
  client: GatewayBrowserClient,
  opts: Pick<LoadModelsOptions, "agentId" | "preparedOnly">,
): ModelCatalogEntry[] | undefined {
  const agentId = opts.agentId.trim();
  const cacheKey = modelCatalogCacheKey(agentId, opts.preparedOnly === true);
  const cached = modelCatalogCache.get(client)?.get(cacheKey);
  return cached?.expiresAt && cached.expiresAt > Date.now() ? cached.models : undefined;
}

export async function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts?.rejectOnFailure === true;
  const cacheKey = modelCatalogCacheKey(agentId, opts.preparedOnly === true);
  const preparedCacheKey = modelCatalogCacheKey(agentId, true);
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (!opts.revalidate && !opts.refresh && cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (
    cached?.inFlight &&
    cached.inFlightRejects === rejectOnFailure &&
    (!opts.refresh || cached.inFlightRefresh === true)
  ) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(
    client,
    cached?.models,
    agentId,
    opts.preparedOnly === true,
    opts.refresh === true,
    rejectOnFailure,
    opts.requestTimeoutMs,
  )
    .then((result) => {
      const latest = cache.get(cacheKey);
      if (!latest || latest.inFlight === inFlight) {
        const entry = {
          ...latest,
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          models: result.models,
        };
        cache.set(cacheKey, entry);
        if (result.fresh && opts.preparedOnly !== true) {
          // An exact catalog supersedes the prepared projection. Reusing it for
          // automatic reads prevents route re-entry from restoring stale data.
          cache.set(preparedCacheKey, {
            expiresAt: entry.expiresAt,
            models: entry.models,
          });
        }
      }
      return result.models;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    ...cached,
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
    inFlightRejects: rejectOnFailure,
    inFlightRefresh: opts.refresh === true,
  });
  return inFlight;
}

export function revalidateModels(
  client: GatewayBrowserClient,
  opts: Pick<LoadModelsOptions, "agentId" | "preparedOnly"> & { startupRetryWindowMs?: number },
): Promise<ModelCatalogEntry[]> {
  const agentId = opts.agentId.trim();
  const preparedOnly = opts.preparedOnly === true;
  const cacheKey = modelCatalogCacheKey(agentId, preparedOnly);
  const cache = modelCatalogCacheFor(client);
  const cached = cache.get(cacheKey);
  if (cached?.revalidationPending) {
    return cached.revalidationPending;
  }

  const request = (requestTimeoutMs?: number) =>
    loadModels(client, {
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      revalidate: true,
      rejectOnFailure: true,
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    });
  const startupRetryWindowMs = opts.startupRetryWindowMs;
  const revalidationPending =
    startupRetryWindowMs === undefined
      ? request()
      : retryGatewayStartupRequest({
          retryWindowMs: startupRetryWindowMs,
          request: (remainingMs) =>
            request(Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs)),
          requestFailure: (error) =>
            new Error("New-session model catalog request failed", { cause: error }),
          retryDeadlineMessage: "New-session model catalog retry deadline elapsed",
        });
  cache.set(cacheKey, {
    ...(cache.get(cacheKey) ?? cached ?? { expiresAt: 0, models: [] }),
    revalidationPending,
  });
  return revalidationPending.finally(() => {
    const latest = cache.get(cacheKey);
    if (latest?.revalidationPending === revalidationPending) {
      delete latest.revalidationPending;
    }
  });
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
  agentId: string,
  preparedOnly: boolean,
  refresh: boolean,
  rejectOnFailure: boolean,
  requestTimeoutMs: number | undefined,
): Promise<{ models: ModelCatalogEntry[]; fresh: boolean }> {
  try {
    const params = {
      view: "configured",
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    };
    const result = await (requestTimeoutMs === undefined
      ? client.request<{ models: ModelCatalogEntry[] }>("models.list", params)
      : client.request<{ models: ModelCatalogEntry[] }>("models.list", params, {
          timeoutMs: requestTimeoutMs,
        }));
    return { models: result?.models ?? [], fresh: true };
  } catch (error) {
    if (rejectOnFailure) {
      throw error;
    }
    // Failed loads fall back without extending the TTL so the next call retries.
    return { models: fallback ?? [], fresh: false };
  }
}
