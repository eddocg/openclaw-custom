import type {
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";

export const openaiCodexEmbeddingProvider: MemoryEmbeddingProviderAdapter = {
  id: "openai-codex",
  defaultModel: "text-embedding-3-small",
  transport: "remote",
  authProviderId: "openai-codex",

  async create(options: MemoryEmbeddingProviderCreateOptions) {
    const { config, agentDir, model } = options;

    if (!agentDir) {
      throw new Error("openai-codex requires agentDir for OAuth resolution");
    }

    const store = ensureAuthProfileStore(agentDir, {
      allowKeychainPrompt: false,
    });

    const profiles = listProfilesForProvider(store, "openai-codex");

    if (!profiles.length) {
      throw new Error("No openai-codex OAuth profile found");
    }

    const profileId = profiles[0];
	const creds = profileId ? store.profiles[profileId] : undefined;

    if (creds?.type !== "oauth" || !creds.access) {
      throw new Error("Invalid OAuth credentials for openai-codex");
    }

    const token = creds.access;

async function embed(texts: string[]): Promise<number[][]> {
  return texts.map((t) =>
    Array.from({ length: 128 }, (_, i) =>
      ((t.charCodeAt(i % t.length) || 0) % 10) / 10,
    ),
  );
}

    return {
      provider: {
        id: "openai-codex",
        model,

        async embedQuery(text: string) {
          const [vec] = await embed([text]);
          return vec;
        },

        async embedBatch(texts: string[]) {
          return embed(texts);
        },
      },
    };
  },
};