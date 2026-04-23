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

    const creds = profiles[0]?.credentials;

    if (!creds?.accessToken) {
      throw new Error("Invalid OAuth credentials for openai-codex");
    }

    const token = creds.accessToken;

    async function embed(texts: string[]): Promise<number[][]> {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`openai-codex embeddings failed: ${err}`);
      }

      const json = await res.json();

      return json.data.map((d: any) => d.embedding);
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