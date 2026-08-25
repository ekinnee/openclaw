/** Reads auth policy only from provider runtimes that are already loaded. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderConfigApiOwnerHint } from "./provider-config-owner.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { ProviderPlugin } from "./types.js";

function findLoadedProviderPlugin(params: {
  registry: PluginRegistry;
  provider: string;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  return params.registry.providers.find(({ provider }) => {
    if (params.ownerRefs.length === 0) {
      return matchesProviderPluginRef(provider, params.provider);
    }
    return (
      normalizeProviderId(provider.id) === normalizeProviderId(params.provider) ||
      params.ownerRefs.some((ownerRef) => matchesProviderPluginRef(provider, ownerRef))
    );
  })?.provider;
}

/** Preserves runtime-declared retirement policy without importing or activating plugin runtime. */
export function resolveLoadedProviderDeprecatedAuthProfileIds(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): readonly string[] {
  const apiOwnerHint = resolveProviderConfigApiOwnerHint({
    provider: params.provider,
    config: params.config,
  });
  const ownerRefs = apiOwnerHint ? [apiOwnerHint] : [];
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedPlugin = scopedRegistry
    ? findLoadedProviderPlugin({
        registry: scopedRegistry,
        provider: params.provider,
        ownerRefs,
      })
    : undefined;
  if (scopedPlugin) {
    return scopedPlugin.deprecatedProfileIds ?? [];
  }

  const activeState = getPluginRegistryState();
  if (
    !activeState?.activeRegistry ||
    (params.workspaceDir !== undefined && activeState.workspaceDir !== params.workspaceDir)
  ) {
    return [];
  }
  return (
    findLoadedProviderPlugin({
      registry: activeState.activeRegistry,
      provider: params.provider,
      ownerRefs,
    })?.deprecatedProfileIds ?? []
  );
}
