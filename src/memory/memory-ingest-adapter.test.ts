import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMemoryIngestDebugBannerForTests,
  containsForbiddenSubstring,
  createMemoryIngestAdapter,
  extractContent,
  matchTrigger,
  MemoryIngestError,
  previewText,
  type MemoryIngestAdapterDeps,
  type SpawnFn,
} from "./memory-ingest-adapter.js";

type SpawnCall = {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnOptions;
};

type FakeChild = ChildProcess & {
  /** Fire `error` and synchronously bypass `close` (matches node's behavior on spawn failure). */
  emitError: (err: NodeJS.ErrnoException) => void;
  /** Fire `close` with optional code/signal. */
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  killed: boolean;
};

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  const stdoutEmitter = new EventEmitter() as unknown as NodeJS.ReadableStream;
  const stderrEmitter = new EventEmitter() as unknown as NodeJS.ReadableStream;
  // The adapter calls `setEncoding`; provide a no-op so the call site is
  // observable but does not crash.
  (stdoutEmitter as { setEncoding: (e: string) => void }).setEncoding = () => {};
  (stderrEmitter as { setEncoding: (e: string) => void }).setEncoding = () => {};
  (emitter as unknown as { stdout: NodeJS.ReadableStream }).stdout = stdoutEmitter;
  (emitter as unknown as { stderr: NodeJS.ReadableStream }).stderr = stderrEmitter;
  emitter.killed = false;
  emitter.kill = ((signal?: NodeJS.Signals | number) => {
    emitter.killed = true;
    void signal;
    return true;
  }) as ChildProcess["kill"];
  emitter.emitError = (err) => emitter.emit("error", err);
  emitter.emitClose = (code, signal = null) => emitter.emit("close", code, signal);
  emitter.emitStdout = (chunk) => stdoutEmitter.emit("data", chunk);
  emitter.emitStderr = (chunk) => stderrEmitter.emit("data", chunk);
  return emitter;
}

function buildSpawn(): {
  spawn: SpawnFn;
  calls: SpawnCall[];
  child: FakeChild;
  childRef: { value: FakeChild };
} {
  const calls: SpawnCall[] = [];
  const childRef = { value: createFakeChild() };
  const spawnFn = vi.fn(
    (command: string, args: ReadonlyArray<string>, options: SpawnOptions): ChildProcess => {
      calls.push({ command, args, options });
      childRef.value = createFakeChild();
      return childRef.value;
    },
  );
  const proxy: SpawnFn = (...args) => spawnFn(...(args as Parameters<SpawnFn>));
  return {
    spawn: proxy,
    calls,
    get child(): FakeChild {
      return childRef.value;
    },
    childRef,
  } as ReturnType<typeof buildSpawn>;
}

function makeAdapter(
  env: NodeJS.ProcessEnv,
  spawn: SpawnFn,
  log: (msg: string) => void = vi.fn(),
  extra: Partial<MemoryIngestAdapterDeps> = {},
) {
  return {
    adapter: createMemoryIngestAdapter({ env, spawn, log, ...extra }),
    log: log as ReturnType<typeof vi.fn>,
  };
}

const ENABLED_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_MEMORY_ENABLED: "true",
  OPENCLAW_MEMORY_INGEST_GRACE_MS: "500",
  OPENCLAW_MEMORY_INGEST_TIMEOUT_MS: "30000",
};

describe("matchTrigger", () => {
  it("matches the longest trigger first", () => {
    expect(matchTrigger("remember this as semantic memory: foo")).toBe(
      "remember this as semantic memory",
    );
    expect(matchTrigger("Save this as Semantic Memory: bar")).toBe("save this as semantic memory");
    expect(matchTrigger("REMEMBER THIS: value")).toBe("remember this");
    expect(matchTrigger("save this :: value")).toBe("save this");
  });

  it("tolerates leading whitespace", () => {
    expect(matchTrigger("  \n  remember this: x")).toBe("remember this");
  });

  it("returns null for non-matching prefixes", () => {
    expect(matchTrigger("please remember this")).toBeNull();
    expect(matchTrigger("hello world")).toBeNull();
    expect(matchTrigger("")).toBeNull();
  });
});

describe("extractContent", () => {
  it("returns the text after a single colon, trimmed", () => {
    expect(extractContent("Remember this: ORANGE FALCON 246", "remember this")).toBe(
      "ORANGE FALCON 246",
    );
  });

  it("returns the text after a double colon", () => {
    expect(extractContent("save this:: phrase", "save this")).toBe("phrase");
  });

  it("falls back to the original (trimmed) text when no colon is present", () => {
    expect(extractContent("remember this orange falcon 246", "remember this")).toBe(
      "remember this orange falcon 246",
    );
  });

  it("preserves only the first split when multiple colons are present", () => {
    expect(extractContent("Remember this: alpha: beta: gamma", "remember this")).toBe(
      "alpha: beta: gamma",
    );
  });
});

describe("containsForbiddenSubstring", () => {
  it("flags <memory_context> presence", () => {
    expect(containsForbiddenSubstring("...<memory_context>...")).toBe(true);
  });
  it("flags <user_request> presence", () => {
    expect(containsForbiddenSubstring("hi <user_request> bye")).toBe(true);
  });
  it("returns false for plain text", () => {
    expect(containsForbiddenSubstring("save this: ORANGE FALCON 246")).toBe(false);
  });
});

describe("createMemoryIngestAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns skipped:disabled when memory is disabled (default)", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter({}, spawn.spawn);

    const result = await adapter.ingest("Remember this: foo");
    expect(result.status).toBe("skipped:disabled");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:empty for empty/whitespace input", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    expect((await adapter.ingest("")).status).toBe("skipped:empty");
    expect((await adapter.ingest("   \t\n ")).status).toBe("skipped:empty");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:wrapped when input contains <memory_context>", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const result = await adapter.ingest(
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nremember this: foo\n</user_request>",
    );
    expect(result.status).toBe("skipped:wrapped");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:wrapped when input contains <user_request> alone", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const result = await adapter.ingest("save this: <user_request>nested</user_request>");
    expect(result.status).toBe("skipped:wrapped");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:no_trigger when no save-memory phrase is found", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const result = await adapter.ingest("hello there, please tell me about memory");
    expect(result.status).toBe("skipped:no_trigger");
    expect(spawn.calls).toHaveLength(0);
  });

  it("spawns the memory_ingest_cli with --source-type memory --content <text> and python3 by default", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CORE_DSN: "postgres://example",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("Remember this as semantic memory: ORANGE FALCON 246.");

    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0]!;
    expect(call.command).toBe("python3");
    expect(call.args).toEqual([
      "-m",
      "openclaw_memory_core.integration.memory_ingest_cli",
      "--source-type",
      "memory",
      "--content",
      "ORANGE FALCON 246.",
    ]);
    expect(call.options.env).toBe(env);

    spawn.childRef.value.emitClose(0);
    const result = await promise;
    expect(result.status).toBe("succeeded");
  });

  it("respects OPENCLAW_MEMORY_PYTHON override", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_PYTHON: "  /opt/py/bin/python3  ",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls[0]?.command).toBe("/opt/py/bin/python3");

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("fails open and logs when CLI exits non-zero within grace (strict=false)", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn, log);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitStderr("boom: bad things\nmore detail");
    spawn.childRef.value.emitClose(2);

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("memory ingest exited 2");
    expect(result.reason).toContain("boom: bad things");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("memory ingest exited 2");
  });

  it("throws MemoryIngestError in strict mode on non-zero exit within grace", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_STRICT: "true",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitStderr("strict failure");
    spawn.childRef.value.emitClose(3);

    await expect(promise).rejects.toBeInstanceOf(MemoryIngestError);
  });

  it("fails open on ENOENT (python not found)", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_PYTHON: "missing-python",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitError(
      Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
    );

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("python not found: missing-python");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("python not found: missing-python");
  });

  it("throws in strict mode on ENOENT", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_STRICT: "true",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitError(
      Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
    );

    await expect(promise).rejects.toMatchObject({
      name: "MemoryIngestError",
      message: expect.stringContaining("python not found"),
    });
  });

  it("returns detached when the child stays alive past the grace window and continues in background", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_INGEST_GRACE_MS: "500",
      OPENCLAW_MEMORY_INGEST_TIMEOUT_MS: "30000",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.ingest("Remember this as semantic memory: long-task");
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result.status).toBe("detached");
    expect(spawn.childRef.value.killed).toBe(false);

    spawn.childRef.value.emitClose(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("memory ingest finished after detach"),
    );
  });

  it("kills the child with SIGTERM when the full timeout elapses after detach", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_INGEST_GRACE_MS: "100",
      OPENCLAW_MEMORY_INGEST_TIMEOUT_MS: "1000",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("save this: stalls forever");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.status).toBe("detached");

    expect(spawn.childRef.value.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(900);
    expect(spawn.childRef.value.killed).toBe(true);
  });

  it("does not surface post-detach failures as strict-mode throws", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_STRICT: "true",
      OPENCLAW_MEMORY_INGEST_GRACE_MS: "100",
      OPENCLAW_MEMORY_INGEST_TIMEOUT_MS: "5000",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.ingest("save this: post-detach failure");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.status).toBe("detached");

    spawn.childRef.value.emitClose(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("memory ingest finished after detach"),
    );
  });

  it("catches synchronous spawn throws and fails open", async () => {
    const synchronousSpawn: SpawnFn = vi.fn(() => {
      throw new Error("spawn boom");
    });
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, synchronousSpawn, log);

    const result = await adapter.ingest("save this: anything");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("spawn boom");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("propagates synchronous spawn throws as MemoryIngestError in strict mode", async () => {
    const cause = new Error("spawn boom");
    const synchronousSpawn: SpawnFn = vi.fn(() => {
      throw cause;
    });
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_STRICT: "true",
    };
    const { adapter } = makeAdapter(env, synchronousSpawn);

    await expect(adapter.ingest("save this: anything")).rejects.toMatchObject({
      name: "MemoryIngestError",
      cause,
    });
  });

  it("clamps grace > timeout to the timeout value (defensive)", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_INGEST_GRACE_MS: "10000",
      OPENCLAW_MEMORY_INGEST_TIMEOUT_MS: "200",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("save this: stalls");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result.status).toBe("detached");
  });

  it("treats SIGTERM signal as timeout in non-strict mode", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn, log);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emit("close", null, "SIGTERM");

    const result = await promise;
    expect(result.status).toBe("timeout");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("killed by signal SIGTERM"));
  });

  it("passes the entire env object through to spawn", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CORE_DSN: "postgres://x",
      OPENCLAW_MEMORY_CORE_PASSWORD: "secret",
      EMBEDDING_MODEL_PATH: "/models/embeddinggemma",
      EMBEDDING_DEVICE: "cpu",
      PATH: "/usr/bin",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.ingest("save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls[0]?.options.env).toBe(env);
    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("hard-caps the content length passed to the CLI to bound stdin", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const longContent = "x".repeat(20000);
    const promise = adapter.ingest(`save this: ${longContent}`);
    await vi.advanceTimersByTimeAsync(0);
    const passedContent = spawn.calls[0]?.args[5] ?? "";
    expect(passedContent.length).toBe(16_000);
    expect(passedContent).toBe("x".repeat(16_000));
    spawn.childRef.value.emitClose(0);
    await promise;
  });
});

describe("previewText", () => {
  it("returns empty string for empty/non-string inputs", () => {
    expect(previewText("", 100)).toBe("");
    expect(previewText("hello", 0)).toBe("");
  });

  it("collapses internal whitespace and trims", () => {
    expect(previewText("  hello   world\n  again  ", 100)).toBe("hello world again");
  });

  it("caps to maxChars and appends ellipsis", () => {
    const long = "abcdefghij".repeat(40);
    const out = previewText(long, 50);
    expect(out.length).toBe(53);
    expect(out.endsWith("...")).toBe(true);
  });

  it("does not append ellipsis if input fits", () => {
    expect(previewText("short", 50)).toBe("short");
  });
});

describe("debug logging (OPENCLAW_MEMORY_DEBUG=true)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetMemoryIngestDebugBannerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetMemoryIngestDebugBannerForTests();
  });

  const DEBUG_ENV: NodeJS.ProcessEnv = {
    ...ENABLED_ENV,
    OPENCLAW_MEMORY_DEBUG: "true",
  };

  it("emits no debug logs and does not spawn when memory is disabled", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    // Disabled: only OPENCLAW_MEMORY_DEBUG is on.
    const { adapter } = makeAdapter({ OPENCLAW_MEMORY_DEBUG: "true" }, spawn.spawn, log);

    const result = await adapter.ingest("Remember this: foo");
    expect(result.status).toBe("skipped:disabled");
    expect(spawn.calls).toHaveLength(0);
    expect(
      log.mock.calls.some(([msg]) => /status=skipped:disabled .*spawned=false/.test(String(msg))),
    ).toBe(true);
  });

  it("emits debug logs and does not spawn for no-trigger input", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(DEBUG_ENV, spawn.spawn, log);

    const result = await adapter.ingest("hello there");
    expect(result.status).toBe("skipped:no_trigger");
    expect(spawn.calls).toHaveLength(0);
    expect(
      log.mock.calls.some(([msg]) => /status=skipped:no_trigger .*spawned=false/.test(String(msg))),
    ).toBe(true);
  });

  it("emits debug logs and does not spawn for already-wrapped input", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(DEBUG_ENV, spawn.spawn, log);

    const result = await adapter.ingest(
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nremember this: foo\n</user_request>",
    );
    expect(result.status).toBe("skipped:wrapped");
    expect(spawn.calls).toHaveLength(0);
    expect(
      log.mock.calls.some(([msg]) => /status=skipped:wrapped .*spawned=false/.test(String(msg))),
    ).toBe(true);
  });

  it("emits a final debug log with status, reason, and spawned=true on a successful spawn", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(DEBUG_ENV, spawn.spawn, log);

    const promise = adapter.ingest("Remember this as semantic memory: ORANGE FALCON 246");
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls).toHaveLength(1);

    spawn.childRef.value.emitStdout("ok\n");
    spawn.childRef.value.emitClose(0);
    const result = await promise;
    expect(result.status).toBe("succeeded");

    // Stable guarantees only:
    expect(log.mock.calls.some(([msg]) => /status=succeeded /.test(String(msg)))).toBe(true);
    expect(log.mock.calls.some(([msg]) => /spawned=true/.test(String(msg)))).toBe(true);
  });

  it("emits debug logs surrounding a non-zero exit (status=failed) and still fails open", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(DEBUG_ENV, spawn.spawn, log);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitStderr("boom\n");
    spawn.childRef.value.emitClose(2);
    const result = await promise;
    expect(result.status).toBe("failed");

    expect(log.mock.calls.some(([msg]) => /status=failed /.test(String(msg)))).toBe(true);
    expect(log.mock.calls.some(([msg]) => /spawned=true/.test(String(msg)))).toBe(true);
    // Subprocess close breadcrumb surfaces code/signal at debug, but we do
    // not assert the full sequence to avoid overfitting.
    expect(log.mock.calls.some(([msg]) => /subprocess close .*code=2/.test(String(msg)))).toBe(
      true,
    );
  });

  it("logs only the basename when OPENCLAW_MEMORY_PYTHON is an absolute path", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...DEBUG_ENV,
      OPENCLAW_MEMORY_PYTHON: "/Users/who/.venv/bin/python3",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.ingest("save this: alpha");
    await vi.advanceTimersByTimeAsync(0);

    const subprocessStart = log.mock.calls.find(([msg]) =>
      /subprocess starting /.test(String(msg)),
    );
    expect(subprocessStart).toBeDefined();
    const startMsg = String(subprocessStart?.[0]);
    expect(startMsg).toContain("python=python3");
    expect(startMsg).not.toContain("/Users/who");
    expect(startMsg).not.toContain(".venv/bin");

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("emits no debug logs when OPENCLAW_MEMORY_DEBUG is unset (default)", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn, log);

    const promise = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await promise;

    // Only operational messages allowed (e.g. failure logs); no [memory-ingest] breadcrumbs.
    expect(log.mock.calls.some(([msg]) => String(msg).startsWith("[memory-ingest]"))).toBe(false);
  });

  it("caps content previews in extracted-content debug breadcrumb", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(DEBUG_ENV, spawn.spawn, log);

    const longContent = "y".repeat(2000);
    const promise = adapter.ingest(`save this: ${longContent}`);
    await vi.advanceTimersByTimeAsync(0);

    const extracted = log.mock.calls.find(([msg]) => /extractedPreview=/.test(String(msg)));
    expect(extracted).toBeDefined();
    const extractedMsg = String(extracted?.[0]);
    const m = extractedMsg.match(/extractedPreview="([^"]*)"/);
    expect(m).not.toBeNull();
    if (m) {
      // 300-char cap + "..." marker when input was longer.
      expect(m[1]?.endsWith("...")).toBe(true);
      expect((m[1] ?? "").length).toBeLessThanOrEqual(303);
    }

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("emits the [memory-ingest] debug logging enabled banner exactly once across multiple ingests", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(DEBUG_ENV, spawn.spawn, log);

    // First ingest should emit the banner.
    const first = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await first;

    // Second ingest must not re-emit it.
    const second = adapter.ingest("Save this: beta");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await second;

    const bannerHits = log.mock.calls.filter(
      ([msg]) => String(msg) === "[memory-ingest] debug logging enabled",
    );
    expect(bannerHits).toHaveLength(1);
  });

  it("does not emit the banner when OPENCLAW_MEMORY_DEBUG is unset", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn, log);

    const first = adapter.ingest("Save this: alpha");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await first;

    const second = adapter.ingest("Save this: beta");
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await second;

    const bannerHits = log.mock.calls.filter(
      ([msg]) => String(msg) === "[memory-ingest] debug logging enabled",
    );
    expect(bannerHits).toHaveLength(0);
  });
});
