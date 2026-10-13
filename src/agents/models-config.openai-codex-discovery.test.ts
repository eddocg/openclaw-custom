import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelsListCommand } from "../commands/models/list.list-command.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withModelsTempHome as withTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

// Real-wiring coverage for account-scoped openai-codex discovery: real plugin
// loading, real auth-profile resolution, real models.json planning and the
// real `models list` command. Only the network (globalThis.fetch) is simulated.

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: () => [],
  syncExternalCliCredentials: () => false,
}));

installModelsConfigTestHooks({ restoreFetch: true });

// Unscoped discovery and `models list` load every bundled provider plugin.
const UNSCOPED_TIMEOUT_MS = 180_000;
const LIST_TIMEOUT_MS = 420_000;
const SIMULATED_ACCOUNT_ID = "acct-simulated-0001";
const CODEX_MODELS_URL_PREFIX = "https://chatgpt.com/backend-api/codex/models";

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Unsigned, simulated ChatGPT access token; never a real credential. The nonce
// keeps discovery's in-process cache from carrying results across tests.
function simulatedAccessToken(): string {
  return [
    base64Url({ alg: "none", typ: "JWT" }),
    base64Url({
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: randomUUID(),
      "https://api.openai.com/auth": { chatgpt_account_id: SIMULATED_ACCOUNT_ID },
    }),
    "simulated-signature",
  ].join(".");
}

// Mirrors a ChatGPT sign-in profile written before account ids were stored:
// no `accountId`, so discovery must use the access-token claim.
async function writeOpenAICodexProfile(agentDir: string): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: simulatedAccessToken(),
          refresh: "simulated-refresh",
          expires: Date.now() + 3_600_000,
        },
      },
    }),
  );
}

const LIVE_ROWS = {
  models: [
    { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
    { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
    { slug: "gpt-5.6-terra", visibility: "list", supported_reasoning_levels: ["low", "high"] },
    { slug: "gpt-5.4", visibility: "list" },
    { slug: "gpt-6-astra", visibility: "hide" },
    { slug: "gpt-6.1-sol", show_in_picker: false },
  ],
};
const LISTED_IDS = ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.4"];

type FetchCall = { url: string; headers: Headers };

function stubCodexModelsFetch(response: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(CODEX_MODELS_URL_PREFIX)) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    calls.push({ url, headers: new Headers(init?.headers) });
    return response();
  }) as typeof fetch;
  return calls;
}

type ModelsJson = {
  providers?: Record<
    string,
    { api?: string; baseUrl?: string; models?: Array<{ id: string; api?: string }> }
  >;
};

async function readModelsJson(agentDir: string): Promise<ModelsJson> {
  try {
    return JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
  } catch {
    return {};
  }
}

function codexModelIds(parsed: ModelsJson): string[] | undefined {
  return parsed.providers?.["openai-codex"]?.models?.map((model) => model.id);
}

async function withCodexAgent(fn: (agentDir: string) => Promise<void>): Promise<void> {
  await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
    await withTempHome(async () => {
      // Discovery skips itself under VITEST unless fetch is injected; unset it
      // so the production resolver path (globalThis.fetch) runs.
      unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
      await fn(resolveDefaultAgentDir({}));
    });
  });
}

function expectAccountScopedRequest(calls: FetchCall[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).toBe(`${CODEX_MODELS_URL_PREFIX}?client_version=0.160.0`);
    expect(call.headers.get("chatgpt-account-id")).toBe(SIMULATED_ACCOUNT_ID);
    expect(call.headers.get("authorization")).toMatch(/^Bearer /u);
  }
}

function createCapturingRuntime(): RuntimeEnv & { output: () => string } {
  const lines: string[] = [];
  return {
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    exit: () => {},
    output: () => lines.join("\n"),
  };
}

async function listCodexModelKeys(opts: { all?: boolean; refresh?: boolean }): Promise<string[]> {
  const runtime = createCapturingRuntime();
  await modelsListCommand({ ...opts, provider: "openai-codex", json: true }, runtime);
  const parsed = JSON.parse(runtime.output()) as { models: Array<{ key: string }> };
  return parsed.models.map((row) => row.key);
}

function expectListedCodexKeys(keys: string[]) {
  for (const id of LISTED_IDS) {
    expect(keys).toContain(`openai-codex/${id}`);
  }
  expect(keys).not.toContain("openai-codex/gpt-6-astra");
  expect(keys).not.toContain("openai-codex/gpt-6.1-sol");
}

describe("openai-codex live discovery through models.json", () => {
  beforeEach(() => {
    unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
  });

  it(
    "writes account-scoped rows during unscoped generation (normal runtime path)",
    async () => {
      await withCodexAgent(async (agentDir) => {
        await writeOpenAICodexProfile(agentDir);
        const calls = stubCodexModelsFetch(() => Response.json(LIVE_ROWS));

        await ensureOpenClawModelsJson({}, agentDir);

        expectAccountScopedRequest(calls);
        const provider = (await readModelsJson(agentDir)).providers?.["openai-codex"];
        expect(provider?.api).toBe("openai-codex-responses");
        expect(provider?.models?.map((model) => model.id)).toEqual(LISTED_IDS);
        for (const model of provider?.models ?? []) {
          expect(model.api).toBe("openai-codex-responses");
        }
      });
    },
    UNSCOPED_TIMEOUT_MS,
  );

  it("writes the same rows when generation is scoped to openai-codex", async () => {
    await withCodexAgent(async (agentDir) => {
      await writeOpenAICodexProfile(agentDir);
      const calls = stubCodexModelsFetch(() => Response.json(LIVE_ROWS));

      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      expectAccountScopedRequest(calls);
      expect(codexModelIds(await readModelsJson(agentDir))).toEqual(LISTED_IDS);
    });
  });

  it("keeps previously discovered rows when discovery is unavailable", async () => {
    await withCodexAgent(async (agentDir) => {
      await writeOpenAICodexProfile(agentDir);
      stubCodexModelsFetch(() => Response.json(LIVE_ROWS));
      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      // New profile mtime and token: forces a fresh plan and a fresh fetch.
      await writeOpenAICodexProfile(agentDir);
      const calls = stubCodexModelsFetch(() => new Response("unavailable", { status: 503 }));
      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      expect(calls).toHaveLength(1);
      expect(codexModelIds(await readModelsJson(agentDir))).toEqual(LISTED_IDS);
    });
  });

  it("never invents account rows when the first discovery fails", async () => {
    await withCodexAgent(async (agentDir) => {
      await writeOpenAICodexProfile(agentDir);
      stubCodexModelsFetch(() => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      });

      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      expect(codexModelIds(await readModelsJson(agentDir)) ?? []).toEqual([]);
    });
  });

  it("clears discovered rows when the account is rejected", async () => {
    await withCodexAgent(async (agentDir) => {
      await writeOpenAICodexProfile(agentDir);
      stubCodexModelsFetch(() => Response.json(LIVE_ROWS));
      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      await writeOpenAICodexProfile(agentDir);
      stubCodexModelsFetch(() => new Response("unauthorized", { status: 401 }));
      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      expect(codexModelIds(await readModelsJson(agentDir))).toEqual([]);
    });
  });

  it("does not call discovery without an openai-codex profile", async () => {
    await withCodexAgent(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const calls = stubCodexModelsFetch(() => Response.json(LIVE_ROWS));

      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai-codex"],
      });

      expect(calls).toHaveLength(0);
      expect(codexModelIds(await readModelsJson(agentDir))).toBeUndefined();
    });
  });

  // Runs the real `models list` command (provider runtime normalization for
  // every bundled plugin), so it is the slowest case in this file.
  it(
    "shows discovered rows in `models list --provider --refresh` and `--all`",
    async () => {
      await withCodexAgent(async (agentDir) => {
        await writeOpenAICodexProfile(agentDir);
        const calls = stubCodexModelsFetch(() => Response.json(LIVE_ROWS));

        // Listing never regenerates models.json on its own; --refresh does.
        const listed = await listCodexModelKeys({ refresh: true });
        expectAccountScopedRequest(calls);
        expect(codexModelIds(await readModelsJson(agentDir))).toEqual(LISTED_IDS);
        expectListedCodexKeys(listed);
        expectListedCodexKeys(await listCodexModelKeys({ all: true }));
      });
    },
    LIST_TIMEOUT_MS,
  );
});
