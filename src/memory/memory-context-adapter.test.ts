import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryContextAdapter,
  MemoryContextError,
  type MemoryContextAdapterDeps,
} from "./memory-context-adapter.js";

type SpawnArgs = {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnSyncOptionsWithStringEncoding;
};

type FakeSpawnFactory = (
  args: SpawnArgs,
) => Partial<SpawnSyncReturns<string>> | undefined;

function buildSpawn(
  responses: FakeSpawnFactory | ReadonlyArray<Partial<SpawnSyncReturns<string>> | undefined>,
) {
  const calls: SpawnArgs[] = [];
  let index = 0;
  const factory: FakeSpawnFactory =
    typeof responses === "function"
      ? responses
      : () => {
          const next = responses[index] ?? responses[responses.length - 1];
          index += 1;
          return next;
        };

  const fn = vi.fn(
    (
      command: string,
      args: ReadonlyArray<string>,
      options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => {
      const call: SpawnArgs = { command, args, options };
      calls.push(call);
      const partial = factory(call) ?? {};
      const stdout = partial.stdout ?? "";
      const stderr = partial.stderr ?? "";
      const status = partial.status ?? 0;
      return {
        pid: 0,
        status,
        signal: partial.signal ?? null,
        output: ["", stdout, stderr],
        stdout,
        stderr,
        error: partial.error,
      } as SpawnSyncReturns<string>;
    },
  );

  return {
    fn: fn as unknown as MemoryContextAdapterDeps["spawnSync"],
    mock: fn,
    calls,
  };
}

function makeAdapter(
  env: NodeJS.ProcessEnv,
  spawn: MemoryContextAdapterDeps["spawnSync"],
  log: (msg: string) => void = vi.fn(),
) {
  return {
    adapter: createMemoryContextAdapter({ env, spawnSync: spawn, log }),
    log: log as ReturnType<typeof vi.fn>,
  };
}

describe("createMemoryContextAdapter", () => {
  it("returns empty string and skips subprocess when disabled (default)", async () => {
    const spawn = buildSpawn(() => ({ stdout: "should not run" }));
    const { adapter } = makeAdapter({}, spawn.fn);

    const result = await adapter.resolveContext("hello");

    expect(result).toBe("");
    expect(spawn.mock).not.toHaveBeenCalled();
  });

  it("returns empty string when explicitly disabled and ignores other vars", async () => {
    const spawn = buildSpawn(() => ({ stdout: "should not run" }));
    const { adapter } = makeAdapter(
      {
        OPENCLAW_MEMORY_ENABLED: "false",
        OPENCLAW_MEMORY_PYTHON: "/usr/bin/python3",
      },
      spawn.fn,
    );

    expect(await adapter.resolveContext("hello")).toBe("");
    expect(spawn.mock).not.toHaveBeenCalled();
  });

  it("returns empty string for empty/whitespace queries without spawning", async () => {
    const spawn = buildSpawn(() => ({ stdout: "should not run" }));
    const { adapter } = makeAdapter({ OPENCLAW_MEMORY_ENABLED: "true" }, spawn.fn);

    expect(await adapter.resolveContext("")).toBe("");
    expect(await adapter.resolveContext("   \n\t  ")).toBe("");
    expect(spawn.mock).not.toHaveBeenCalled();
  });

  it("invokes the memory CLI and returns stdout when enabled", async () => {
    const spawn = buildSpawn(() => ({ stdout: "memory block\n" }));
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_MEMORY_ENABLED: "1",
      OPENCLAW_MEMORY_CORE_DSN: "postgres://example",
      OPENCLAW_EMBEDDING_ENGINE: "embeddinggemma_300m_v1",
    };
    const { adapter } = makeAdapter(env, spawn.fn);

    const result = await adapter.resolveContext("  what is foo?  ");

    expect(result).toBe("memory block");
    expect(spawn.mock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.mock.calls[0]!;
    expect(command).toBe("python");
    expect(args).toEqual([
      "-m",
      "openclaw_memory_core.integration.memory_context_cli",
      "--query",
      "what is foo?",
    ]);
    expect(options.encoding).toBe("utf-8");
    expect(options.timeout).toBe(3000);
    expect(options.env).toBe(env);
  });

  it("respects OPENCLAW_MEMORY_PYTHON override", async () => {
    const spawn = buildSpawn(() => ({ stdout: "ctx" }));
    const { adapter } = makeAdapter(
      {
        OPENCLAW_MEMORY_ENABLED: "true",
        OPENCLAW_MEMORY_PYTHON: "  /opt/py/bin/python3  ",
      },
      spawn.fn,
    );

    await adapter.resolveContext("query");
    expect(spawn.mock.mock.calls[0]?.[0]).toBe("/opt/py/bin/python3");
  });

  it("respects OPENCLAW_MEMORY_TIMEOUT_MS override", async () => {
    const spawn = buildSpawn(() => ({ stdout: "ctx" }));
    const { adapter } = makeAdapter(
      {
        OPENCLAW_MEMORY_ENABLED: "true",
        OPENCLAW_MEMORY_TIMEOUT_MS: "750",
      },
      spawn.fn,
    );

    await adapter.resolveContext("query");
    expect(spawn.mock.mock.calls[0]?.[2].timeout).toBe(750);
  });

  it("falls back to default timeout for malformed values", async () => {
    const spawn = buildSpawn(() => ({ stdout: "ctx" }));
    const { adapter } = makeAdapter(
      {
        OPENCLAW_MEMORY_ENABLED: "true",
        OPENCLAW_MEMORY_TIMEOUT_MS: "not-a-number",
      },
      spawn.fn,
    );

    await adapter.resolveContext("query");
    expect(spawn.mock.mock.calls[0]?.[2].timeout).toBe(3000);
  });

  it("caps stdout to OPENCLAW_MEMORY_MAX_CHARS defensively", async () => {
    const longText = "a".repeat(10_000);
    const spawn = buildSpawn(() => ({ stdout: longText }));
    const { adapter } = makeAdapter(
      {
        OPENCLAW_MEMORY_ENABLED: "true",
        OPENCLAW_MEMORY_MAX_CHARS: "1024",
      },
      spawn.fn,
    );

    const result = await adapter.resolveContext("query");
    expect(result.length).toBe(1024);
    expect(result).toBe("a".repeat(1024));
  });

  it("returns empty when CLI exits 0 with empty stdout", async () => {
    const spawn = buildSpawn(() => ({ stdout: "  \n  " }));
    const { adapter, log } = makeAdapter({ OPENCLAW_MEMORY_ENABLED: "true" }, spawn.fn);

    expect(await adapter.resolveContext("query")).toBe("");
    expect(log).not.toHaveBeenCalled();
  });

  it("fails open and logs when CLI exits non-zero (strict=false)", async () => {
    const spawn = buildSpawn(() => ({
      status: 2,
      stdout: "",
      stderr: "boom: something happened\nmore detail",
    }));
    const { adapter, log } = makeAdapter({ OPENCLAW_MEMORY_ENABLED: "true" }, spawn.fn);

    expect(await adapter.resolveContext("query")).toBe("");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("memory CLI exited 2");
    expect(log.mock.calls[0]?.[0]).toContain("boom: something happened");
  });

  it("throws MemoryContextError in strict mode on non-zero exit", async () => {
    const spawn = buildSpawn(() => ({ status: 3, stderr: "strict failure" }));
    const { adapter } = makeAdapter(
      { OPENCLAW_MEMORY_ENABLED: "true", OPENCLAW_MEMORY_STRICT: "true" },
      spawn.fn,
    );

    await expect(adapter.resolveContext("query")).rejects.toBeInstanceOf(MemoryContextError);
  });

  it("fails open on ENOENT (python not found)", async () => {
    const spawn = buildSpawn(() => ({
      error: Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
    }));
    const { adapter, log } = makeAdapter(
      { OPENCLAW_MEMORY_ENABLED: "true", OPENCLAW_MEMORY_PYTHON: "missing-python" },
      spawn.fn,
    );

    expect(await adapter.resolveContext("query")).toBe("");
    expect(log.mock.calls[0]?.[0]).toContain("python not found: missing-python");
  });

  it("throws in strict mode on ENOENT", async () => {
    const spawn = buildSpawn(() => ({
      error: Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
    }));
    const { adapter } = makeAdapter(
      {
        OPENCLAW_MEMORY_ENABLED: "true",
        OPENCLAW_MEMORY_STRICT: "true",
      },
      spawn.fn,
    );

    await expect(adapter.resolveContext("query")).rejects.toThrow(MemoryContextError);
  });

  it("treats spawn timeout (signal SIGTERM) as fail-open in non-strict mode", async () => {
    const spawn = buildSpawn(() => ({ signal: "SIGTERM", stdout: "", stderr: "" }));
    const { adapter, log } = makeAdapter(
      { OPENCLAW_MEMORY_ENABLED: "true", OPENCLAW_MEMORY_TIMEOUT_MS: "1" },
      spawn.fn,
    );

    expect(await adapter.resolveContext("query")).toBe("");
    expect(log.mock.calls[0]?.[0]).toMatch(/killed by signal SIGTERM/);
  });

  it("treats ETIMEDOUT spawn error as timeout", async () => {
    const spawn = buildSpawn(() => ({
      error: Object.assign(new Error("etimedout"), {
        code: "ETIMEDOUT",
      }) as NodeJS.ErrnoException,
    }));
    const { adapter, log } = makeAdapter({ OPENCLAW_MEMORY_ENABLED: "true" }, spawn.fn);

    expect(await adapter.resolveContext("query")).toBe("");
    expect(log.mock.calls[0]?.[0]).toContain("memory CLI timed out");
  });

  it("catches synchronous spawn throws and fails open", async () => {
    const spawn = vi.fn(() => {
      throw new Error("synchronous boom");
    }) as unknown as MemoryContextAdapterDeps["spawnSync"];
    const { adapter, log } = makeAdapter({ OPENCLAW_MEMORY_ENABLED: "true" }, spawn);

    expect(await adapter.resolveContext("query")).toBe("");
    expect(log.mock.calls[0]?.[0]).toContain("synchronous boom");
  });

  it("propagates synchronous spawn throws as MemoryContextError in strict mode", async () => {
    const cause = new Error("synchronous boom");
    const spawn = vi.fn(() => {
      throw cause;
    }) as unknown as MemoryContextAdapterDeps["spawnSync"];
    const { adapter } = makeAdapter(
      { OPENCLAW_MEMORY_ENABLED: "true", OPENCLAW_MEMORY_STRICT: "true" },
      spawn,
    );

    await expect(adapter.resolveContext("query")).rejects.toMatchObject({
      name: "MemoryContextError",
      cause,
    });
  });

  it("passes the entire env object through to spawnSync", async () => {
    const spawn = buildSpawn(() => ({ stdout: "ctx" }));
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_MEMORY_ENABLED: "true",
      OPENCLAW_MEMORY_CORE_DSN: "postgres://x",
      OPENCLAW_MEMORY_CORE_PASSWORD: "secret",
      OPENCLAW_EMBEDDING_ENGINE: "embeddinggemma_300m_v1",
      EMBEDDING_MODEL_PATH: "/models/embeddinggemma",
      EMBEDDING_DEVICE: "cpu",
      PATH: "/usr/bin",
    };
    const { adapter } = makeAdapter(env, spawn.fn);

    await adapter.resolveContext("query");
    expect(spawn.mock.mock.calls[0]?.[2].env).toBe(env);
  });
});
