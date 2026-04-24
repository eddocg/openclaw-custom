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
  const results: number[][] = [];

  for (const text of texts) {
    const res = await fetch("http://127.0.0.1:18789/__openclaw__/capability", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capability: "model.run",
        input: {
          model: "openai-codex/gpt-5.4",
          messages: [
            {
              role: "system",
              content:
                "Convert the following text into a dense numeric embedding vector (array of floats). Only return JSON array.",
            },
            {
              role: "user",
              content: text,
            },
          ],
        },
      }),
    });

    const json = await res.json();

    const content = json?.output?.[0]?.content?.[0]?.text;

    try {
      const vector = JSON.parse(content);
      results.push(vector);
    } catch {
      throw new Error("Failed to parse embedding from model output");
    }
  }

  return results;
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