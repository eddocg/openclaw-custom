import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const DEFAULT_PYTHON = "python3";
const DEFAULT_MAX_TEXT_CHARS = 16_000;

const DISCORD_TURN_CLI_MODULE = "openclaw_memory_core.integration.discord_turn_cli";
const DISCORD_TURN_CLI_SUBCOMMAND = "record";

export type DiscordTurnEpisodeOutcome = "completed" | "short_circuit" | "failed";

export type DiscordTurnEpisodeRecordParams = {
  sessionKey: string;
  runId: string;
  userMessage: string;
  provider: string;
  model: string;
  stopReason: string;
  outcome: DiscordTurnEpisodeOutcome;
  durationMs: number;
  assistantText?: string;
  errorMessage?: string;
  messageId?: string;
  fallbackUsed?: boolean;
};

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export type DiscordTurnEpisodeAdapterDeps = {
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  log?: (msg: string) => void;
};

export type DiscordTurnEpisodeAdapter = {
  /**
   * Fire-and-forget side-effect recorder for Discord runtime turns.
   *
   * The adapter intentionally does not wait for child completion. Memory-core
   * owns write semantics; OpenClaw only forwards bounded turn facts.
   */
  record: (params: DiscordTurnEpisodeRecordParams) => void;
};

export function createDiscordTurnEpisodeAdapter(
  deps: DiscordTurnEpisodeAdapterDeps = {},
): DiscordTurnEpisodeAdapter {
  const spawnImpl: SpawnFn = (deps.spawn ?? nodeSpawn) as SpawnFn;
  const log = deps.log ?? (() => {});

  return {
    record: (params: DiscordTurnEpisodeRecordParams): void => {
      try {
        const env = deps.env ?? process.env;
        if (!parseBoolean(env.OPENCLAW_MEMORY_ENABLED, false)) {
          return;
        }

        const dsn = nonEmpty(env.OPENCLAW_MEMORY_CORE_DSN);
        if (dsn === undefined) {
          log("[discord-turn-episode] skipped: OPENCLAW_MEMORY_CORE_DSN is not set");
          return;
        }

        const python =
          nonEmpty(env.OPENCLAW_MEMORY_PYTHON) ??
          nonEmpty(env.OPENCLAW_MEMORY_CORE_PYTHON) ??
          DEFAULT_PYTHON;
        const child = spawnImpl(python, buildArgs(dsn, params), {
          detached: true,
          env,
          stdio: "ignore",
        });

        child.on("error", (error: Error) => {
          log(`[discord-turn-episode] record subprocess error: ${describeError(error)}`);
        });

        child.unref();
      } catch (error) {
        log(`[discord-turn-episode] record spawn failed: ${describeError(error)}`);
      }
    },
  };
}

function buildArgs(
  dsn: string,
  params: DiscordTurnEpisodeRecordParams,
): ReadonlyArray<string> {
  const args = [
    "-m",
    DISCORD_TURN_CLI_MODULE,
    DISCORD_TURN_CLI_SUBCOMMAND,
    "--dsn",
    dsn,
    "--session-key",
    params.sessionKey,
    "--run-id",
    params.runId,
    "--user-message",
    capText(params.userMessage),
    "--provider",
    params.provider,
    "--model",
    params.model,
    "--stop-reason",
    params.stopReason,
    "--outcome",
    params.outcome,
    "--duration-ms",
    String(normalizeDurationMs(params.durationMs)),
  ];

  const assistantText = optionalCappedText(params.assistantText);
  if (assistantText !== undefined) {
    args.push("--assistant-text", assistantText);
  }

  const errorMessage = optionalCappedText(params.errorMessage);
  if (errorMessage !== undefined) {
    args.push("--error-message", errorMessage);
  }

  const messageId = nonEmpty(params.messageId);
  if (messageId !== undefined) {
    args.push("--message-id", messageId);
  }

  if (params.fallbackUsed === true) {
    args.push("--fallback-used");
  }

  return args;
}

function optionalCappedText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return capText(value);
}

function capText(value: string): string {
  return value.length > DEFAULT_MAX_TEXT_CHARS ? value.slice(0, DEFAULT_MAX_TEXT_CHARS) : value;
}

function normalizeDurationMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
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

function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
