import type { ApplicationContext } from "../app/context.ts";
import { hasNativeUpdateBridge } from "../app/native-link-routing.ts";
import { confirmAndStartUpdate, type UpdateProgress } from "../app/update-confirmation.ts";
import { isUpdateActionable } from "../app/update-overlay-helpers.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  dismissUpdateAttention,
  isUpdateAttentionDismissed,
  isUpdateAttentionForced,
  resolveUpdateAttentionDismissal,
  type SidebarAttentionDismissals,
  type UpdateAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";

type SidebarUpdateContext = Pick<ApplicationContext, "gateway" | "overlays">;

export type SidebarUpdateAttentionState = {
  actionable: boolean;
  busy: boolean;
  canUpdate: boolean;
  dismissal: UpdateAttentionDismissal | null;
  forced: boolean;
  present: boolean;
  visible: boolean;
};

export function resolveSidebarUpdateAttention(
  context: SidebarUpdateContext,
  dismissed: SidebarAttentionDismissals,
): SidebarUpdateAttentionState {
  const snapshot = context.overlays.snapshot;
  const campaign = snapshot.updateSchedule?.campaign;
  const busy =
    snapshot.updateRunning ||
    snapshot.updateReconciliationPending ||
    campaign?.state === "applying";
  const canUpdate = canCallGatewayMethod(context.gateway.snapshot, "update.run", "operator.admin");
  const canHydrateCampaign = canCallGatewayMethod(
    context.gateway.snapshot,
    "update.status",
    "operator.admin",
  );
  const campaignPendingHydration =
    campaign && !snapshot.updateCampaignStatusHydrated && canHydrateCampaign;
  const present = snapshot.updateReconciliationPending
    ? true
    : campaignPendingHydration
      ? Boolean(snapshot.updateRunning || snapshot.updateStatusBanner)
      : Boolean(
          snapshot.updateRunning ||
          snapshot.updateStatusBanner ||
          snapshot.updateAvailable ||
          campaign,
        );
  const dismissal = resolveUpdateAttentionDismissal({
    gatewayBootId: context.gateway.snapshot.hello?.server?.bootId,
    updateAvailable: snapshot.updateAvailable,
    updateSchedule: snapshot.updateSchedule,
  });
  const forced =
    snapshot.updateRunning ||
    snapshot.updateReconciliationPending ||
    campaign?.state === "applying" ||
    isUpdateAttentionForced(snapshot.updateStatusBanner?.tone);
  return {
    actionable: isUpdateActionable(snapshot.updateAvailable, snapshot.updateSchedule, busy),
    busy,
    canUpdate,
    dismissal,
    forced,
    present,
    visible: present && (forced || !isUpdateAttentionDismissed(dismissed, dismissal)),
  };
}

export function dismissSidebarUpdateAttention(params: {
  context: SidebarUpdateContext;
  dismissedScope: string | null;
  state: SidebarUpdateAttentionState;
}): SidebarAttentionDismissals | null {
  if (
    !params.dismissedScope ||
    !params.state.dismissal ||
    params.state.forced ||
    !canCallGatewayMethod(params.context.gateway.snapshot, "update.run", "operator.admin")
  ) {
    return null;
  }
  return dismissUpdateAttention(params.dismissedScope, params.state.dismissal);
}

export function startSidebarUpdateAttention(params: {
  context: SidebarUpdateContext;
  nativeUpdateDeclined: boolean;
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
}) {
  const snapshot = params.context.overlays.snapshot;
  const campaign = snapshot.updateSchedule?.campaign;
  const busy =
    snapshot.updateRunning ||
    snapshot.updateReconciliationPending ||
    campaign?.state === "applying";
  if (
    busy ||
    !isUpdateActionable(snapshot.updateAvailable, snapshot.updateSchedule, busy) ||
    !canCallGatewayMethod(params.context.gateway.snapshot, "update.run", "operator.admin")
  ) {
    return;
  }
  void confirmAndStartUpdate({
    startGatewayUpdate: () => void params.context.overlays.runUpdate(),
    ...(params.watchUpdateProgress ? { watchUpdateProgress: params.watchUpdateProgress } : {}),
    updateAvailable: snapshot.updateAvailable,
    updateSchedule: snapshot.updateSchedule,
    viaNativeApp: !params.nativeUpdateDeclined && hasNativeUpdateBridge(),
  });
}
