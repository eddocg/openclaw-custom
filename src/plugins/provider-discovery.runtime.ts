import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import { resolveDiscoveredProviderPluginIds } from "./providers.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import { createPluginSourceLoader } from "./source-loader.js";
import type { ProviderPlugin } from "./types.js";

type ProviderDiscoveryModule =
  | ProviderPlugin
  | ProviderPlugin[]
  | {
      default?: ProviderPlugin | ProviderPlugin[];
      providers?: ProviderPlugin[];
      provider?: ProviderPlugin;
    };

type ProviderDiscoveryEntryResult = {
  providers: ProviderPlugin[];
  complete: boolean;
  pluginRecords: PluginManifestRecord[];
  entryPluginIds: Set<string>;
};

function normalizeDiscoveryModule(value: ProviderDiscoveryModule): ProviderPlugin[] {
  const resolved =
    value && typeof value === "object" && "default" in value && value.default !== undefined
      ? value.default
      : value;
  if (Array.isArray(resolved)) {
    return resolved;
  }
  if (resolved && typeof resolved === "object" && "id" in resolved) {
    return [resolved];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { providers?: ProviderPlugin[]; provider?: ProviderPlugin };
    if (Array.isArray(record.providers)) {
      return record.providers;
    }
    if (record.provider) {
      return [record.provider];
    }
  }
  return [];
}

function hasLiveProviderDiscoveryHook(provider: ProviderPlugin): boolean {
  return (
    typeof provider.catalog?.run === "function" || typeof provider.discovery?.run === "function"
  );
}

function hasProviderAuthEnvCredential(
  plugin: PluginManifestRecord,
  env: NodeJS.ProcessEnv,
): boolean {
  return Object.values(plugin.providerAuthEnvVars ?? {}).some((envVars) =>
    envVars.some((name) => {
      const value = env[name]?.trim();
      return value !== undefined && value !== "";
    }),
  );
}

function hasCredentialedProvider(
  plugin: PluginManifestRecord,
  credentialedProviderIds: ReadonlySet<string>,
): boolean {
  return plugin.providers.some((providerId) =>
    credentialedProviderIds.has(normalizeProviderId(providerId)),
  );
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function resolveProviderDiscoveryEntryPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderDiscoveryEntryResult {
  const metadataSnapshot =
    params.pluginMetadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.config ?? {},
      env: params.env ?? process.env,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  const registry = metadataSnapshot.index;
  const manifestRegistry = metadataSnapshot.manifestRegistry;
  const pluginIds = resolveDiscoveredProviderPluginIds({
    ...params,
    registry,
    manifestRegistry,
  });
  const pluginIdSet = new Set(pluginIds);
  const pluginRecords = manifestRegistry.plugins.filter((plugin) => pluginIdSet.has(plugin.id));
  const entryRecords = pluginRecords.filter((plugin) => plugin.providerDiscoverySource);
  const entryPluginIds = new Set(entryRecords.map((plugin) => plugin.id));
  if (entryRecords.length === 0) {
    return { providers: [], complete: false, pluginRecords, entryPluginIds };
  }
  const complete = entryRecords.length === pluginIdSet.size;
  if (params.requireCompleteDiscoveryEntryCoverage && !complete) {
    return { providers: [], complete: false, pluginRecords, entryPluginIds };
  }
  const loadSource = createPluginSourceLoader();
  const providers: ProviderPlugin[] = [];
  for (const manifest of entryRecords) {
    try {
      const moduleExport = loadSource(manifest.providerDiscoverySource!) as ProviderDiscoveryModule;
      providers.push(
        ...normalizeDiscoveryModule(moduleExport).map((provider) =>
          Object.assign({}, provider, { pluginId: manifest.id }),
        ),
      );
    } catch {
      // Discovery fast path is optional. Fall back to the full plugin loader
      // below so existing plugin diagnostics/load behavior remains canonical.
      return { providers: [], complete: false, pluginRecords, entryPluginIds };
    }
  }
  return { providers, complete, pluginRecords, entryPluginIds };
}

function resolveSelectiveFullPluginIds(params: {
  entryResult: ProviderDiscoveryEntryResult;
  entryProviders: ProviderPlugin[];
  env: NodeJS.ProcessEnv;
  credentialedProviderIds?: readonly string[];
}): string[] {
  const credentialedProviderIds = new Set(
    (params.credentialedProviderIds ?? []).map((providerId) => normalizeProviderId(providerId)),
  );
  const staticOnlyEntryPluginIds = params.entryProviders
    .filter((provider) => !hasLiveProviderDiscoveryHook(provider))
    .map((provider) => provider.pluginId)
    .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId !== "");
  const missingEntryCredentialPluginIds = params.entryResult.pluginRecords
    .filter((plugin) => !params.entryResult.entryPluginIds.has(plugin.id))
    // Credential-bounded: env auth, or a stored auth profile (OAuth-only
    // providers such as ChatGPT sign-in have no env var to detect).
    .filter(
      (plugin) =>
        hasProviderAuthEnvCredential(plugin, params.env) ||
        hasCredentialedProvider(plugin, credentialedProviderIds),
    )
    .map((plugin) => plugin.id);
  return dedupeSorted([...staticOnlyEntryPluginIds, ...missingEntryCredentialPluginIds]);
}

export function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
  credentialedProviderIds?: readonly string[];
}): ProviderPlugin[] {
  const { credentialedProviderIds, ...loadParams } = params;
  const env = params.env ?? process.env;
  const entryResult = resolveProviderDiscoveryEntryPlugins({ ...loadParams, env });
  if (params.discoveryEntriesOnly === true) {
    return entryResult.providers;
  }
  const liveEntryProviders = entryResult.providers.filter(hasLiveProviderDiscoveryHook);
  if (entryResult.complete && liveEntryProviders.length === entryResult.providers.length) {
    return liveEntryProviders;
  }
  if (params.onlyPluginIds === undefined && entryResult.providers.length > 0) {
    const fullPluginIds = resolveSelectiveFullPluginIds({
      entryResult,
      entryProviders: entryResult.providers,
      env,
      credentialedProviderIds,
    });
    const fullProviders =
      fullPluginIds.length > 0
        ? resolvePluginProviders({
            ...loadParams,
            env,
            onlyPluginIds: fullPluginIds,
            bundledProviderAllowlistCompat: true,
          })
        : [];
    return [...liveEntryProviders, ...fullProviders];
  }
  return resolvePluginProviders({
    ...loadParams,
    env,
    bundledProviderAllowlistCompat: true,
  });
}
