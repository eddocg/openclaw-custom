import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscordTurnEpisodeAdapter,
  type DiscordTurnEpisodeRecordParams,
  type SpawnFn,
} from "./discord-turn-episode-adapter.js";

type SpawnCall = {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnOptions;
};

type FakeChild = ChildProcess & {
  emitError: (error: Error) => void;
  unref: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.unref = vi.fn();
  child.emitError = (error) => child.emit("error", error);
  return child;
}

function buildSpawn(): {
  spawn: SpawnFn;
  calls: SpawnCall[];
  child: FakeChild;
} {
  const calls: SpawnCall[] = [];
  const child = createFakeChild();
  const spawnFn = vi.fn(
    (command: string, args: ReadonlyArray<string>, options: SpawnOptions): ChildProcess => {
      calls.push({ command, args, options });
      return child;
    },
  );

  return {
    spawn: ((...args) => spawnFn(...(args as Parameters<SpawnFn>))) as SpawnFn,
    calls,
    child,
  };
}

function makeParams(
  overrides: Partial<DiscordTurnEpisodeRecordParams> = {},
): DiscordTurnEpisodeRecordParams {
  return {
    sessionKey: "discord:guild:channel:thread",
    runId: "run-123",
    userMessage: "what should I do?",
    provider: "openai",
    model: "gpt-5.5",
    stopReason: "stop",
    outcome: "completed",
    durationMs: 1234,
    assistantText: "do the thing",
    ...overrides,
  };
}

function valueAfter(args: ReadonlyArray<string>, flag: string): string {
  const index = args.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  const value = args[index + 1];
  expect(value).toBeDefined();
  return value!;
}

const ENABLED_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_MEMORY_ENABLED: "true",
  OPENCLAW_MEMORY_CORE_DSN: "postgres://memory-core",
};

describe("createDiscordTurnEpisodeAdapter", () => {
  it("does not spawn when memory is disabled or missing", () => {
    const spawn = buildSpawn();
    const adapter = createDiscordTurnEpisodeAdapter({ env: {}, spawn: spawn.spawn });

    expect(() => adapter.record(makeParams())).not.toThrow();
    expect(spawn.calls).toHaveLength(0);
  });

  it("does not spawn and logs when DSN is missing", () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const adapter = createDiscordTurnEpisodeAdapter({
      env: { OPENCLAW_MEMORY_ENABLED: "true" },
      spawn: spawn.spawn,
      log,
    });

    adapter.record(makeParams());

    expect(spawn.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      "[discord-turn-episode] skipped: OPENCLAW_MEMORY_CORE_DSN is not set",
    );
  });

  it("spawns the discord turn CLI detached and unrefs the child", () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CORE_PYTHON: "/opt/memory/python",
    };
    const adapter = createDiscordTurnEpisodeAdapter({ env, spawn: spawn.spawn });

    adapter.record(makeParams({ messageId: "discord-message-1" }));

    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0]!;
    expect(call.command).toBe("/opt/memory/python");
    expect(call.args).toEqual([
      "-m",
      "openclaw_memory_core.integration.discord_turn_cli",
      "record",
      "--dsn",
      "postgres://memory-core",
      "--session-key",
      "discord:guild:channel:thread",
      "--run-id",
      "run-123",
      "--user-message",
      "what should I do?",
      "--provider",
      "openai",
      "--model",
      "gpt-5.5",
      "--stop-reason",
      "stop",
      "--outcome",
      "completed",
      "--duration-ms",
      "1234",
      "--assistant-text",
      "do the thing",
      "--message-id",
      "discord-message-1",
    ]);
    expect(call.options).toMatchObject({
      detached: true,
      env,
      stdio: "ignore",
    });
    expect(spawn.child.unref).toHaveBeenCalledTimes(1);
  });

  it("passes short_circuit outcome correctly", () => {
    const spawn = buildSpawn();
    const adapter = createDiscordTurnEpisodeAdapter({ env: ENABLED_ENV, spawn: spawn.spawn });

    adapter.record(makeParams({ outcome: "short_circuit", assistantText: undefined }));

    expect(valueAfter(spawn.calls[0]!.args, "--outcome")).toBe("short_circuit");
    expect(spawn.calls[0]!.args).not.toContain("--assistant-text");
  });

  it("passes failed outcome and error message", () => {
    const spawn = buildSpawn();
    const adapter = createDiscordTurnEpisodeAdapter({ env: ENABLED_ENV, spawn: spawn.spawn });

    adapter.record(
      makeParams({
        outcome: "failed",
        stopReason: "error",
        assistantText: undefined,
        errorMessage: "model exploded",
      }),
    );

    const args = spawn.calls[0]!.args;
    expect(valueAfter(args, "--outcome")).toBe("failed");
    expect(valueAfter(args, "--error-message")).toBe("model exploded");
  });

  it("includes fallback-used flag when true", () => {
    const spawn = buildSpawn();
    const adapter = createDiscordTurnEpisodeAdapter({ env: ENABLED_ENV, spawn: spawn.spawn });

    adapter.record(makeParams({ fallbackUsed: true }));

    expect(spawn.calls[0]!.args).toContain("--fallback-used");
  });

  it("truncates user message, assistant text, and error message", () => {
    const spawn = buildSpawn();
    const adapter = createDiscordTurnEpisodeAdapter({ env: ENABLED_ENV, spawn: spawn.spawn });
    const longText = "x".repeat(20_000);

    adapter.record(
      makeParams({
        userMessage: longText,
        assistantText: longText,
        errorMessage: longText,
      }),
    );

    const args = spawn.calls[0]!.args;
    expect(valueAfter(args, "--user-message")).toHaveLength(16_000);
    expect(valueAfter(args, "--assistant-text")).toHaveLength(16_000);
    expect(valueAfter(args, "--error-message")).toHaveLength(16_000);
  });

  it("swallows and logs asynchronous spawn errors", () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const adapter = createDiscordTurnEpisodeAdapter({ env: ENABLED_ENV, spawn: spawn.spawn, log });

    adapter.record(makeParams());

    expect(() => spawn.child.emitError(new Error("ENOENT"))).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "[discord-turn-episode] record subprocess error: ENOENT",
    );
  });

  it("swallows and logs synchronous spawn throws", () => {
    const log = vi.fn();
    const spawn: SpawnFn = vi.fn(() => {
      throw new Error("spawn boom");
    });
    const adapter = createDiscordTurnEpisodeAdapter({ env: ENABLED_ENV, spawn, log });

    expect(() => adapter.record(makeParams())).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "[discord-turn-episode] record spawn failed: spawn boom",
    );
  });
});
