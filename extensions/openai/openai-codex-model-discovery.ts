import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureAuthProfileStoreForLocalUpdate,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  DEFAULT_CONTEXT_TOKENS,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";
import { resolveCodexAuthIdentity } from "./openai-codex-auth-identity.js";

// Account-scoped ChatGPT/Codex model discovery, ported from upstream openclaw
// (extensions/openai/codex-model-rows.ts + buildOpenAICodexModelFromLiveRow in
// openai-provider.ts, v2026.10.x). Upstream runs this on its unified `openai`
// provider with the `openai-chatgpt-responses` transport; this fork keeps the
// `openai-codex` provider and the `openai-codex-responses` transport.

const PROVIDER_ID = "openai-codex";
const log = createSubsystemLogger("openai-codex/model-discovery");

/**
 * The ChatGPT backend gates model rows on the reported Codex client version.
 * Upstream reports the managed Codex binary version and falls back to this pin.
 */
export const OPENAI_CODEX_CLIENT_VERSION = "0.160.0";
const OPENAI_CODEX_MODELS_CACHE_TTL_MS = 60_000;
const OPENAI_CODEX_MODELS_TIMEOUT_MS = 8_000;
const OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_56_CONTEXT_WINDOW = 372_000;
const OPENAI_CODEX_GPT_61_SOL_CONTEXT_TOKENS = 500_000;
const OPENAI_CODEX_DEFAULT_MAX_TOKENS = 128_000;
const OPENAI_CODEX_UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Upstream platform-only aliases that the ChatGPT catalog must not surface. */
const OPENAI_CODEX_PLATFORM_ONLY_MODEL_IDS = new Set(["chat-latest", "gpt-5.6"]);

type CodexFallbackModel = Omit<ModelDefinitionConfig, "api" | "baseUrl"> & {
  thinkingLevelMap?: OpenAICodexThinkingLevelMap;
};

export type OpenAICodexThinkingLevelMap = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
>;

function buildFallback(params: {
  id: string;
  name: string;
  contextWindow: number;
  contextTokens: number;
  cost: ModelDefinitionConfig["cost"];
  efforts: string[];
  thinkingLevelMap: OpenAICodexThinkingLevelMap;
}): CodexFallbackModel {
  return {
    id: params.id,
    name: params.name,
    reasoning: true,
    input: ["text", "image"],
    cost: params.cost,
    contextWindow: params.contextWindow,
    contextTokens: params.contextTokens,
    maxTokens: OPENAI_CODEX_DEFAULT_MAX_TOKENS,
    compat: { supportsReasoningEffort: true, supportedReasoningEfforts: params.efforts },
    thinkingLevelMap: params.thinkingLevelMap,
  };
}

const GPT_56_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GPT_6_NO_NONE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GPT_6_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * Metadata for models newer than the bundled pi-ai registry, copied from the
 * upstream manifest (extensions/openai/openclaw.plugin.json) with the Codex
 * route adjustments upstream applies (gpt-5.6 window/off handling, 6.1 Sol
 * context). Used only to enrich rows the account's live discovery returns;
 * never advertised on its own.
 */
const OPENAI_CODEX_DISCOVERY_FALLBACKS: readonly CodexFallbackModel[] = [
  buildFallback({
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    contextWindow: 1_050_000,
    contextTokens: OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    efforts: GPT_6_NO_NONE_EFFORTS,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
  buildFallback({
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    contextWindow: 1_050_000,
    contextTokens: OPENAI_CODEX_GPT_61_SOL_CONTEXT_TOKENS,
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    efforts: GPT_6_NO_NONE_EFFORTS,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
  buildFallback({
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    contextWindow: 1_050_000,
    contextTokens: OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    efforts: GPT_6_EFFORTS,
    thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh" },
  }),
  buildFallback({
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    contextWindow: 1_050_000,
    contextTokens: OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    efforts: GPT_6_EFFORTS,
    thinkingLevelMap: { off: "none", minimal: "low", xhigh: "xhigh" },
  }),
  buildFallback({
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_WINDOW,
    contextTokens: OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    efforts: GPT_56_EFFORTS,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
  buildFallback({
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_WINDOW,
    contextTokens: OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
    efforts: GPT_56_EFFORTS,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
  buildFallback({
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_WINDOW,
    contextTokens: OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
    efforts: GPT_56_EFFORTS,
    thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
  }),
];

export function resolveOpenAICodexDiscoveryFallback(
  modelId: string,
): CodexFallbackModel | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return OPENAI_CODEX_DISCOVERY_FALLBACKS.find((model) => model.id === normalized);
}

// --- Row readers (upstream codex-model-rows.ts) -----------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFieldValue(row: unknown, keys: string | readonly string[]): unknown {
  if (!isRecord(row)) {
    return undefined;
  }
  for (const key of typeof keys === "string" ? [keys] : keys) {
    if (row[key] !== undefined) {
      return row[key];
    }
  }
  return undefined;
}

function readStringField(row: unknown, keys: string | readonly string[]): string | undefined {
  const value = readFieldValue(row, keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBooleanField(row: unknown, keys: string | readonly string[]): boolean | undefined {
  const value = readFieldValue(row, keys);
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveSafeIntegerField(
  row: unknown,
  keys: string | readonly string[],
): number | undefined {
  const value = readFieldValue(row, keys);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function readCodexReasoningLevels(row: unknown): string[] | undefined {
  const levels = readFieldValue(row, ["supported_reasoning_levels", "supportedReasoningLevels"]);
  if (!Array.isArray(levels)) {
    return undefined;
  }
  return levels.flatMap((level) => {
    const effort =
      typeof level === "string" ? level : isRecord(level) ? readStringField(level, "effort") : "";
    const normalized = normalizeLowercaseStringOrEmpty(effort);
    return normalized ? [normalized] : [];
  });
}

export class OpenAICodexModelDiscoveryShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICodexModelDiscoveryShapeError";
  }
}

export function readCodexModelRows(body: unknown): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new OpenAICodexModelDiscoveryShapeError(
      "OpenAI Codex model discovery response must be { models: [] }",
    );
  }
  return body.models;
}

export function shouldIncludeCodexModelRow(row: unknown): boolean {
  const visibility = normalizeLowercaseStringOrEmpty(readStringField(row, "visibility"));
  return (
    (visibility === "" || visibility === "list") &&
    readBooleanField(row, ["show_in_picker", "showInPicker"]) !== false
  );
}

function resolveCodexModelInput(
  row: unknown,
  fallback: CodexFallbackModel | undefined,
): ModelDefinitionConfig["input"] {
  const modalities = readFieldValue(row, ["input_modalities", "inputModalities"]);
  if (!Array.isArray(modalities)) {
    return fallback?.input ?? ["text", "image"];
  }
  const input = new Set<"text" | "image">();
  for (const modality of modalities) {
    const normalized = normalizeLowercaseStringOrEmpty(
      typeof modality === "string" ? modality : "",
    );
    if (normalized === "text") {
      input.add("text");
    } else if (normalized === "image" || normalized === "vision") {
      input.add("image");
    }
  }
  return input.size > 0 ? [...input] : ["text"];
}

// --- Row -> model (upstream buildOpenAICodexModelFromLiveRow) ---------------

export function buildOpenAICodexModelFromLiveRow(row: unknown): ModelDefinitionConfig | undefined {
  if (!shouldIncludeCodexModelRow(row)) {
    return undefined;
  }
  const modelId = readStringField(row, "slug") ?? readStringField(row, "id");
  if (!modelId) {
    return undefined;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  if (OPENAI_CODEX_PLATFORM_ONLY_MODEL_IDS.has(normalizedModelId)) {
    return undefined;
  }
  const fallback = resolveOpenAICodexDiscoveryFallback(modelId);
  const reasoningLevels = readCodexReasoningLevels(row);
  const observedContextTokens = readPositiveSafeIntegerField(row, [
    "context_window",
    "contextWindow",
  ]);
  const isGpt56Model = normalizedModelId.startsWith("gpt-5.6");
  const contextTokens = isGpt56Model
    ? Math.min(
        observedContextTokens ??
          fallback?.contextTokens ??
          OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
        OPENAI_CODEX_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      )
    : (observedContextTokens ?? fallback?.contextTokens);
  const contextWindow = isGpt56Model
    ? OPENAI_CODEX_GPT_56_CONTEXT_WINDOW
    : (readPositiveSafeIntegerField(row, ["max_context_window", "maxContextWindow"]) ??
      fallback?.contextWindow ??
      observedContextTokens ??
      DEFAULT_CONTEXT_TOKENS);
  const maxTokens =
    readPositiveSafeIntegerField(row, [
      "max_output_tokens",
      "maxOutputTokens",
      "max_completion_tokens",
      "maxCompletionTokens",
    ]) ??
    fallback?.maxTokens ??
    OPENAI_CODEX_DEFAULT_MAX_TOKENS;
  const supportedReasoningEfforts =
    reasoningLevels !== undefined
      ? isGpt56Model
        ? reasoningLevels.filter((effort) => effort !== "none")
        : reasoningLevels
      : fallback?.compat?.supportedReasoningEfforts;
  const compat =
    supportedReasoningEfforts !== undefined
      ? {
          ...fallback?.compat,
          supportsReasoningEffort: supportedReasoningEfforts.length > 0,
          supportedReasoningEfforts: [...supportedReasoningEfforts],
        }
      : fallback?.compat;

  return {
    id: modelId,
    name: readStringField(row, "display_name") ?? fallback?.name ?? modelId,
    api: "openai-codex-responses",
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    reasoning: (reasoningLevels?.length ?? 0) > 0 || fallback?.reasoning || false,
    input: resolveCodexModelInput(row, fallback),
    cost: fallback?.cost ?? { ...OPENAI_CODEX_UNKNOWN_COST },
    contextWindow,
    ...(contextTokens ? { contextTokens } : {}),
    maxTokens,
    ...(compat ? { compat } : {}),
  };
}

/**
 * Derive the pi-ai thinking-level map for a Codex model from its advertised
 * reasoning efforts. pi-ai 0.73 only understands levels up to `xhigh`, so a
 * `max` effort is not exposed on this transport.
 */
export function resolveOpenAICodexThinkingLevelMap(model: {
  id: string;
  compat?: unknown;
}): OpenAICodexThinkingLevelMap | undefined {
  const fallback = resolveOpenAICodexDiscoveryFallback(model.id);
  const rawEfforts = isRecord(model.compat) ? model.compat.supportedReasoningEfforts : undefined;
  const efforts = Array.isArray(rawEfforts)
    ? rawEfforts.filter((effort): effort is string => typeof effort === "string")
    : undefined;
  if (!efforts) {
    return fallback?.thinkingLevelMap;
  }
  const map: OpenAICodexThinkingLevelMap = {};
  if (!efforts.includes("none")) {
    map.off = null;
  }
  if (!efforts.includes("minimal") && efforts.includes("low")) {
    map.minimal = "low";
  }
  if (efforts.includes("xhigh")) {
    map.xhigh = "xhigh";
  }
  return map;
}

// --- Live discovery ----------------------------------------------------------

export function resolveOpenAICodexModelsEndpoint(
  clientVersion: string = OPENAI_CODEX_CLIENT_VERSION,
): string {
  return `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=${encodeURIComponent(clientVersion)}`;
}

export class OpenAICodexModelDiscoveryHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenAI Codex model discovery failed with HTTP ${status}`);
    this.name = "OpenAICodexModelDiscoveryHttpError";
  }
}

/** Why live discovery could not produce an account-scoped model list. */
export type OpenAICodexModelDiscoveryFailureReason =
  | "token_resolution_failed"
  | "token_unavailable"
  | "http_rate_limited"
  | "http_server_error"
  | "http_error"
  | "network"
  | "tls"
  | "timeout"
  | "invalid_response";

/** Where the `ChatGPT-Account-ID` header came from; never the value itself. */
export type OpenAICodexAccountIdSource = "profile" | "token" | "missing";

export type OpenAICodexModelDiscoveryResult =
  | {
      status: "ready";
      models: ModelDefinitionConfig[];
      rowCount: number;
      accountIdSource: OpenAICodexAccountIdSource;
    }
  | { status: "auth-rejected"; httpStatus: number; accountIdSource: OpenAICodexAccountIdSource }
  | {
      status: "unavailable";
      reason: OpenAICodexModelDiscoveryFailureReason;
      httpStatus?: number;
      errorCode?: string;
      accountIdSource?: OpenAICodexAccountIdSource;
    }
  | { status: "skipped"; reason: "test_environment" | "no_profiles" };

export type OpenAICodexModelDiscoveryDeps = {
  fetchFn?: typeof fetch;
  resolveAccessToken?: (params: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
  }) => Promise<{ token: string; profileId?: string } | undefined>;
  now?: () => number;
};

const discoveryCache = new Map<
  string,
  { expiresAt: number; result: Promise<OpenAICodexModelDiscoveryResult> }
>();

export function clearOpenAICodexModelDiscoveryCache(): void {
  discoveryCache.clear();
}

function isTestEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

async function resolveDefaultAccessToken(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<{ token: string; profileId?: string } | undefined> {
  // Same resolution (profile order, locking, OAuth refresh) the runtime uses
  // for model calls; discovery never reads or writes credentials itself.
  const resolved = await resolveApiKeyForProvider({
    provider: PROVIDER_ID,
    cfg: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  if (resolved.mode !== "oauth" && resolved.mode !== "token") {
    return undefined;
  }
  const token = resolved.apiKey?.trim();
  return token
    ? { token, ...(resolved.profileId ? { profileId: resolved.profileId } : {}) }
    : undefined;
}

function readProfileAccountId(agentDir: string | undefined, profileId: string | undefined) {
  if (!profileId) {
    return undefined;
  }
  const credential = ensureAuthProfileStoreForLocalUpdate(agentDir).profiles[profileId];
  if (!credential || credential.type !== "oauth") {
    return undefined;
  }
  const accountId = (credential as { accountId?: unknown }).accountId;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

/**
 * Stored profile metadata first (upstream behavior), then the access-token
 * claim, which is what pi-ai's `openai-codex-responses` transport sends as
 * `chatgpt-account-id` on model calls.
 */
function resolveDiscoveryAccountId(params: {
  agentDir?: string;
  profileId?: string;
  token: string;
}): { accountId?: string; source: OpenAICodexAccountIdSource } {
  const fromProfile = readProfileAccountId(params.agentDir, params.profileId);
  if (fromProfile) {
    return { accountId: fromProfile, source: "profile" };
  }
  const fromToken = resolveCodexAuthIdentity({ accessToken: params.token }).accountId;
  return fromToken ? { accountId: fromToken, source: "token" } : { source: "missing" };
}

async function fetchOpenAICodexModels(params: {
  token: string;
  accountId?: string;
  fetchFn: typeof fetch;
}): Promise<{ models: ModelDefinitionConfig[]; rowCount: number }> {
  const response = await fetchWithTimeout(
    resolveOpenAICodexModelsEndpoint(),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.token}`,
        ...(params.accountId ? { "ChatGPT-Account-ID": params.accountId } : {}),
      },
    },
    OPENAI_CODEX_MODELS_TIMEOUT_MS,
    params.fetchFn,
  );
  if (!response.ok) {
    throw new OpenAICodexModelDiscoveryHttpError(response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenAICodexModelDiscoveryShapeError(
      "OpenAI Codex model discovery response is not JSON",
    );
  }
  const rows = readCodexModelRows(body);
  return {
    models: rows
      .map((row) => buildOpenAICodexModelFromLiveRow(row))
      .filter((model): model is ModelDefinitionConfig => Boolean(model)),
    rowCount: rows.length,
  };
}

const TLS_ERROR_CODE_PATTERN = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/u;
const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function readSafeErrorCode(error: unknown): string | undefined {
  // Only machine error codes (ECONNREFUSED, CERT_HAS_EXPIRED, ...) are kept;
  // messages can echo URLs or headers and are never logged.
  const record = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  for (const candidate of [record?.cause?.code, record?.code]) {
    if (typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/u.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function classifyDiscoveryError(
  error: unknown,
  accountIdSource: OpenAICodexAccountIdSource,
): OpenAICodexModelDiscoveryResult {
  if (error instanceof OpenAICodexModelDiscoveryHttpError) {
    if (error.status === 401 || error.status === 403) {
      return { status: "auth-rejected", httpStatus: error.status, accountIdSource };
    }
    const reason =
      error.status === 429
        ? "http_rate_limited"
        : error.status >= 500
          ? "http_server_error"
          : "http_error";
    return { status: "unavailable", reason, httpStatus: error.status, accountIdSource };
  }
  if (error instanceof OpenAICodexModelDiscoveryShapeError) {
    return { status: "unavailable", reason: "invalid_response", accountIdSource };
  }
  const errorCode = readSafeErrorCode(error);
  const name = (error as { name?: unknown } | undefined)?.name;
  const reason: OpenAICodexModelDiscoveryFailureReason =
    name === "TimeoutError" ||
    name === "AbortError" ||
    (errorCode !== undefined && TIMEOUT_ERROR_CODES.has(errorCode))
      ? "timeout"
      : errorCode !== undefined && TLS_ERROR_CODE_PATTERN.test(errorCode)
        ? "tls"
        : "network";
  return { status: "unavailable", reason, ...(errorCode ? { errorCode } : {}), accountIdSource };
}

/**
 * Human-readable summary of a discovery outcome. Never includes the token,
 * the account id, or the profile id (profile ids can embed an email).
 */
export function formatOpenAICodexModelDiscoveryOutcome(
  result: OpenAICodexModelDiscoveryResult,
): string {
  switch (result.status) {
    case "ready":
      return result.models.length === 0
        ? `ready with 0 eligible models (rows=${result.rowCount}, accountId=${result.accountIdSource})`
        : `ready, ${result.models.length} account models (rows=${result.rowCount}, accountId=${result.accountIdSource})`;
    case "auth-rejected":
      return `auth-rejected (http=${result.httpStatus}, accountId=${result.accountIdSource}); no account models listed. Re-run \`openclaw models auth login --provider openai-codex\``;
    case "unavailable": {
      const details = [
        `reason=${result.reason}`,
        ...(result.httpStatus ? [`http=${result.httpStatus}`] : []),
        ...(result.errorCode ? [`code=${result.errorCode}`] : []),
        ...(result.accountIdSource ? [`accountId=${result.accountIdSource}`] : []),
      ].join(", ");
      return `unavailable (${details}); not live discovery, previously written and built-in models are kept`;
    }
    case "skipped":
      return `skipped (reason=${result.reason})`;
  }
  return "unknown";
}

function logDiscoveryOutcome(result: OpenAICodexModelDiscoveryResult): void {
  const message = `openai-codex model discovery: ${formatOpenAICodexModelDiscoveryOutcome(result)}`;
  const meta = {
    status: result.status,
    ...("reason" in result ? { reason: result.reason } : {}),
    ...("httpStatus" in result && result.httpStatus ? { httpStatus: result.httpStatus } : {}),
    ...(result.status === "ready" ? { eligible: result.models.length, rows: result.rowCount } : {}),
  };
  if (result.status === "skipped") {
    log.debug(message, meta);
  } else if (result.status === "ready" && result.models.length > 0) {
    log.info(message, meta);
  } else {
    log.warn(message, meta);
  }
}

/**
 * Ask the ChatGPT backend which Codex models the signed-in account may use.
 * 401/403 means the account cannot list models (nothing is advertised); any
 * other failure is advisory and callers keep their previous behavior.
 */
export async function discoverOpenAICodexModels(
  params: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
  deps: OpenAICodexModelDiscoveryDeps = {},
): Promise<OpenAICodexModelDiscoveryResult> {
  const settle = (result: OpenAICodexModelDiscoveryResult) => {
    logDiscoveryOutcome(result);
    return result;
  };
  const env = params.env ?? process.env;
  if (!deps.fetchFn && isTestEnvironment(env)) {
    return settle({ status: "skipped", reason: "test_environment" });
  }
  const authStore = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  if (listProfilesForProvider(authStore, PROVIDER_ID).length === 0) {
    return settle({ status: "skipped", reason: "no_profiles" });
  }
  let auth: { token: string; profileId?: string } | undefined;
  try {
    auth = await (deps.resolveAccessToken ?? resolveDefaultAccessToken)(params);
  } catch {
    return settle({ status: "unavailable", reason: "token_resolution_failed" });
  }
  if (!auth) {
    return settle({ status: "unavailable", reason: "token_unavailable" });
  }
  const { accountId, source: accountIdSource } = resolveDiscoveryAccountId({
    agentDir: params.agentDir,
    profileId: auth.profileId,
    token: auth.token,
  });
  const now = deps.now ?? Date.now;
  // Never keep the raw access token as a map key.
  const cacheKey = createHash("sha256")
    .update(`${resolveOpenAICodexModelsEndpoint()}\0${auth.token}\0${accountId ?? ""}`)
    .digest("hex");
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    // Cache hits stay quiet; the fresh outcome was already logged.
    return await cached.result;
  }
  const result = fetchOpenAICodexModels({
    token: auth.token,
    accountId,
    fetchFn: deps.fetchFn ?? fetch,
  }).then(
    ({ models, rowCount }): OpenAICodexModelDiscoveryResult => ({
      status: "ready",
      models,
      rowCount,
      accountIdSource,
    }),
    (error: unknown) => classifyDiscoveryError(error, accountIdSource),
  );
  discoveryCache.set(cacheKey, { expiresAt: now() + OPENAI_CODEX_MODELS_CACHE_TTL_MS, result });
  const settled = await result;
  if (settled.status === "unavailable") {
    // Do not pin transient failures for the whole TTL.
    discoveryCache.delete(cacheKey);
  }
  return settle(settled);
}
