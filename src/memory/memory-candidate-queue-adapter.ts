import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  containsForbiddenSubstring,
  previewText,
  type SpawnFn,
} from "./memory-ingest-adapter.js";

export type { SpawnFn };

const DEFAULT_PYTHON = "python3";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GRACE_MS = 500;
const DEFAULT_MAX_CONTENT_CHARS = 16_000;
const DEFAULT_SOURCE = "runtime";
const DEBUG_PREVIEW_CHARS = 300;
const NOOP_LOG = (_msg: string): void => {};

const MIN_TIMEOUT_MS = 1;
const MIN_GRACE_MS = 0;

const MEMORY_CANDIDATE_QUEUE_CLI_MODULE =
  "openclaw_memory_core.integration.memory_candidate_queue_cli";
const MEMORY_CANDIDATE_QUEUE_SUBCOMMAND = "enqueue-pipeline";

const TRIGGER_TOKEN = "queue memory";

// Bounded scan window for the wrapped-prompt path, mirroring the semantic
// ingest adapter so wrapped channel prompts (Discord etc.) match the trigger
// when it lands after an inbound metadata block.
const SCAN_WINDOW_CHARS = 1000;

const BOUNDARY_QUOTE_CHARS = new Set(['"', "'", "\u201C", "\u201D", "\u2018", "\u2019", "`"]);

// Process-wide latch so a single
// `[memory-candidate-queue] debug logging enabled` banner is emitted on the
// first enqueue where `OPENCLAW_MEMORY_DEBUG=true`. Tests reset the latch via
// `__resetMemoryCandidateQueueDebugBannerForTests`.
let DEBUG_ENABLED_BANNER_EMITTED = false;

/**
 * Test-only hook to reset the once-per-process banner latch. Production code
 * never calls this; the banner is intentionally sticky for the lifetime of
 * the gateway process.
 */
export function __resetMemoryCandidateQueueDebugBannerForTests(): void {
  DEBUG_ENABLED_BANNER_EMITTED = false;
}

export type MemoryCandidateQueueStatus =
  | "skipped:disabled"
  | "skipped:no_trigger"
  | "skipped:empty"
  | "skipped:wrapped"
  | "succeeded"
  | "failed"
  | "detached"
  | "timeout";

export type MemoryCandidateQueueResult = {
  status: MemoryCandidateQueueStatus;
  reason?: string;
  /** Echoed candidateId that was forwarded to the queue CLI on a spawn path. */
  candidateId?: string;
  /** Echoed source token forwarded to the queue CLI on a spawn path. */
  source?: string;
};

export type MemoryCandidateQueueContext = {
  /**
   * Channel/runtime label (e.g. "discord", "telegram", "acp", "embedded").
   * Falls back to `provider`, then to "runtime".
   */
  source?: string;
  /**
   * Caller-supplied stable candidate id. Channel adapters that already mint
   * a stable per-message id should pass it; otherwise the adapter builds a
   * source-aware fallback that does not include the message text.
   */
  candidateId?: string;
  /** Session-like identifier used for fallback candidate-id construction. */
  sessionKey?: string;
  /** Request/turn identifier used for fallback candidate-id construction. */
  requestId?: string;
  /** Provider hint (e.g. "discord", "openai"); used as a fallback `source`. */
  provider?: string;
  /** Channel-native message id, if available; used in fallback candidate ids. */
  messageId?: string;
};

export type MemoryCandidateQueueAdapter = {
  /**
   * Inspects raw inbound user text. When the text contains a
   * `queue memory:` trigger and the queue is enabled, spawns the
   * `memory_candidate_queue_cli enqueue-pipeline` subprocess. Resolves
   * within `OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS`; on grace expiry the
   * child is detached and continues toward the full timeout in the
   * background and the returned status is `detached`.
   */
  enqueue: (
    rawText: string,
    context?: MemoryCandidateQueueContext,
  ) => Promise<MemoryCandidateQueueResult>;
};

export type MemoryCandidateQueueAdapterDeps = {
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  log?: (msg: string) => void;
  /**
   * Injectable timer hook so unit tests can drive the grace window with
   * `vi.useFakeTimers()` without touching the global clock.
   */
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  /**
   * Injectable id factory. Defaults to `node:crypto.randomUUID`. Tests use
   * a deterministic stub.
   */
  randomId?: () => string;
};

export class MemoryCandidateQueueError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "MemoryCandidateQueueError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type ResolvedConfig = {
  enabled: boolean;
  python: string;
  timeoutMs: number;
  graceMs: number;
  strict: boolean;
  debug: boolean;
};

export function createMemoryCandidateQueueAdapter(
  deps: MemoryCandidateQueueAdapterDeps = {},
): MemoryCandidateQueueAdapter {
  const spawnImpl: SpawnFn = (deps.spawn ?? nodeSpawn) as SpawnFn;
  const log = deps.log ?? (() => {});
  const setTimeoutImpl = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutFn ?? clearTimeout;
  const randomId = deps.randomId ?? (() => randomUUID());

  return {
    enqueue: async (
      rawText: string,
      context: MemoryCandidateQueueContext = {},
    ): Promise<MemoryCandidateQueueResult> => {
      const env = deps.env ?? process.env;
      const config = readConfig(env);
      const debugLog = config.debug ? log : NOOP_LOG;
      if (config.debug && !DEBUG_ENABLED_BANNER_EMITTED) {
        DEBUG_ENABLED_BANNER_EMITTED = true;
        log("[memory-candidate-queue] debug logging enabled");
      }

      const rawChars = typeof rawText === "string" ? rawText.length : 0;
      debugLog(
        `[memory-candidate-queue] enqueue() called rawTextPreview="${previewText(
          typeof rawText === "string" ? rawText : "",
          DEBUG_PREVIEW_CHARS,
        )}" rawTextChars=${rawChars}`,
      );

      if (!config.enabled) {
        debugLog("[memory-candidate-queue] result status=skipped:disabled spawned=false");
        return { status: "skipped:disabled" };
      }

      if (typeof rawText !== "string" || rawText.trim() === "") {
        debugLog("[memory-candidate-queue] result status=skipped:empty spawned=false");
        return { status: "skipped:empty" };
      }

      if (containsForbiddenSubstring(rawText)) {
        debugLog("[memory-candidate-queue] result status=skipped:wrapped spawned=false");
        return { status: "skipped:wrapped" };
      }

      const match = findQueueTrigger(rawText);
      if (!match) {
        debugLog("[memory-candidate-queue] result status=skipped:no_trigger spawned=false");
        return { status: "skipped:no_trigger" };
      }

      const content = extractQueuePayload(rawText, match.index);
      if (content === "") {
        debugLog("[memory-candidate-queue] result status=skipped:empty spawned=false");
        return { status: "skipped:empty" };
      }

      const cappedContent = capContent(content);
      const source = resolveSource(context);
      const candidateId = resolveCandidateId({ context, source, randomId });

      debugLog(
        `[memory-candidate-queue] trigger="${TRIGGER_TOKEN}" triggerIndex=${
          match.index
        } source="${source}" candidateId="${candidateId}" extractedPreview="${previewText(
          cappedContent,
          DEBUG_PREVIEW_CHARS,
        )}" extractedChars=${cappedContent.length}`,
      );

      const result = await runQueueSubprocess({
        spawnImpl,
        env,
        config,
        log,
        debugLog,
        setTimeoutImpl,
        clearTimeoutImpl,
        content: cappedContent,
        source,
        candidateId,
      });

      debugLog(
        `[memory-candidate-queue] result status=${result.status} reasonPreview="${previewText(
          result.reason ?? "",
          DEBUG_PREVIEW_CHARS,
        )}" spawned=true`,
      );
      return result;
    },
  };
}

/**
 * Locate `queue memory:` (case-insensitive) at a logical message boundary
 * within the first {@link SCAN_WINDOW_CHARS} characters. Returns `null` on
 * any non-match, including the bare `queue memory` token without a trailing
 * colon (so the trigger is unambiguous and never collides with prose).
 *
 * The boundary rules mirror `memory-ingest-adapter#findTrigger`: the match
 * must sit at position 0, immediately after a newline, or after a chain of
 * inline whitespace plus optional block-quote (`>`) and quote glyphs
 * (`"`, `'`, `` ` ``, smart quotes). Mid-prose matches like
 * `please queue memory: foo` are rejected because the run-back hits an
 * alphanumeric character before any newline / start-of-string.
 */
export function findQueueTrigger(rawText: string): { index: number } | null {
  if (typeof rawText !== "string" || rawText === "") {
    return null;
  }
  const window = rawText.slice(0, SCAN_WINDOW_CHARS);
  const lowerWindow = window.toLowerCase();
  let searchFrom = 0;
  while (searchFrom <= lowerWindow.length - TRIGGER_TOKEN.length) {
    const candidate = lowerWindow.indexOf(TRIGGER_TOKEN, searchFrom);
    if (candidate === -1) {
      return null;
    }
    if (
      isLeftBoundary(rawText, candidate) &&
      isColonRightBoundary(rawText, candidate + TRIGGER_TOKEN.length)
    ) {
      return { index: candidate };
    }
    searchFrom = candidate + 1;
  }
  return null;
}

/**
 * Extract the payload following a `queue memory:` trigger.
 *
 * The trigger always requires at least a single colon (enforced by
 * {@link findQueueTrigger}). A second colon, e.g. `queue memory:: foo`, is
 * also accepted so the form mirrors the semantic ingest adapter's `::`
 * shorthand. Only the post-colon remainder is returned, trimmed; preceding
 * channel metadata is discarded.
 */
export function extractQueuePayload(rawText: string, index: number): string {
  if (typeof rawText !== "string" || rawText === "") {
    return "";
  }
  if (index < 0 || index > rawText.length) {
    return "";
  }
  const remainder = rawText.slice(index + TRIGGER_TOKEN.length);
  const trimmedRemainder = remainder.replace(/^\s+/, "");
  if (trimmedRemainder.startsWith("::")) {
    return trimmedRemainder.slice(2).trim();
  }
  if (trimmedRemainder.startsWith(":")) {
    return trimmedRemainder.slice(1).trim();
  }
  return "";
}

function isLeftBoundary(rawText: string, position: number): boolean {
  if (position === 0) {
    return true;
  }
  let cursor = position - 1;
  while (cursor >= 0) {
    const ch = rawText[cursor];
    if (ch === "\n" || ch === "\r") {
      return true;
    }
    if (ch === " " || ch === "\t") {
      cursor -= 1;
      continue;
    }
    if (BOUNDARY_QUOTE_CHARS.has(ch)) {
      cursor -= 1;
      continue;
    }
    if (ch === ">") {
      cursor -= 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Right-boundary check for the queue trigger. Unlike the semantic ingest
 * adapter (which accepts whitespace / sentence punctuation as terminators),
 * the queue trigger requires a colon directly after `queue memory` so the
 * marker stays unambiguous. Optional inline whitespace between the token
 * and the colon is allowed; everything else is rejected.
 */
function isColonRightBoundary(rawText: string, position: number): boolean {
  let cursor = position;
  while (cursor < rawText.length) {
    const ch = rawText[cursor];
    if (ch === " " || ch === "\t") {
      cursor += 1;
      continue;
    }
    return ch === ":";
  }
  return false;
}

function resolveSource(context: MemoryCandidateQueueContext): string {
  const fromContext = nonEmptyString(context.source);
  if (fromContext) {
    return fromContext;
  }
  const fromProvider = nonEmptyString(context.provider);
  if (fromProvider) {
    return fromProvider;
  }
  return DEFAULT_SOURCE;
}

function resolveCandidateId(params: {
  context: MemoryCandidateQueueContext;
  source: string;
  randomId: () => string;
}): string {
  const explicit = nonEmptyString(params.context.candidateId);
  if (explicit) {
    return explicit;
  }
  const messageId = nonEmptyString(params.context.messageId);
  const sessionKey = nonEmptyString(params.context.sessionKey);
  const requestId = nonEmptyString(params.context.requestId);

  if (messageId) {
    return `${params.source}:msg:${messageId}`;
  }
  if (requestId) {
    return `${params.source}:req:${sessionKey ?? "no-session"}:${requestId}`;
  }
  if (sessionKey) {
    return `${params.source}:sess:${sessionKey}:${params.randomId()}`;
  }
  return `${params.source}:fallback:${params.randomId()}`;
}

function nonEmptyString(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function capContent(content: string): string {
  return content.length > DEFAULT_MAX_CONTENT_CHARS
    ? content.slice(0, DEFAULT_MAX_CONTENT_CHARS)
    : content;
}

async function runQueueSubprocess(params: {
  spawnImpl: SpawnFn;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  log: (msg: string) => void;
  debugLog: (msg: string) => void;
  setTimeoutImpl: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutImpl: (handle: NodeJS.Timeout) => void;
  content: string;
  source: string;
  candidateId: string;
}): Promise<MemoryCandidateQueueResult> {
  const {
    spawnImpl,
    env,
    config,
    log,
    debugLog,
    setTimeoutImpl,
    clearTimeoutImpl,
    content,
    source,
    candidateId,
  } = params;

  debugLog(
    `[memory-candidate-queue] subprocess starting python=${describePythonForLog(
      config.python,
    )} timeoutMs=${config.timeoutMs} graceMs=${config.graceMs}`,
  );

  let child: ChildProcess;
  try {
    child = spawnImpl(
      config.python,
      [
        "-m",
        MEMORY_CANDIDATE_QUEUE_CLI_MODULE,
        MEMORY_CANDIDATE_QUEUE_SUBCOMMAND,
        "--text",
        content,
        "--source",
        source,
        "--candidate-id",
        candidateId,
        "--json",
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return handleSyncFailure({
      message: `memory candidate queue spawn threw: ${describeError(error)}`,
      strict: config.strict,
      log,
      cause: error,
      source,
      candidateId,
    });
  }

  debugLog(
    `[memory-candidate-queue] subprocess spawned=true pid=${
      child.pid !== undefined ? String(child.pid) : "?"
    }`,
  );

  return await new Promise<MemoryCandidateQueueResult>((resolve, reject) => {
    let settled = false;
    let detached = false;
    let stderrBuf = "";
    let stdoutBuf = "";

    const captureStream = (
      stream: NodeJS.ReadableStream | null,
      sink: (chunk: string) => void,
    ): void => {
      if (!stream) {
        return;
      }
      stream.setEncoding?.("utf-8");
      stream.on("data", (chunk: string | Buffer) => {
        sink(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      });
    };
    captureStream(child.stdout, (chunk) => {
      stdoutBuf += chunk;
    });
    captureStream(child.stderr, (chunk) => {
      stderrBuf += chunk;
    });

    const fullTimeoutHandle = setTimeoutImpl(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort kill
      }
    }, config.timeoutMs);

    const graceHandle = setTimeoutImpl(() => {
      if (settled) {
        return;
      }
      detached = true;
      settled = true;
      debugLog(
        `[memory-candidate-queue] subprocess detach reason=grace_expired graceMs=${config.graceMs} timeoutMs=${config.timeoutMs}`,
      );
      resolve({
        status: "detached",
        reason: `candidate queue still running after grace=${config.graceMs}ms; full timeout=${config.timeoutMs}ms`,
        source,
        candidateId,
      });
    }, config.graceMs);

    const finalize = (
      result: MemoryCandidateQueueResult,
      error?: MemoryCandidateQueueError,
    ): void => {
      if (detached) {
        clearTimeoutImpl(fullTimeoutHandle);
        const failureSummary =
          result.status === "succeeded"
            ? `memory candidate queue finished after detach (status=${result.status})`
            : `memory candidate queue finished after detach (status=${result.status}${
                result.reason ? `: ${result.reason}` : ""
              })`;
        log(failureSummary);
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutImpl(graceHandle);
      clearTimeoutImpl(fullTimeoutHandle);
      if (error && config.strict) {
        reject(error);
        return;
      }
      resolve(result);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      const reason = describeSpawnError(err, config.python);
      const cause = err;
      if (config.strict) {
        finalize(
          { status: "failed", reason, source, candidateId },
          new MemoryCandidateQueueError(reason, { cause }),
        );
      } else {
        log(reason);
        finalize({ status: "failed", reason, source, candidateId });
      }
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      debugLog(
        `[memory-candidate-queue] subprocess close code=${
          code === null ? "null" : String(code)
        } signal=${signal ?? "null"} stdoutPreview="${previewText(
          stdoutBuf,
          DEBUG_PREVIEW_CHARS,
        )}" stderrPreview="${previewText(stderrBuf, DEBUG_PREVIEW_CHARS)}" detached=${detached}`,
      );
      if (signal) {
        const reason = `memory candidate queue killed by signal ${signal} (timeout=${config.timeoutMs}ms)`;
        const status: MemoryCandidateQueueStatus =
          signal === "SIGTERM" || signal === "SIGKILL" ? "timeout" : "failed";
        if (!detached && config.strict) {
          finalize(
            { status, reason, source, candidateId },
            new MemoryCandidateQueueError(reason),
          );
        } else {
          log(reason);
          finalize({ status, reason, source, candidateId });
        }
        return;
      }
      if (code === 0) {
        const summary = firstLine(stdoutBuf);
        finalize({
          status: "succeeded",
          ...(summary ? { reason: summary } : {}),
          source,
          candidateId,
        });
        return;
      }
      const stderrSummary = firstLine(stderrBuf);
      const detail = stderrSummary ? `: ${stderrSummary}` : "";
      const reason = `memory candidate queue exited ${code ?? "null"}${detail}`;
      if (!detached && config.strict) {
        finalize(
          { status: "failed", reason, source, candidateId },
          new MemoryCandidateQueueError(reason),
        );
      } else {
        log(reason);
        finalize({ status: "failed", reason, source, candidateId });
      }
    });
  });
}

function readConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  const timeoutMs = parsePositiveInt(
    env.OPENCLAW_MEMORY_CANDIDATE_QUEUE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
  );
  let graceMs = parsePositiveInt(
    env.OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS,
    DEFAULT_GRACE_MS,
    MIN_GRACE_MS,
  );
  if (graceMs > timeoutMs) {
    graceMs = timeoutMs;
  }
  return {
    enabled: parseBoolean(env.OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED, false),
    python: nonEmpty(env.OPENCLAW_MEMORY_PYTHON, DEFAULT_PYTHON),
    timeoutMs,
    graceMs,
    strict: parseBoolean(env.OPENCLAW_MEMORY_CANDIDATE_QUEUE_STRICT, false),
    debug: parseBoolean(env.OPENCLAW_MEMORY_DEBUG, false),
  };
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const lower = raw.trim().toLowerCase();
  if (lower === "") {
    return fallback;
  }
  if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function nonEmpty(raw: string | undefined, fallback: string): string {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

function handleSyncFailure(params: {
  message: string;
  strict: boolean;
  log: (msg: string) => void;
  cause?: unknown;
  source: string;
  candidateId: string;
}): MemoryCandidateQueueResult {
  if (params.strict) {
    throw new MemoryCandidateQueueError(params.message, { cause: params.cause });
  }
  params.log(params.message);
  return {
    status: "failed",
    reason: params.message,
    source: params.source,
    candidateId: params.candidateId,
  };
}

function describeSpawnError(error: NodeJS.ErrnoException, python: string): string {
  if (error.code === "ENOENT") {
    return `python not found: ${python}`;
  }
  if (error.code === "ETIMEDOUT") {
    return "memory candidate queue timed out";
  }
  return `memory candidate queue spawn failed: ${describeError(error)}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function firstLine(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const idx = value.indexOf("\n");
  return (idx === -1 ? value : value.slice(0, idx)).trim();
}

function describePythonForLog(python: string): string {
  if (!python) {
    return "";
  }
  if (python.includes("/") || python.includes("\\")) {
    return path.basename(python);
  }
  return python;
}
