import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { resolveDefaultAgentDir } from "../agent-scope.js";
import {
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withModelsTempHome as withTempHome,
  withTempEnv,
} from "../models-config.e2e-harness.js";

// Shared fixture for account-scoped openai-codex discovery tests: a simulated
// ChatGPT sign-in profile and a simulated /backend-api/codex/models response.

export const SIMULATED_ACCOUNT_ID = "acct-simulated-0001";
export const CODEX_MODELS_URL_PREFIX = "https://chatgpt.com/backend-api/codex/models";

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
export async function writeOpenAICodexProfile(agentDir: string): Promise<void> {
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

export const LIVE_ROWS = {
  models: [
    { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
    { slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
    { slug: "gpt-5.6-terra", visibility: "list", supported_reasoning_levels: ["low", "high"] },
    { slug: "gpt-5.4", visibility: "list" },
    { slug: "gpt-6-astra", visibility: "hide" },
    { slug: "gpt-6.1-sol", show_in_picker: false },
  ],
};
export const LISTED_IDS = ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.4"];

export type FetchCall = { url: string; headers: Headers };

export function stubCodexModelsFetch(response: () => Response): FetchCall[] {
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

export type ModelsJson = {
  providers?: Record<
    string,
    { api?: string; baseUrl?: string; models?: Array<{ id: string; api?: string }> }
  >;
};

export async function readModelsJson(agentDir: string): Promise<ModelsJson> {
  try {
    return JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8"));
  } catch {
    return {};
  }
}

export function codexModelIds(parsed: ModelsJson): string[] | undefined {
  return parsed.providers?.["openai-codex"]?.models?.map((model) => model.id);
}

export async function withCodexAgent(fn: (agentDir: string) => Promise<void>): Promise<void> {
  await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
    await withTempHome(async () => {
      // Discovery skips itself under VITEST unless fetch is injected; unset it
      // so the production resolver path (globalThis.fetch) runs.
      unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
      await fn(resolveDefaultAgentDir({}));
    });
  });
}
