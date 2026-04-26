import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

const DEFAULT_PYTHON = "python3";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_GRACE_MS = 500;
const DEFAULT_MAX_CONTENT_CHARS = 16_000;
const DEBUG_PREVIEW_CHARS = 300;
const NOOP_LOG = (_msg: string): void => {};

const MIN_TIMEOUT_MS = 1;
const MIN_GRACE_MS = 0;

const MEMORY_INGEST_CLI_MODULE = "openclaw_memory_core.integration.memory_ingest_cli";

const TRIGGERS_LONGEST_FIRST = [
  "remember this as semantic memory",
  "save this as semantic memory",
  "remember this",
  "save this",
] as const;

const FORBIDDEN_SUBSTRINGS = ["<memory_context>", "<user_request>"] as const;

// Bounded scan window for the wrapped-prompt path. Channel adapters (notably
// Discord) prepend "Conversation info (untrusted metadata)" / "Sender ..."
// blocks before the user body, so the trigger can land hundreds of characters
// in. We only scan the first SCAN_WINDOW_CHARS to keep false positives low and
// preserve cheap rejection on long, unrelated prose.
const SCAN_WINDOW_CHARS = 1000;

// Characters that may legitimately precede a trigger at the start of a user
// message inside a wrapped prompt: line break, code-fence boundary (already on
// its own line so the newline rule covers it), block-quote markers, and quote
// glyphs commonly emitted by chat clients. Conservative on purpose: anything
// alphanumeric or `_` is treated as "inside a word" and rejected.
const BOUNDARY_QUOTE_CHARS = new Set(['"', "'", "\u201C", "\u201D", "\u2018", "\u2019", "`"]);

// Characters that may legitimately follow a trigger token. Letters / digits /
// underscore would mean we matched the prefix of a longer word ("remember this
// time"), so those are excluded.
const TRAILING_BOUNDARY_CHARS = new Set([" ", "\t", ":", ".", "!", "?", ",", ";", "\n", "\r"]);

// Process-wide latch so a single `[memory-ingest] debug logging enabled`
// banner is emitted on the first ingest where `OPENCLAW_MEMORY_DEBUG=true`.
// Operators rely on this banner to confirm INFO-routed breadcrumbs reach the
// gateway log file before sending Discord traffic. Tests reset the latch via
// `__resetMemoryIngestDebugBannerForTests`.
let DEBUG_ENABLED_BANNER_EMITTED = false;

/**
 * Test-only hook to reset the once-per-process banner latch. Production code
 * never calls this; the banner is intentionally sticky for the lifetime of
 * the gateway process.
 */
export function __resetMemoryIngestDebugBannerForTests(): void {
  DEBUG_ENABLED_BANNER_EMITTED = false;
}

export type MemoryIngestStatus =
  | "skipped:disabled"
  | "skipped:no_trigger"
  | "skipped:empty"
  | "skipped:wrapped"
  | "succeeded"
  | "failed"
  | "detached"
  | "timeout";

export type MemoryIngestResult = {
  status: MemoryIngestStatus;
  reason?: string;
  content?: string;
};

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export type MemoryIngestAdapterDeps = {
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  log?: (msg: string) => void;
  /**
   * Injectable timer hook so unit tests can drive the grace window with
   * `vi.useFakeTimers()` without touching the global clock.
   */
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
};

export type MemoryIngestAdapter = {
  /**
   * Inspects raw inbound user text. When the text contains a save-memory
   * trigger and memory is enabled, spawns the ingest CLI and waits up to
   * `OPENCLAW_MEMORY_INGEST_GRACE_MS` for completion. On grace expiry the
   * child is detached and continues toward the full timeout in the
   * background; the returned status is `detached`.
   */
  ingest: (rawText: string) => Promise<MemoryIngestResult>;
};

export class MemoryIngestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "MemoryIngestError";
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

export function createMemoryIngestAdapter(deps: MemoryIngestAdapterDeps = {}): MemoryIngestAdapter {
  const spawnImpl: SpawnFn = (deps.spawn ?? nodeSpawn) as SpawnFn;
  const log = deps.log ?? (() => {});
  const setTimeoutImpl = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutFn ?? clearTimeout;

  return {
    ingest: async (rawText: string): Promise<MemoryIngestResult> => {
      const env = deps.env ?? process.env;
      const config = readConfig(env);
      const debugLog = config.debug ? log : NOOP_LOG;
      if (config.debug && !DEBUG_ENABLED_BANNER_EMITTED) {
        DEBUG_ENABLED_BANNER_EMITTED = true;
        log("[memory-ingest] debug logging enabled");
      }
      const rawChars = typeof rawText === "string" ? rawText.length : 0;

      debugLog(
        `[memory-ingest] ingest() called rawTextPreview="${previewText(
          typeof rawText === "string" ? rawText : "",
          DEBUG_PREVIEW_CHARS,
        )}" rawTextChars=${rawChars}`,
      );

      if (!config.enabled) {
        debugLog("[memory-ingest] result status=skipped:disabled spawned=false");
        return { status: "skipped:disabled" };
      }

      if (typeof rawText !== "string" || rawText.trim() === "") {
        debugLog("[memory-ingest] result status=skipped:empty spawned=false");
        return { status: "skipped:empty" };
      }

      if (containsForbiddenSubstring(rawText)) {
        debugLog("[memory-ingest] result status=skipped:wrapped spawned=false");
        return { status: "skipped:wrapped" };
      }

      const match = findTrigger(rawText);
      if (!match) {
        debugLog("[memory-ingest] result status=skipped:no_trigger spawned=false");
        return { status: "skipped:no_trigger" };
      }

      const content = extractContent(rawText, match.trigger, match.index);
      if (content === "") {
        debugLog("[memory-ingest] result status=skipped:empty spawned=false");
        return { status: "skipped:empty" };
      }

      const cappedContent = capContent(content);
      debugLog(
        `[memory-ingest] trigger="${match.trigger}" triggerIndex=${match.index} extractedPreview="${previewText(
          cappedContent,
          DEBUG_PREVIEW_CHARS,
        )}" extractedChars=${cappedContent.length}`,
      );

      const result = await runIngestSubprocess({
        spawnImpl,
        env,
        config,
        log,
        debugLog,
        setTimeoutImpl,
        clearTimeoutImpl,
        content: cappedContent,
      });

      debugLog(
        `[memory-ingest] result status=${result.status} reasonPreview="${previewText(
          result.reason ?? "",
          DEBUG_PREVIEW_CHARS,
        )}" spawned=true`,
      );
      return result;
    },
  };
}

/**
 * Prefix-only trigger detection retained for the public contract.
 *
 * Strips leading whitespace, then matches a trigger as a left-anchored prefix
 * (longest-first, case-insensitive). This is the legacy, narrow predicate
 * used directly by tests and any external callers; the runtime ingest path
 * uses {@link findTrigger}, which extends this with a bounded scan-window
 * search across wrapped channel prompts.
 */
export function matchTrigger(rawText: string): string | null {
  if (typeof rawText !== "string" || rawText === "") {
    return null;
  }
  const head = stripLeadingWhitespace(rawText).toLowerCase();
  for (const trigger of TRIGGERS_LONGEST_FIRST) {
    if (head.startsWith(trigger)) {
      return trigger;
    }
  }
  return null;
}

/**
 * Resolve a save-memory trigger anywhere within the bounded scan window.
 *
 * Performs a conservative line-based scan across the first
 * {@link SCAN_WINDOW_CHARS} characters of `rawText`. The scan covers both
 * legacy unwrapped prompts (where the trigger sits at index 0 / after
 * leading whitespace) and wrapped channel prompts (notably Discord, where
 * metadata blocks precede the user body) without a separate prefix branch:
 * {@link isLeftBoundary} accepts position 0, line starts, and inline-quote
 * / block-quote / code-fence prefixes uniformly. {@link isRightBoundary}
 * additionally requires the character after the trigger to be whitespace,
 * end-of-string, or terminal punctuation so the scan rejects matches that
 * are prefixes of longer words (e.g. `remember thistle`).
 *
 * Returns the matched trigger token in lower-case (for stable downstream
 * routing) and the absolute index in `rawText` where the trigger starts.
 * The caller passes that index to {@link extractContent} so we never slice
 * with the wrong trigger length.
 *
 * Anything past the {@link SCAN_WINDOW_CHARS} window is treated as if no
 * trigger were present, keeping cost predictable on long prompts and false
 * positives low.
 */
export function findTrigger(rawText: string): { trigger: string; index: number } | null {
  if (typeof rawText !== "string" || rawText === "") {
    return null;
  }

  const window = rawText.slice(0, SCAN_WINDOW_CHARS);
  const lowerWindow = window.toLowerCase();

  for (const trigger of TRIGGERS_LONGEST_FIRST) {
    let searchFrom = 0;
    while (searchFrom <= lowerWindow.length - trigger.length) {
      const candidate = lowerWindow.indexOf(trigger, searchFrom);
      if (candidate === -1) {
        break;
      }
      if (
        isLeftBoundary(rawText, candidate) &&
        isRightBoundary(rawText, candidate + trigger.length)
      ) {
        return { trigger, index: candidate };
      }
      searchFrom = candidate + 1;
    }
  }

  return null;
}

/**
 * Extract the payload to ingest, given the trigger and its absolute start
 * position in `rawText`.
 *
 * - With `: payload` or `:: payload` immediately after the trigger, returns
 *   `payload` (existing local-CLI / ACP behavior).
 * - With no colon and `index === 0`, falls back to the original trimmed text
 *   so the legacy "ingest the whole utterance" behavior survives unchanged.
 * - With no colon and `index > 0`, drops everything before the trigger
 *   (channel metadata) and returns `rawText.slice(index + trigger.length).trim()`
 *   so wrapped prompts never leak their inbound-meta blocks into ingest.
 */
export function extractContent(rawText: string, trigger: string, index = 0): string {
  if (typeof rawText !== "string" || rawText === "") {
    return "";
  }
  if (index < 0 || index > rawText.length) {
    return "";
  }

  const remainder = rawText.slice(index + trigger.length);
  const trimmedRemainder = remainder.replace(/^\s+/, "");

  if (trimmedRemainder.startsWith("::")) {
    return trimmedRemainder.slice(2).trim();
  }
  if (trimmedRemainder.startsWith(":")) {
    return trimmedRemainder.slice(1).trim();
  }

  if (index === 0) {
    return rawText.trim();
  }

  return remainder.trim();
}

function isLeftBoundary(rawText: string, position: number): boolean {
  if (position === 0) {
    return true;
  }

  // Walk back over inline whitespace and conservative quote/fence prefixes on
  // the same line to find the previous "structural" character. If we hit a
  // newline first, the trigger starts the line — accept it. If we hit an
  // alphanumeric / underscore character, we're inside a word — reject it.
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
      // Markdown / chat block-quote prefix: `> trigger`.
      cursor -= 1;
      continue;
    }
    return false;
  }
  return true;
}

function isRightBoundary(rawText: string, position: number): boolean {
  if (position >= rawText.length) {
    return true;
  }
  const ch = rawText[position];
  return TRAILING_BOUNDARY_CHARS.has(ch);
}

export function containsForbiddenSubstring(rawText: string): boolean {
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (rawText.includes(needle)) {
      return true;
    }
  }
  return false;
}

function capContent(content: string): string {
  return content.length > DEFAULT_MAX_CONTENT_CHARS
    ? content.slice(0, DEFAULT_MAX_CONTENT_CHARS)
    : content;
}

function stripLeadingWhitespace(value: string): string {
  return value.replace(/^\s+/, "");
}

async function runIngestSubprocess(params: {
  spawnImpl: SpawnFn;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  log: (msg: string) => void;
  debugLog: (msg: string) => void;
  setTimeoutImpl: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutImpl: (handle: NodeJS.Timeout) => void;
  content: string;
}): Promise<MemoryIngestResult> {
  const { spawnImpl, env, config, log, debugLog, setTimeoutImpl, clearTimeoutImpl, content } =
    params;

  debugLog(
    `[memory-ingest] subprocess starting python=${describePythonForLog(
      config.python,
    )} timeoutMs=${config.timeoutMs} graceMs=${config.graceMs}`,
  );

  let child: ChildProcess;
  try {
    child = spawnImpl(
      config.python,
      ["-m", MEMORY_INGEST_CLI_MODULE, "--source-type", "memory", "--content", content],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return handleSyncFailure({
      message: `memory ingest spawn threw: ${describeError(error)}`,
      strict: config.strict,
      log,
      cause: error,
    });
  }

  debugLog(
    `[memory-ingest] subprocess spawned=true pid=${child.pid !== undefined ? String(child.pid) : "?"}`,
  );

  return await new Promise<MemoryIngestResult>((resolve, reject) => {
    let settled = false;
    let detached = false;
    let stderrBuf = "";
    let stdoutBuf = "";

    const captureStream = (stream: NodeJS.ReadableStream | null, sink: (chunk: string) => void) => {
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
        `[memory-ingest] subprocess detach reason=grace_expired graceMs=${config.graceMs} timeoutMs=${config.timeoutMs}`,
      );
      resolve({
        status: "detached",
        reason: `ingest still running after grace=${config.graceMs}ms; full timeout=${config.timeoutMs}ms`,
      });
    }, config.graceMs);

    const finalize = (result: MemoryIngestResult, error?: MemoryIngestError) => {
      if (detached) {
        clearTimeoutImpl(fullTimeoutHandle);
        const failureSummary =
          result.status === "succeeded"
            ? `memory ingest finished after detach (status=${result.status})`
            : `memory ingest finished after detach (status=${result.status}${result.reason ? `: ${result.reason}` : ""})`;
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
        finalize({ status: "failed", reason }, new MemoryIngestError(reason, { cause }));
      } else {
        log(reason);
        finalize({ status: "failed", reason });
      }
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      debugLog(
        `[memory-ingest] subprocess close code=${code === null ? "null" : String(code)} signal=${
          signal ?? "null"
        } stdoutPreview="${previewText(stdoutBuf, DEBUG_PREVIEW_CHARS)}" stderrPreview="${previewText(
          stderrBuf,
          DEBUG_PREVIEW_CHARS,
        )}" detached=${detached}`,
      );
      if (signal) {
        const reason = `memory ingest killed by signal ${signal} (timeout=${config.timeoutMs}ms)`;
        const status: MemoryIngestStatus =
          signal === "SIGTERM" || signal === "SIGKILL" ? "timeout" : "failed";
        if (!detached && config.strict) {
          finalize({ status, reason }, new MemoryIngestError(reason));
        } else {
          log(reason);
          finalize({ status, reason });
        }
        return;
      }
      if (code === 0) {
        const summary = firstLine(stdoutBuf);
        finalize({
          status: "succeeded",
          ...(summary ? { reason: summary } : {}),
          content: params.content,
        });
        return;
      }
      const stderrSummary = firstLine(stderrBuf);
      const detail = stderrSummary ? `: ${stderrSummary}` : "";
      const reason = `memory ingest exited ${code ?? "null"}${detail}`;
      if (!detached && config.strict) {
        finalize({ status: "failed", reason }, new MemoryIngestError(reason));
      } else {
        log(reason);
        finalize({ status: "failed", reason });
      }
    });
  });
}

function readConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  const timeoutMs = parsePositiveInt(
    env.OPENCLAW_MEMORY_INGEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
  );
  let graceMs = parsePositiveInt(
    env.OPENCLAW_MEMORY_INGEST_GRACE_MS,
    DEFAULT_GRACE_MS,
    MIN_GRACE_MS,
  );
  if (graceMs > timeoutMs) {
    graceMs = timeoutMs;
  }

  return {
    enabled: parseBoolean(env.OPENCLAW_MEMORY_ENABLED, false),
    python: nonEmpty(env.OPENCLAW_MEMORY_PYTHON, DEFAULT_PYTHON),
    timeoutMs,
    graceMs,
    strict: parseBoolean(env.OPENCLAW_MEMORY_STRICT, false),
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
}): MemoryIngestResult {
  if (params.strict) {
    throw new MemoryIngestError(params.message, { cause: params.cause });
  }
  params.log(params.message);
  return { status: "failed", reason: params.message };
}

function describeSpawnError(error: NodeJS.ErrnoException, python: string): string {
  if (error.code === "ENOENT") {
    return `python not found: ${python}`;
  }
  if (error.code === "ETIMEDOUT") {
    return "memory ingest timed out";
  }
  return `memory ingest spawn failed: ${describeError(error)}`;
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

/**
 * Build a short, preview-safe representation of `value` for debug logs.
 *
 * Collapses runs of whitespace, trims, and caps at `maxChars` characters,
 * appending an ellipsis if the input was longer. The cap protects logs from
 * inadvertently echoing full prompts, content payloads, or stderr blobs.
 * Callers are responsible for choosing inputs that are safe to log; this
 * helper does not strip secrets.
 */
export function previewText(value: string, maxChars: number): string {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (maxChars <= 0) {
    return "";
  }
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars)}...`;
}

/**
 * Render the configured Python interpreter for debug logs without leaking
 * the absolute path. If the interpreter is configured as a path-like value
 * (contains a path separator), only the basename is logged. Otherwise the
 * raw token (e.g. `python`, `python3`, `python3.11`) is logged unchanged.
 */
function describePythonForLog(python: string): string {
  if (!python) {
    return "";
  }
  if (python.includes("/") || python.includes("\\")) {
    return path.basename(python);
  }
  return python;
}
