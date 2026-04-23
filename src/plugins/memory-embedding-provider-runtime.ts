import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";
import { registerBuiltInMemoryEmbeddingProviders } from "../../plugin-sdk/memory-core-bundled-runtime.js";
import { registerMemoryEmbeddingProvider } from "./memory-embedding-providers.js";

export { listRegisteredMemoryEmbeddingProviders };

export function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
export function listMemoryEmbeddingProviders(
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter[] {
  const registered = listRegisteredMemoryEmbeddingProviderAdapters();
  const merged = new Map(registered.map((adapter) => [adapter.id, adapter]));
  for (const adapter of resolvePluginCapabilityProviders({
    key: "memoryEmbeddingProviders",
    cfg,
  })) {
    if (!merged.has(adapter.id)) {
      merged.set(adapter.id, adapter);
    }
  }
  return [...merged.values()];
}

// Ensure builtin providers are registered (including extensions like memory-core)
let __memoryProvidersInitialized = false;

function ensureMemoryProvidersInitialized() {
  if (__memoryProvidersInitialized) return;
  __memoryProvidersInitialized = true;

  registerBuiltInMemoryEmbeddingProviders({
    registerMemoryEmbeddingProvider,
  });
}

export function getMemoryEmbeddingProvider(
  id: string,
  cfg?: OpenClawConfig,
): MemoryEmbeddingProviderAdapter | undefined {
  ensureMemoryProvidersInitialized();

  const registered = getRegisteredMemoryEmbeddingProvider(id);
  if (registered) {
    return registered.adapter;
  }
  return resolvePluginCapabilityProvider({
    key: "memoryEmbeddingProviders",
    providerId: id,
    cfg,
  });
}
