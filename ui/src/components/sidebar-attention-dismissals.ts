// Per-gateway, per-browser snooze state for the sidebar attention chips.
// Deliberately client-side chrome (like nav width / dock layout), not gateway
// state: dismissing a nag on one device should not acknowledge it everywhere.
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const SIDEBAR_ATTENTION_ITEM_KINDS = ["cronFailed", "cronOverdue", "modelAuthExpired"] as const;
export type SidebarAttentionKind = (typeof SIDEBAR_ATTENTION_ITEM_KINDS)[number];

export type UpdateAttentionDismissal = { version: string; gatewayBootId: string };
export type SidebarAttentionDismissals = Partial<Record<SidebarAttentionKind, string[]>> & {
  scopeUpgrade?: string;
  updateAvailable?: UpdateAttentionDismissal;
};

// Minimal chip shape the snooze logic needs; keeps this module free of the
// component's item type so the two files cannot form an import cycle.
type DismissableChip = { kind: SidebarAttentionKind; signature: string };
type DismissalPruneScope = {
  cronInventoryComplete: boolean;
  modelAuthAgentId: string | null;
};

const DISMISSED_STORE_PREFIX = "openclaw.control.sidebarAttention.v1:";

export function dismissalStoreKey(gatewayUrl: string): string {
  return `${DISMISSED_STORE_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

export function loadDismissals(gatewayUrl: string): SidebarAttentionDismissals {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(dismissalStoreKey(gatewayUrl)) ?? "null");
    const record = asNullableRecord(parsed);
    if (!record) {
      return {};
    }
    const result: SidebarAttentionDismissals = {};
    for (const kind of SIDEBAR_ATTENTION_ITEM_KINDS) {
      const value = record[kind];
      const signatures = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : typeof value === "string"
          ? [value]
          : [];
      if (signatures.length > 0) {
        result[kind] = [...new Set(signatures)];
      }
    }
    const scopeUpgrade = readStringField(record, "scopeUpgrade");
    if (scopeUpgrade) {
      result.scopeUpgrade = scopeUpgrade;
    }
    const updateAvailable = asNullableRecord(record.updateAvailable);
    const version = readStringField(updateAvailable, "version");
    const gatewayBootId = readStringField(updateAvailable, "gatewayBootId");
    if (version && gatewayBootId) {
      result.updateAvailable = { version, gatewayBootId };
    }
    return result;
  } catch {
    return {};
  }
}

export function saveDismissals(gatewayUrl: string, dismissals: SidebarAttentionDismissals) {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    if (Object.keys(dismissals).length === 0) {
      storage.removeItem(dismissalStoreKey(gatewayUrl));
    } else {
      storage.setItem(dismissalStoreKey(gatewayUrl), JSON.stringify(dismissals));
    }
  } catch {
    // Quota/privacy-mode failures just lose the snooze; chips reappear.
  }
}

/** Merge dismissals against persisted state so concurrent tabs keep each other's entries. */
export function addDismissals(
  gatewayUrl: string,
  items: readonly DismissableChip[],
): SidebarAttentionDismissals {
  const stored = loadDismissals(gatewayUrl);
  const next = { ...stored };
  for (const item of items) {
    next[item.kind] = [...new Set([...(next[item.kind] ?? []), item.signature])];
  }
  saveDismissals(gatewayUrl, next);
  return next;
}

export function resolveScopeUpgradeAttentionDismissal(
  scopes: readonly string[] | undefined,
): string | null {
  return scopes === undefined ? null : JSON.stringify([...new Set(scopes)].toSorted());
}

export function dismissScopeUpgradeAttention(
  gatewayUrl: string,
  dismissal: string,
): SidebarAttentionDismissals {
  const next = { ...loadDismissals(gatewayUrl), scopeUpgrade: dismissal };
  saveDismissals(gatewayUrl, next);
  return next;
}

export function rearmScopeUpgradeAttention(
  dismissals: SidebarAttentionDismissals,
  current: string | null,
): SidebarAttentionDismissals {
  if (!current || !dismissals.scopeUpgrade || dismissals.scopeUpgrade === current) {
    return dismissals;
  }
  const { scopeUpgrade: _scopeUpgrade, ...next } = dismissals;
  return next;
}

export function resolveUpdateAttentionDismissal(params: {
  gatewayBootId?: string | null;
  updateAvailable?: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
}): UpdateAttentionDismissal | null {
  const target = params.updateSchedule?.target;
  const version =
    (target?.kind === "package" ? target.version : target?.upstreamSha) ??
    params.updateAvailable?.upstreamSha ??
    params.updateAvailable?.latestVersion;
  const gatewayBootId = params.gatewayBootId?.trim();
  const normalizedVersion = version?.trim();
  return gatewayBootId && normalizedVersion ? { version: normalizedVersion, gatewayBootId } : null;
}

export function isUpdateAttentionDismissed(
  dismissals: SidebarAttentionDismissals,
  current: UpdateAttentionDismissal | null,
): boolean {
  const stored = dismissals.updateAvailable;
  return Boolean(
    stored &&
    current &&
    stored.version === current.version &&
    stored.gatewayBootId === current.gatewayBootId,
  );
}

export function isUpdateAttentionForced(tone: "danger" | "info" | "warn" | null | undefined) {
  return tone === "warn" || tone === "danger";
}

export function dismissUpdateAttention(
  gatewayUrl: string,
  dismissal: UpdateAttentionDismissal,
): SidebarAttentionDismissals {
  const next = { ...loadDismissals(gatewayUrl), updateAvailable: dismissal };
  saveDismissals(gatewayUrl, next);
  return next;
}

/**
 * Drop dismissals whose chip is gone or whose entity set changed, so a state
 * that clears and later recurs surfaces again instead of staying hidden by a
 * stale snooze. Returns the input object when nothing changed.
 */
export function pruneDismissals(
  dismissals: SidebarAttentionDismissals,
  items: readonly DismissableChip[],
  updateAvailable: UpdateAttentionDismissal | null = null,
  scope?: DismissalPruneScope,
): SidebarAttentionDismissals {
  const next: SidebarAttentionDismissals = {};
  let changed = false;
  for (const kind of SIDEBAR_ATTENTION_ITEM_KINDS) {
    const stored = dismissals[kind];
    if (!stored) {
      continue;
    }
    const current = stored.filter((signature) => {
      // Partial agent responses cannot clear another agent's dismissal; only the
      // current auth owner and a complete cron inventory may re-arm signatures.
      const authoritative =
        !scope ||
        (kind === "modelAuthExpired"
          ? Boolean(
              scope.modelAuthAgentId &&
              (!signature.startsWith("agent:") ||
                signature.startsWith(`agent:${scope.modelAuthAgentId}\n`)),
            )
          : scope.cronInventoryComplete);
      return (
        !authoritative || items.some((item) => item.kind === kind && item.signature === signature)
      );
    });
    if (current.length > 0) {
      next[kind] = current;
    }
    if (current.length !== stored.length) {
      changed = true;
    }
  }
  if (dismissals.scopeUpgrade) {
    next.scopeUpgrade = dismissals.scopeUpgrade;
  }
  if (isUpdateAttentionDismissed(dismissals, updateAvailable)) {
    next.updateAvailable = dismissals.updateAvailable;
  } else if (dismissals.updateAvailable) {
    changed = true;
  }
  return changed ? next : dismissals;
}
