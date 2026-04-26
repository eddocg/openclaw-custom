import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";

const DEFAULT_PYTHON = "python";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CHARS = 4000;

const MIN_TIMEOUT_MS = 1;
const MIN_MAX_CHARS = 0;

const MEMORY_CLI_MODULE = "openclaw_memory_core.integration.memory_context_cli";

export type MemoryContextAdapter = {
  resolveContext: (query: string) => Promise<string>;
};

export type MemoryContextAdapterDeps = {
  env?: NodeJS.ProcessEnv;
  spawnSync?: typeof nodeSpawnSync;
  log?: (msg: string) => void;
};

export class MemoryContextError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "MemoryContextError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type ResolvedConfig = {
  enabled: boolean;
  python: string;
  timeoutMs: number;
  maxChars: number;
  strict: boolean;
};

export function createMemoryContextAdapter(
  deps: MemoryContextAdapterDeps = {},
): MemoryContextAdapter {
  const spawn = deps.spawnSync ?? nodeSpawnSync;
  const log = deps.log ?? (() => {});

  return {
    resolveContext: async (query: string): Promise<string> => {
      const env = deps.env ?? process.env;
      const config = readConfig(env);

      if (!config.enabled) {
        return "";
      }

      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        return "";
      }

      let result: SpawnSyncReturns<string>;
      try {
        result = spawn(
          config.python,
          ["-m", MEMORY_CLI_MODULE, "--query", trimmedQuery],
          {
            env,
            encoding: "utf-8",
            timeout: config.timeoutMs,
            maxBuffer: Math.max(1, config.maxChars * 4),
          },
        );
      } catch (error) {
        return handleFailure({
          message: `memory CLI spawn threw: ${describeError(error)}`,
          strict: config.strict,
          log,
          cause: error,
        });
      }

      if (result.error) {
        const reason = describeSpawnError(result.error, config.python);
        return handleFailure({
          message: reason,
          strict: config.strict,
          log,
          cause: result.error,
        });
      }

      if (result.signal) {
        return handleFailure({
          message: `memory CLI killed by signal ${result.signal} (timeout=${config.timeoutMs}ms)`,
          strict: config.strict,
          log,
        });
      }

      if (result.status !== 0) {
        const stderrLine = firstLine(result.stderr);
        const detail = stderrLine ? `: ${stderrLine}` : "";
        return handleFailure({
          message: `memory CLI exited ${result.status}${detail}`,
          strict: config.strict,
          log,
        });
      }

      const stdout = (result.stdout ?? "").trim();
      if (!stdout) {
        return "";
      }

      // Memory-core enforces OPENCLAW_MEMORY_MAX_CHARS itself; cap defensively
      // here so a misbehaving CLI cannot blow past the prompt budget.
      return stdout.length > config.maxChars ? stdout.slice(0, config.maxChars) : stdout;
    },
  };
}

function readConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  return {
    enabled: parseBoolean(env.OPENCLAW_MEMORY_ENABLED, false),
    python: nonEmpty(env.OPENCLAW_MEMORY_PYTHON, DEFAULT_PYTHON),
    timeoutMs: parsePositiveInt(env.OPENCLAW_MEMORY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    maxChars: parsePositiveInt(env.OPENCLAW_MEMORY_MAX_CHARS, DEFAULT_MAX_CHARS, MIN_MAX_CHARS),
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

function handleFailure(params: {
  message: string;
  strict: boolean;
  log: (msg: string) => void;
  cause?: unknown;
}): string {
  if (params.strict) {
    throw new MemoryContextError(params.message, { cause: params.cause });
  }
  params.log(params.message);
  return "";
}

function describeSpawnError(error: NodeJS.ErrnoException, python: string): string {
  if (error.code === "ENOENT") {
    return `python not found: ${python}`;
  }
  if (error.code === "ETIMEDOUT") {
    return `memory CLI timed out`;
  }
  return `memory CLI spawn failed: ${describeError(error)}`;
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
