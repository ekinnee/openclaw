import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../plugins/public-surface-loader.js";
import { createPluginStateError } from "./plugin-state-error.js";
import type {
  PluginStateNativeBindingPlan,
  PluginStateNativeBindingRecord,
} from "./plugin-state-native-binding.types.js";

type NativeBindingArtifact = {
  nativeSessionBindingNamespace?: string;
  readNativeSessionBindingRecord: (value: unknown) => PluginStateNativeBindingRecord | undefined;
};

type CodecPlan = Pick<PluginStateNativeBindingPlan, "codec" | "codecSource">;
const codecs = new Map<string, NativeBindingArtifact>();
// Immutable host ABI: newer plugin metadata must not opt saved V1 rows out of this fence.
const CODEX_BINDING_NAMESPACE_V1 = "app-server-thread-bindings";

function codecKey({ codec, codecSource }: CodecPlan): string {
  return [codec, codecSource?.origin, codecSource?.rootDir, codecSource?.source].join("\0");
}

/** Load the plugin's canonical codec before the executor takes either database write lock. */
export function preparePluginStateNativeBindingCodecSync(
  plan: CodecPlan,
  env?: NodeJS.ProcessEnv,
): void {
  const key = codecKey(plan);
  if (codecs.has(key)) {
    return;
  }
  const artifact = loadBundledPluginPublicArtifactModuleFromCandidatesSync<NativeBindingArtifact>({
    dirName: plan.codec,
    artifactCandidates: ["native-session-binding-api.js"],
    env,
    ...(plan.codecSource ? { owner: { id: plan.codec, ...plan.codecSource } } : {}),
  });
  if (typeof artifact?.readNativeSessionBindingRecord !== "function") {
    throw new Error(`Native session binding codec is unavailable: ${plan.codec}`);
  }
  codecs.set(key, artifact);
}

export function readPreparedPluginStateNativeBinding(
  plan: CodecPlan,
  value: unknown,
): PluginStateNativeBindingRecord | undefined {
  const artifact = codecs.get(codecKey(plan));
  if (!artifact) {
    throw new Error(`Native session binding codec was not prepared: ${plan.codec}`);
  }
  return artifact.readNativeSessionBindingRecord(value);
}

/** Async native executors and synchronous SDK writers share the same prepared codec. */
export async function preparePluginStateNativeBindingCodec(
  plan: CodecPlan,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  preparePluginStateNativeBindingCodecSync(plan, env);
  preparePluginStateNativeBindingMutation(
    { pluginId: plan.codec, namespace: CODEX_BINDING_NAMESPACE_V1 },
    env,
  );
}

type MutationScope = { pluginId: string; namespace: string };

/** Resolve plugin code before database acquisition; mutation assertions never load code under locks. */
export function preparePluginStateNativeBindingMutation(
  scope: MutationScope,
  env?: NodeJS.ProcessEnv,
): void {
  if (!isCodexBindingMutationScope(scope)) {
    return;
  }
  preparePluginStateNativeBindingCodecSync({ codec: "codex" }, env);
  if (
    codecs.get(codecKey({ codec: "codex" }))?.nativeSessionBindingNamespace !==
    CODEX_BINDING_NAMESPACE_V1
  ) {
    throw new Error(
      "Unsupported native session binding namespace. Use a compatible OpenClaw build; the saved binding has been preserved.",
    );
  }
}

function isCodexBindingMutationScope(scope: MutationScope): boolean {
  return (
    scope.pluginId === "codex" &&
    (scope.namespace === CODEX_BINDING_NAMESPACE_V1 ||
      scope.namespace === `@retained.${CODEX_BINDING_NAMESPACE_V1}`)
  );
}

export function isPluginStateNativeBindingMutationScope(scope: MutationScope): boolean {
  if (!isCodexBindingMutationScope(scope)) {
    return false;
  }
  if (!codecs.has(codecKey({ codec: "codex" }))) {
    throw new Error("Native session binding mutation codec was not prepared: codex");
  }
  return true;
}

/** A newer plugin decoder cannot widen this host's immutable V1 mutation contract. */
export function assertPluginStateNativeBindingMutationValue(
  scope: MutationScope,
  valueJson: string,
): void {
  if (!isPluginStateNativeBindingMutationScope(scope)) {
    return;
  }
  const value: unknown = JSON.parse(valueJson);
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    readPreparedPluginStateNativeBinding({ codec: "codex" }, value)?.version !== 1
  ) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_WRITE_FAILED",
      operation: "register",
      message:
        "Unsupported native session binding. Use a compatible OpenClaw build; the saved binding has been preserved.",
    });
  }
}
