import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

const DEFAULT_PYTHON = "python3";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_GRACE_MS = 500;
const DEFAULT_MAX_CONTENT_CHARS = 16_000;

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
};

export function createMemoryIngestAdapter(
  deps: MemoryIngestAdapterDeps = {},
): MemoryIngestAdapter {
  const spawnImpl: SpawnFn = (deps.spawn ?? nodeSpawn) as SpawnFn;
  const log = deps.log ?? (() => {});
  const setTimeoutImpl = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutFn ?? clearTimeout;

  return {
    ingest: async (rawText: string): Promise<MemoryIngestResult> => {
      const env = deps.env ?? process.env;
      const config = readConfig(env);

      if (!config.enabled) {
        return { status: "skipped:disabled" };
      }

      if (typeof rawText !== "string" || rawText.trim() === "") {
        return { status: "skipped:empty" };
      }

      if (containsForbiddenSubstring(rawText)) {
        return { status: "skipped:wrapped" };
      }

      const trigger = matchTrigger(rawText);
      if (!trigger) {
        return { status: "skipped:no_trigger" };
      }

      const content = extractContent(rawText, trigger);
      if (content === "") {
        return { status: "skipped:empty" };
      }

      return await runIngestSubprocess({
        spawnImpl,
        env,
        config,
        log,
        setTimeoutImpl,
        clearTimeoutImpl,
        content: capContent(content),
      });
    },
  };
}

export function matchTrigger(rawText: string): string | null {
  const head = stripLeadingWhitespace(rawText).toLowerCase();
  for (const trigger of TRIGGERS_LONGEST_FIRST) {
    if (head.startsWith(trigger)) {
      return trigger;
    }
  }
  return null;
}

export function extractContent(rawText: string, trigger: string): string {
  const stripped = stripLeadingWhitespace(rawText);
  const remainder = stripped.slice(trigger.length);
  const trimmedRemainder = remainder.replace(/^\s+/, "");

  if (trimmedRemainder.startsWith("::")) {
    return trimmedRemainder.slice(2).trim();
  }
  if (trimmedRemainder.startsWith(":")) {
    return trimmedRemainder.slice(1).trim();
  }

  return rawText.trim();
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
  setTimeoutImpl: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutImpl: (handle: NodeJS.Timeout) => void;
  content: string;
}): Promise<MemoryIngestResult> {
  const { spawnImpl, env, config, log, setTimeoutImpl, clearTimeoutImpl, content } = params;

  let child: ChildProcess;
  try {
    child = spawnImpl(
      config.python,
      [
        "-m",
        MEMORY_INGEST_CLI_MODULE,
        "--source-type",
        "memory",
        "--content",
        content,
      ],
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
        finalize(
          { status: "failed", reason },
          new MemoryIngestError(reason, { cause }),
        );
      } else {
        log(reason);
        finalize({ status: "failed", reason });
      }
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) {
        const reason = `memory ingest killed by signal ${signal} (timeout=${config.timeoutMs}ms)`;
        const status: MemoryIngestStatus =
          signal === "SIGTERM" || signal === "SIGKILL" ? "timeout" : "failed";
        if (!detached && config.strict) {
          finalize(
            { status, reason },
            new MemoryIngestError(reason),
          );
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
        finalize(
          { status: "failed", reason },
          new MemoryIngestError(reason),
        );
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
