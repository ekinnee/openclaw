import path from "node:path";
// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  resolveDirectBundledProviderPolicySurface,
  resolveTrustedExternalProviderPolicySurface,
  type BundledProviderPolicySurface,
  type ProviderPolicySurface,
} from "./provider-policy-surface.js";

const deprecatedAuthProfileIdsByProvider = new Map<string, readonly string[]>();

registerPluginMetadataProcessMemoLifecycleClear(() => {
  deprecatedAuthProfileIdsByProvider.clear();
});

function resolveBundledProviderPolicyPlugin(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): PluginManifestRegistry["plugins"][number] | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }

  const registry = options.manifestRegistry ?? loadPluginManifestRegistryCore();
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (pluginOwnsProviderPolicyRef(plugin, normalizedProviderId)) {
      return plugin;
    }
  }

  return null;
}

function pluginOwnsProviderPolicyRef(
  plugin: PluginManifestRegistry["plugins"][number],
  normalizedProviderId: string,
): boolean {
  const ownedProviders = new Set(
    [...plugin.providers, ...plugin.cliBackends, ...(plugin.contracts?.embeddingProviders ?? [])]
      .map((provider) => normalizeProviderId(provider))
      .filter(Boolean),
  );
  if (ownedProviders.has(normalizedProviderId)) {
    return true;
  }

  for (const [rawAlias, rawTarget] of Object.entries(plugin.providerAuthAliases ?? {})) {
    const alias = normalizeProviderId(rawAlias);
    const target = normalizeProviderId(rawTarget);
    if (alias === normalizedProviderId && ownedProviders.has(target)) {
      return true;
    }
  }

  return false;
}

function bundledManifestOwnsProviderPolicyRef(
  manifest: Record<string, unknown>,
  normalizedProviderId: string,
): boolean {
  const contracts = isRecord(manifest.contracts) ? manifest.contracts : undefined;
  const ownedProviders = new Set(
    normalizeTrimmedStringList([
      ...normalizeTrimmedStringList(manifest.providers),
      ...normalizeTrimmedStringList(manifest.cliBackends),
      ...normalizeTrimmedStringList(contracts?.embeddingProviders),
    ])
      .map((provider) => normalizeProviderId(provider))
      .filter(Boolean),
  );
  if (ownedProviders.has(normalizedProviderId)) {
    return true;
  }

  const aliases = isRecord(manifest.providerAuthAliases) ? manifest.providerAuthAliases : {};
  return Object.entries(aliases).some(([rawAlias, rawTarget]) => {
    const alias = normalizeProviderId(rawAlias);
    const target = typeof rawTarget === "string" ? normalizeProviderId(rawTarget) : undefined;
    return alias === normalizedProviderId && Boolean(target && ownedProviders.has(target));
  });
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const directSurface = resolveDirectBundledProviderPolicySurface(normalizedProviderId);
  if (directSurface) {
    return directSurface;
  }
  const ownerPlugin = resolveBundledProviderPolicyPlugin(normalizedProviderId, options);
  if (ownerPlugin) {
    const ownerSurface = resolveDirectBundledProviderPolicySurface(ownerPlugin.id);
    if (ownerSurface) {
      return ownerSurface;
    }
  }
  if (!ownerPlugin) {
    return null;
  }
  // A stable plugin id can differ from its stock directory name. Use the
  // registry-owned root basename so its pre-runtime policy stays discoverable.
  return resolveDirectBundledProviderPolicySurface(path.basename(ownerPlugin.rootDir));
}

/** Resolves provider policy hooks from bundled or trusted official plugin artifacts. */
export function resolveProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): ProviderPolicySurface | null {
  const bundledSurface = resolveBundledProviderPolicySurface(providerId, options);
  if (bundledSurface) {
    return bundledSurface;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId || !options.manifestRegistry) {
    return null;
  }
  for (const plugin of options.manifestRegistry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (
      pluginOwnsProviderPolicyRef(plugin, normalizedProviderId) &&
      plugin.trustedOfficialInstall === true
    ) {
      const surface = resolveTrustedExternalProviderPolicySurface({
        pluginId: plugin.id,
        pluginRoot: plugin.rootDir,
        trustedOfficialInstall: plugin.trustedOfficialInstall,
      });
      if (surface) {
        return surface;
      }
    }
  }
  return null;
}

/** Resolves static auth-profile retirement policy without activating provider runtime. */
export function resolveProviderDeprecatedAuthProfileIds(providerId: string): readonly string[] {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return [];
  }
  const cacheKey = `${resolveBundledPluginsDir() ?? ""}\0${normalizedProviderId}`;
  const cached = deprecatedAuthProfileIdsByProvider.get(cacheKey);
  if (cached) {
    return cached;
  }
  const ownerManifest = listOpenClawPluginManifestMetadata().find(
    ({ manifest, origin }) =>
      origin === "bundled" && bundledManifestOwnsProviderPolicyRef(manifest, normalizedProviderId),
  )?.manifest;
  const profileIds = normalizeTrimmedStringList(ownerManifest?.deprecatedAuthProfileIds);
  deprecatedAuthProfileIdsByProvider.set(cacheKey, profileIds);
  return profileIds;
}
