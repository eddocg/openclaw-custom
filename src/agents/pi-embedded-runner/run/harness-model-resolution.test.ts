import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../harness/registry.js";
import { installModelsConfigTestHooks } from "../../models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "../../models-config.js";
import {
  codexModelIds,
  LISTED_IDS,
  LIVE_ROWS,
  readModelsJson,
  stubCodexModelsFetch,
  withCodexAgent,
  writeOpenAICodexProfile,
} from "../../test-helpers/openai-codex-discovery-fixture.js";
import { resolveEmbeddedRunHarnessAndModel } from "./harness-model-resolution.js";

// Agent-runtime model resolution after account-scoped openai-codex discovery:
// real harness selection, real discovery-generated models.json and the real
// resolver, through the helper the embedded runner calls. Only fetch is
// simulated, and the Codex app-server harness is a registration stub.

vi.mock("../../auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: () => [],
  syncExternalCliCredentials: () => false,
}));

installModelsConfigTestHooks({ restoreFetch: true });

// Unscoped models.json generation loads every bundled provider plugin.
const GENERATION_TIMEOUT_MS = 180_000;
const LUNA_REF = "openai-codex/gpt-6-luna";

// Same provider support as the codex plugin's app-server harness.
function registerCodexAppServerHarnessStub(): void {
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex agent harness",
      supports: (ctx) =>
        ctx.provider.trim().toLowerCase() === "codex"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "provider is not one of: codex" },
      runAttempt: vi.fn(async () => {
        throw new Error("model resolution tests never start an attempt");
      }),
    },
    { ownerPluginId: "codex" },
  );
}

// Allowlist entry for GPT-6 Luna, optionally with a model-scoped runtime pin.
function lunaAllowedConfig(runtimeId?: "pi" | "codex"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: { [LUNA_REF]: runtimeId ? { agentRuntime: { id: runtimeId } } : {} },
      },
    },
  };
}

function resolveForRun(params: { modelId: string; config: OpenClawConfig; agentDir: string }) {
  return resolveEmbeddedRunHarnessAndModel({
    provider: "openai-codex",
    modelId: params.modelId,
    config: params.config,
    agentDir: params.agentDir,
    agentId: "main",
    workspaceDir: path.dirname(params.agentDir),
  });
}

async function discoverIntoModelsJson(config: OpenClawConfig, agentDir: string): Promise<void> {
  await writeOpenAICodexProfile(agentDir);
  stubCodexModelsFetch(() => Response.json(LIVE_ROWS));
  // Normal unscoped generation, as agent runtime and `models list --refresh` run it.
  await ensureOpenClawModelsJson(config, agentDir);
  const provider = (await readModelsJson(agentDir)).providers?.["openai-codex"];
  expect(provider?.models?.map((model) => model.id)).toEqual(LISTED_IDS);
  expect(provider?.models?.find((model) => model.id === "gpt-6-luna")?.api).toBe(
    "openai-codex-responses",
  );
}

describe("embedded run model resolution for discovered openai-codex models", () => {
  beforeEach(() => {
    clearAgentHarnesses();
    registerCodexAppServerHarnessStub();
  });

  afterEach(() => {
    clearAgentHarnesses();
  });

  it(
    "routes an allowed but unpinned discovered model to the codex harness, which cannot resolve it",
    async () => {
      await withCodexAgent(async (agentDir) => {
        const config = lunaAllowedConfig();
        await discoverIntoModelsJson(config, agentDir);

        const resolved = await resolveForRun({ modelId: "gpt-6-luna", config, agentDir });

        // The live VM failure: models.json lists the model, the run cannot see it.
        expect(resolved.agentHarness.id).toBe("codex");
        expect(resolved.pluginHarnessOwnsTransport).toBe(true);
        expect(resolved.modelResolution.model).toBeUndefined();
        expect(resolved.modelResolution.error).toContain(`Unknown model: ${LUNA_REF}`);
        expect(resolved.modelResolution.error).toContain(
          `set agentRuntime.id "pi" on agents.defaults.models["${LUNA_REF}"]`,
        );
      });
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    "runs a discovered model through PI with a model-scoped agentRuntime pi",
    async () => {
      await withCodexAgent(async (agentDir) => {
        const config = lunaAllowedConfig("pi");
        await writeOpenAICodexProfile(agentDir);
        const calls = stubCodexModelsFetch(() => Response.json(LIVE_ROWS));

        // PI generates models.json through normal discovery, then reads it.
        const resolved = await resolveForRun({ modelId: "gpt-6-luna", config, agentDir });

        expect(calls.length).toBeGreaterThan(0);
        expect(codexModelIds(await readModelsJson(agentDir))).toEqual(LISTED_IDS);
        expect(resolved.agentHarness.id).toBe("pi");
        expect(resolved.pluginHarnessOwnsTransport).toBe(false);
        expect(resolved.modelResolution.error).toBeUndefined();
        expect(resolved.modelResolution.model).toMatchObject({
          id: "gpt-6-luna",
          provider: "openai-codex",
          api: "openai-codex-responses",
        });
        expect(resolved.modelResolution.model?.baseUrl).toMatch(
          /^https:\/\/chatgpt\.com\/backend-api/u,
        );
      });
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    "keeps an explicit model-scoped agentRuntime codex pin on the codex harness",
    async () => {
      await withCodexAgent(async (agentDir) => {
        const config = lunaAllowedConfig("codex");
        await discoverIntoModelsJson(config, agentDir);

        const resolved = await resolveForRun({ modelId: "gpt-6-luna", config, agentDir });

        expect(resolved.agentHarness.id).toBe("codex");
        expect(resolved.modelResolution.model).toBeUndefined();
      });
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    "leaves unpinned openai-codex models on the codex harness when another model is pinned to PI",
    async () => {
      await withCodexAgent(async (agentDir) => {
        const config = lunaAllowedConfig("pi");
        await discoverIntoModelsJson(config, agentDir);

        const resolved = await resolveForRun({ modelId: "gpt-5.4", config, agentDir });

        expect(resolved.agentHarness.id).toBe("codex");
        expect(resolved.modelResolution.model).toMatchObject({
          id: "gpt-5.4",
          provider: "openai-codex",
        });
      });
    },
    GENERATION_TIMEOUT_MS,
  );
});
