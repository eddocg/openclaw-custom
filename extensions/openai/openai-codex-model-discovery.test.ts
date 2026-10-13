import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAICodexModelFromLiveRow,
  clearOpenAICodexModelDiscoveryCache,
  discoverOpenAICodexModels,
  OPENAI_CODEX_CLIENT_VERSION,
  readCodexModelRows,
  resolveOpenAICodexThinkingLevelMap,
  shouldIncludeCodexModelRow,
} from "./openai-codex-model-discovery.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { resolveOpenAICodexThinkingProfile } from "./thinking-policy.js";

// Placeholder values only; no real credential is read or written.
const FAKE_ACCESS = "fake-access-token-for-tests";
const FAKE_ACCOUNT_ID = "acct-fake-123";

const tempDirs: string[] = [];

async function createAgentDir(withCodexProfile = true): Promise<string> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-discovery-"));
  tempDirs.push(agentDir);
  if (withCodexProfile) {
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:test": {
            type: "oauth",
            provider: "openai-codex",
            access: FAKE_ACCESS,
            refresh: "fake-refresh-token",
            expires: Date.now() + 3_600_000,
            accountId: FAKE_ACCOUNT_ID,
          },
        },
      }),
    );
  }
  return agentDir;
}

function liveRows() {
  return {
    models: [
      {
        slug: "gpt-6-sol",
        display_name: "GPT-6 Sol",
        visibility: "list",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
        ],
        input_modalities: ["text", "image"],
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6 Luna",
        context_window: 400_000,
        supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max"],
      },
      { slug: "gpt-5.5", display_name: "GPT-5.5", supported_reasoning_levels: ["low", "high"] },
      { slug: "gpt-6-luna", visibility: "hide" },
      { slug: "gpt-6-astra", show_in_picker: false },
      { slug: "gpt-5.6" },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deps(fetchFn: typeof fetch) {
  return {
    fetchFn,
    resolveAccessToken: async () => ({ token: FAKE_ACCESS, profileId: "openai-codex:test" }),
  };
}

beforeEach(() => {
  clearOpenAICodexModelDiscoveryCache();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("codex model rows", () => {
  it("requires a { models: [] } body", () => {
    expect(() => readCodexModelRows({ data: [] })).toThrow(/models: \[\]/u);
    expect(readCodexModelRows({ models: [{ slug: "x" }] })).toHaveLength(1);
  });

  it("drops hidden and non-picker rows", () => {
    expect(shouldIncludeCodexModelRow({ slug: "a" })).toBe(true);
    expect(shouldIncludeCodexModelRow({ slug: "a", visibility: "list" })).toBe(true);
    expect(shouldIncludeCodexModelRow({ slug: "a", visibility: "hide" })).toBe(false);
    expect(shouldIncludeCodexModelRow({ slug: "a", show_in_picker: false })).toBe(false);
    expect(shouldIncludeCodexModelRow({ slug: "a", showInPicker: false })).toBe(false);
  });

  it("builds discovered GPT-6 rows on the fork's Codex transport with upstream metadata", () => {
    const model = buildOpenAICodexModelFromLiveRow(liveRows().models[0]);
    expect(model).toMatchObject({
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    });
  });

  it("applies the upstream gpt-5.6 Codex context limits and drops the none effort", () => {
    const model = buildOpenAICodexModelFromLiveRow(liveRows().models[1]);
    expect(model?.contextWindow).toBe(372_000);
    expect(model?.contextTokens).toBe(272_000);
    expect(model?.compat?.supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("skips the platform-only gpt-5.6 alias and keeps unknown rows at zero cost", () => {
    expect(buildOpenAICodexModelFromLiveRow({ slug: "gpt-5.6" })).toBeUndefined();
    expect(buildOpenAICodexModelFromLiveRow({ slug: "gpt-future" })).toMatchObject({
      id: "gpt-future",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("derives pi-ai thinking maps from advertised efforts without a max level", () => {
    expect(
      resolveOpenAICodexThinkingLevelMap({
        id: "gpt-6-sol",
        compat: { supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
      }),
    ).toEqual({ minimal: "low", xhigh: "xhigh" });
    expect(
      resolveOpenAICodexThinkingLevelMap({
        id: "gpt-5.6-terra",
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      }),
    ).toEqual({ off: null, minimal: "low" });
    expect(resolveOpenAICodexThinkingLevelMap({ id: "gpt-5.4" })).toBeUndefined();
  });

  it("offers xhigh for discovered gpt-5.6 and gpt-6 families", () => {
    for (const id of ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"]) {
      expect(resolveOpenAICodexThinkingProfile(id).levels.map((level) => level.id)).toContain(
        "xhigh",
      );
    }
  });
});

describe("discoverOpenAICodexModels", () => {
  it("lists only models the account returns, with account-scoped headers", async () => {
    const agentDir = await createAgentDir();
    const fetchFn = vi.fn(async () => jsonResponse(liveRows()));
    const result = await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn));

    expect(result.status).toBe("ready");
    const ids = result.status === "ready" ? result.models.map((model) => model.id) : [];
    expect(ids).toEqual(["gpt-6-sol", "gpt-5.6-luna", "gpt-5.5"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${OPENAI_CODEX_CLIENT_VERSION}`,
    );
    expect(init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${FAKE_ACCESS}`,
      "ChatGPT-Account-ID": FAKE_ACCOUNT_ID,
    });
  });

  it("caches successful discovery per account", async () => {
    const agentDir = await createAgentDir();
    const fetchFn = vi.fn(async () => jsonResponse(liveRows()));
    await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn));
    await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports auth-rejected for 401/403 without exposing the token", async () => {
    const agentDir = await createAgentDir();
    const result = await discoverOpenAICodexModels(
      { agentDir, env: {} },
      deps(vi.fn(async () => jsonResponse({ error: "forbidden" }, 403))),
    );
    expect(result).toEqual({ status: "auth-rejected" });
    expect(JSON.stringify(result)).not.toContain(FAKE_ACCESS);
  });

  it("treats other failures as advisory and does not pin them in the cache", async () => {
    const agentDir = await createAgentDir();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(liveRows()));
    expect(await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn))).toEqual({
      status: "unavailable",
    });
    expect(await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn))).toEqual({
      status: "unavailable",
    });
    expect((await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn))).status).toBe(
      "ready",
    );
  });

  it("skips without a Codex OAuth profile or in test environments without an injected fetch", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(liveRows()));
    const emptyDir = await createAgentDir(false);
    expect(await discoverOpenAICodexModels({ agentDir: emptyDir, env: {} }, deps(fetchFn))).toEqual(
      { status: "skipped" },
    );
    const agentDir = await createAgentDir();
    expect(await discoverOpenAICodexModels({ agentDir, env: { VITEST: "true" } })).toEqual({
      status: "skipped",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("openai-codex provider with account discovery", () => {
  function catalogContext(agentDir: string) {
    return {
      config: {},
      agentDir,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "oauth" as const,
        source: "profile" as const,
      }),
    };
  }

  it("writes discovered models into the openai-codex provider catalog", async () => {
    const agentDir = await createAgentDir();
    const provider = buildOpenAICodexProviderPlugin(
      deps(vi.fn(async () => jsonResponse(liveRows()))),
    );
    const result = (await provider.catalog?.run(catalogContext(agentDir) as never)) as {
      provider: { api: string; models: Array<{ id: string }> };
    };
    expect(result.provider.api).toBe("openai-codex-responses");
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("keeps the previous empty provider when discovery is unavailable", async () => {
    const agentDir = await createAgentDir();
    const provider = buildOpenAICodexProviderPlugin(deps(vi.fn(async () => jsonResponse({}, 502))));
    const result = (await provider.catalog?.run(catalogContext(agentDir) as never)) as {
      provider: { models: unknown[] };
    };
    expect(result.provider.models).toEqual([]);
  });

  it("does not synthesize Pro rows the account does not list", async () => {
    const agentDir = await createAgentDir();
    const provider = buildOpenAICodexProviderPlugin(
      deps(vi.fn(async () => jsonResponse(liveRows()))),
    );
    const entries = [
      {
        provider: "openai-codex",
        id: "gpt-5.4",
        name: "gpt-5.4",
        reasoning: true,
        input: ["text", "image"] as Array<"text" | "image">,
        contextWindow: 272_000,
      },
    ];
    const augmented = await provider.augmentModelCatalog?.({ agentDir, env: {}, entries });
    expect(augmented).toEqual([]);
  });

  it("advertises no synthetic rows when the account is rejected", async () => {
    const agentDir = await createAgentDir();
    const provider = buildOpenAICodexProviderPlugin(deps(vi.fn(async () => jsonResponse({}, 401))));
    const augmented = await provider.augmentModelCatalog?.({ agentDir, env: {}, entries: [] });
    expect(augmented).toEqual([]);
  });

  it("applies discovered effort maps when resolving a discovered model", () => {
    const provider = buildOpenAICodexProviderPlugin();
    const discovered = buildOpenAICodexModelFromLiveRow(liveRows().models[0]);
    const resolved = provider.normalizeResolvedModel?.({
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      model: { ...discovered, provider: "openai-codex" } as never,
    }) as { thinkingLevelMap?: Record<string, unknown>; api?: string } | undefined;
    expect(resolved?.api).toBe("openai-codex-responses");
    expect(resolved?.thinkingLevelMap).toEqual({ off: null, minimal: "low", xhigh: "xhigh" });
  });
});
