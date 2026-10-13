import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAICodexModelFromLiveRow,
  clearOpenAICodexModelDiscoveryCache,
  discoverOpenAICodexModels,
  formatOpenAICodexModelDiscoveryOutcome,
  OPENAI_CODEX_CLIENT_VERSION,
  readCodexModelRows,
  resolveOpenAICodexThinkingLevelMap,
  shouldIncludeCodexModelRow,
  type OpenAICodexModelDiscoveryResult,
} from "./openai-codex-model-discovery.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { resolveOpenAICodexThinkingProfile } from "./thinking-policy.js";

// Placeholder values only; no real credential is read or written.
const FAKE_ACCESS = "fake-access-token-for-tests";
const FAKE_ACCOUNT_ID = "acct-fake-123";

const tempDirs: string[] = [];

// Unsigned simulated access token carrying only the ChatGPT account claim.
function fakeJwtAccess(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none" }),
    encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    "sig",
  ].join(".");
}

async function createAgentDir(
  withCodexProfile = true,
  options: { accountId?: string } = { accountId: FAKE_ACCOUNT_ID },
): Promise<string> {
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
            ...(options.accountId ? { accountId: options.accountId } : {}),
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

function deps(fetchFn: typeof fetch, token = FAKE_ACCESS) {
  return {
    fetchFn,
    resolveAccessToken: async () => ({ token, profileId: "openai-codex:test" }),
  };
}

function networkError(code: string, name = "TypeError"): Error {
  const error = new Error(`fetch failed for https://chatgpt.com Bearer ${FAKE_ACCESS}`);
  error.name = name;
  (error as Error & { cause?: unknown }).cause = { code };
  return error;
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

    expect(result).toMatchObject({ status: "ready", rowCount: 6, accountIdSource: "profile" });
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
    expect(result).toEqual({
      status: "auth-rejected",
      httpStatus: 403,
      accountIdSource: "profile",
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_ACCESS);
  });

  it("falls back to the access-token account claim when the profile has no accountId", async () => {
    const agentDir = await createAgentDir(true, {});
    const token = fakeJwtAccess("acct-from-token");
    const fetchFn = vi.fn(async () => jsonResponse(liveRows()));
    const result = await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn, token));

    expect(result).toMatchObject({ status: "ready", accountIdSource: "token" });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["ChatGPT-Account-ID"]).toBe("acct-from-token");
  });

  it("sends no account header and reports it when no account id can be resolved", async () => {
    const agentDir = await createAgentDir(true, {});
    const fetchFn = vi.fn(async () => jsonResponse({}, 401));
    const result = await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn));

    expect(result).toEqual({
      status: "auth-rejected",
      httpStatus: 401,
      accountIdSource: "missing",
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("ChatGPT-Account-ID");
  });

  it.each([
    [429, "http_rate_limited"],
    [503, "http_server_error"],
    [404, "http_error"],
  ] as const)("classifies HTTP %i as %s", async (status, reason) => {
    const agentDir = await createAgentDir();
    const result = await discoverOpenAICodexModels(
      { agentDir, env: {} },
      deps(vi.fn(async () => jsonResponse({}, status))),
    );
    expect(result).toEqual({
      status: "unavailable",
      reason,
      httpStatus: status,
      accountIdSource: "profile",
    });
  });

  it.each([
    ["timeout", networkError("UND_ERR_CONNECT_TIMEOUT"), "UND_ERR_CONNECT_TIMEOUT"],
    ["timeout", Object.assign(new Error("aborted"), { name: "TimeoutError" }), undefined],
    ["tls", networkError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["network", networkError("ECONNREFUSED"), "ECONNREFUSED"],
    ["network", new Error("socket hang up"), undefined],
  ] as const)("classifies transport failures as %s", async (reason, error, errorCode) => {
    const agentDir = await createAgentDir();
    const result = await discoverOpenAICodexModels(
      { agentDir, env: {} },
      deps(vi.fn<typeof fetch>().mockRejectedValue(error)),
    );
    expect(result).toEqual({
      status: "unavailable",
      reason,
      ...(errorCode ? { errorCode } : {}),
      accountIdSource: "profile",
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_ACCESS);
  });

  it("classifies non-JSON and wrongly shaped bodies as invalid_response", async () => {
    const agentDir = await createAgentDir();
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await discoverOpenAICodexModels({ agentDir, env: {} }, deps(notJson))).toMatchObject({
      status: "unavailable",
      reason: "invalid_response",
    });
    const wrongShape = vi.fn(async () => jsonResponse({ data: [] }));
    expect(await discoverOpenAICodexModels({ agentDir, env: {} }, deps(wrongShape))).toMatchObject({
      status: "unavailable",
      reason: "invalid_response",
    });
  });

  it("reports ready with zero eligible models when the account lists none", async () => {
    const agentDir = await createAgentDir();
    const result = await discoverOpenAICodexModels(
      { agentDir, env: {} },
      deps(
        vi.fn(async () => jsonResponse({ models: [{ slug: "gpt-6-luna", visibility: "hide" }] })),
      ),
    );
    expect(result).toEqual({
      status: "ready",
      models: [],
      rowCount: 1,
      accountIdSource: "profile",
    });
    expect(formatOpenAICodexModelDiscoveryOutcome(result)).toContain("0 eligible models");
  });

  it("separates token resolution failures from missing tokens", async () => {
    const agentDir = await createAgentDir();
    const fetchFn = vi.fn(async () => jsonResponse(liveRows()));
    expect(
      await discoverOpenAICodexModels(
        { agentDir, env: {} },
        {
          fetchFn,
          resolveAccessToken: async () => {
            throw new Error(`refresh failed for ${FAKE_ACCESS}`);
          },
        },
      ),
    ).toEqual({ status: "unavailable", reason: "token_resolution_failed" });
    expect(
      await discoverOpenAICodexModels(
        { agentDir, env: {} },
        { fetchFn, resolveAccessToken: async () => undefined },
      ),
    ).toEqual({ status: "unavailable", reason: "token_unavailable" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("formats outcomes without tokens, account ids or profile ids", () => {
    const outcomes: OpenAICodexModelDiscoveryResult[] = [
      { status: "ready", models: [], rowCount: 0, accountIdSource: "token" },
      { status: "auth-rejected", httpStatus: 401, accountIdSource: "missing" },
      {
        status: "unavailable",
        reason: "tls",
        errorCode: "CERT_HAS_EXPIRED",
        accountIdSource: "profile",
      },
      { status: "skipped", reason: "no_profiles" },
    ];
    const text = outcomes.map((outcome) => formatOpenAICodexModelDiscoveryOutcome(outcome));
    expect(text[1]).toContain("auth-rejected (http=401, accountId=missing)");
    expect(text[2]).toBe(
      "unavailable (reason=tls, code=CERT_HAS_EXPIRED, accountId=profile); not live discovery, previously written and built-in models are kept",
    );
    for (const line of text) {
      expect(line).not.toContain(FAKE_ACCESS);
      expect(line).not.toContain(FAKE_ACCOUNT_ID);
      expect(line).not.toContain("openai-codex:test");
    }
  });

  it("treats other failures as advisory and does not pin them in the cache", async () => {
    const agentDir = await createAgentDir();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(liveRows()));
    expect(await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn))).toMatchObject({
      status: "unavailable",
      reason: "http_server_error",
      httpStatus: 500,
    });
    expect(await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn))).toMatchObject({
      status: "unavailable",
      reason: "network",
    });
    expect((await discoverOpenAICodexModels({ agentDir, env: {} }, deps(fetchFn))).status).toBe(
      "ready",
    );
  });

  it("skips without a Codex OAuth profile or in test environments without an injected fetch", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(liveRows()));
    const emptyDir = await createAgentDir(false);
    expect(await discoverOpenAICodexModels({ agentDir: emptyDir, env: {} }, deps(fetchFn))).toEqual(
      { status: "skipped", reason: "no_profiles" },
    );
    const agentDir = await createAgentDir();
    expect(await discoverOpenAICodexModels({ agentDir, env: { VITEST: "true" } })).toEqual({
      status: "skipped",
      reason: "test_environment",
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

  it("returns no entry when discovery is unavailable so merge keeps the last rows", async () => {
    const agentDir = await createAgentDir();
    const provider = buildOpenAICodexProviderPlugin(deps(vi.fn(async () => jsonResponse({}, 502))));
    expect(await provider.catalog?.run(catalogContext(agentDir) as never)).toBeNull();
  });

  it("clears discovered rows when the account is rejected", async () => {
    const agentDir = await createAgentDir();
    const provider = buildOpenAICodexProviderPlugin(deps(vi.fn(async () => jsonResponse({}, 403))));
    const result = (await provider.catalog?.run(catalogContext(agentDir) as never)) as {
      provider: { api: string; models: unknown[] };
    };
    expect(result.provider.api).toBe("openai-codex-responses");
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
