import type {
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
} from "./memory-embedding-providers.js";

export const openaiCodexEmbeddingProvider: MemoryEmbeddingProviderAdapter = {
  id: "openai-codex",

  defaultModel: "text-embedding-3-small",

  transport: "remote",

  authProviderId: "openai-codex",

  async create(options: MemoryEmbeddingProviderCreateOptions) {
    const provider = {
      id: "openai-codex",
      model: options.model,

      async embedQuery(_text: string) {
        throw new Error("openai-codex embeddings not implemented yet");
      },

      async embedBatch(_texts: string[]) {
        throw new Error("openai-codex embeddings not implemented yet");
      },
    };

    return {
      provider,
    };
  },
};