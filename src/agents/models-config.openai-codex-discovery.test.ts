import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelsListCommand } from "../commands/models/list.list-command.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import {
  CODEX_MODELS_URL_PREFIX,
  codexModelIds,
  type FetchCall,
  LISTED_IDS,
  LIVE_ROWS,
  readModelsJson,
  SIMULATED_ACCOUNT_ID,
  stubCodexModelsFetch,
  withCodexAgent,
  writeOpenAICodexProfile,
} from "./test-helpers/openai-codex-discovery-fixture.js";

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
