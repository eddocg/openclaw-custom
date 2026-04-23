import type {
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

import { resolveRemoteAuth } from "openclaw/plugin-sdk/provider-env-vars";

export const openaiCodexEmbeddingProvider: MemoryEmbeddingProviderAdapter = {
  id: "openai-codex",

  defaultModel: "text-embedding-3-small",

  transport: "remote",

  authProviderId: "openai-codex",

  async create(options: MemoryEmbeddingProviderCreateOptions) {
    const { config, model } = options;

    const auth = await resolveRemoteAuth({
      providerId: "openai-codex",
      config,
    });

    const baseUrl = auth.baseUrl ?? "https://api.openai.com/v1";

    async function embed(texts: string[]): Promise<number[][]> {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.apiKey}`,
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