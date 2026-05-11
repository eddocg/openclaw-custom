import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMemoryCandidateQueueDebugBannerForTests,
  createMemoryCandidateQueueAdapter,
  extractQueuePayload,
  findQueueTrigger,
  MemoryCandidateQueueError,
  type MemoryCandidateQueueAdapterDeps,
} from "./memory-candidate-queue-adapter.js";
import type { SpawnFn } from "./memory-ingest-adapter.js";

type SpawnCall = {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnOptions;
};

type FakeChild = ChildProcess & {
  emitError: (err: NodeJS.ErrnoException) => void;
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  killed: boolean;
};

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  const stdoutEmitter = new EventEmitter() as unknown as NodeJS.ReadableStream;
  const stderrEmitter = new EventEmitter() as unknown as NodeJS.ReadableStream;
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
  extra: Partial<MemoryCandidateQueueAdapterDeps> = {},
) {
  return {
    adapter: createMemoryCandidateQueueAdapter({
      env,
      spawn,
      log,
      randomId: () => "test-random-id",
      ...extra,
    }),
    log: log as ReturnType<typeof vi.fn>,
  };
}

const ENABLED_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED: "true",
  OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS: "500",
  OPENCLAW_MEMORY_CANDIDATE_QUEUE_TIMEOUT_MS: "30000",
};

describe("findQueueTrigger", () => {
  it("matches `queue memory:` at the start of input", () => {
    expect(findQueueTrigger("queue memory: foo")).toEqual({ index: 0 });
    expect(findQueueTrigger("Queue Memory: foo")).toEqual({ index: 0 });
  });

  it("tolerates leading whitespace and resolves the absolute index", () => {
    expect(findQueueTrigger("  \n  queue memory: bar")).toEqual({ index: 5 });
  });

  it("tolerates whitespace between the trigger token and the colon", () => {
    expect(findQueueTrigger("queue memory : bar")).toEqual({ index: 0 });
  });

  it("matches in a wrapped channel-style prompt with metadata blocks", () => {
    const wrapped = [
      "Conversation info (untrusted metadata):",
      "```json",
      `{"chat_id":"abc"}`,
      "```",
      "",
      "Queue memory: The project uses pgvector for semantic memory.",
    ].join("\n");
    const result = findQueueTrigger(wrapped);
    expect(result).not.toBeNull();
    expect(wrapped.toLowerCase().slice(result?.index)).toMatch(/^queue memory:/);
  });

  it("rejects mid-prose 'please queue memory:'", () => {
    expect(findQueueTrigger("please queue memory: x")).toBeNull();
    expect(findQueueTrigger("hello world. please queue memory: x")).toBeNull();
  });

  it("rejects when no colon follows the trigger token", () => {
    expect(findQueueTrigger("queue memory please")).toBeNull();
    expect(findQueueTrigger("queue memory\n")).toBeNull();
  });

  it("rejects matches outside the 1000-char scan window", () => {
    const filler = "x".repeat(1100);
    expect(findQueueTrigger(`${filler}\nQueue memory: TOO LATE`)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(findQueueTrigger("")).toBeNull();
  });
});

describe("extractQueuePayload", () => {
  it("returns the post-colon payload trimmed", () => {
    expect(extractQueuePayload("Queue memory: ORANGE FALCON 246", 0)).toBe("ORANGE FALCON 246");
  });

  it("accepts a double colon", () => {
    expect(extractQueuePayload("queue memory:: phrase", 0)).toBe("phrase");
  });

  it("returns '' when the trigger is not followed by a colon", () => {
    expect(extractQueuePayload("queue memory please", 0)).toBe("");
  });

  it("uses the provided trigger index in wrapped prompts", () => {
    const wrapped = "metadata blob\n\nqueue memory: orange falcon";
    const idx = wrapped.toLowerCase().indexOf("queue memory");
    expect(extractQueuePayload(wrapped, idx)).toBe("orange falcon");
  });
});

describe("createMemoryCandidateQueueAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns skipped:disabled when the queue is disabled (default)", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter({}, spawn.spawn);

    const result = await adapter.enqueue("queue memory: foo");
    expect(result.status).toBe("skipped:disabled");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:empty for empty/whitespace input", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    expect((await adapter.enqueue("")).status).toBe("skipped:empty");
    expect((await adapter.enqueue("   \t\n ")).status).toBe("skipped:empty");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:no_trigger when no 'queue memory:' phrase is found", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const result = await adapter.enqueue("hello there, please tell me about memory");
    expect(result.status).toBe("skipped:no_trigger");
    expect(spawn.calls).toHaveLength(0);
  });

  it("does not trigger on mid-prose 'please queue memory:'", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const result = await adapter.enqueue("please queue memory: foo bar");
    expect(result.status).toBe("skipped:no_trigger");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:empty when the trigger has no payload after the colon", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    expect((await adapter.enqueue("queue memory:")).status).toBe("skipped:empty");
    expect((await adapter.enqueue("queue memory:    ")).status).toBe("skipped:empty");
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns skipped:wrapped when input contains <memory_context>", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const result = await adapter.enqueue(
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nqueue memory: foo\n</user_request>",
    );
    expect(result.status).toBe("skipped:wrapped");
    expect(spawn.calls).toHaveLength(0);
  });

  it("spawns the candidate queue CLI with the enqueue-pipeline subcommand and expected args", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CORE_DSN: "postgres://example",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.enqueue("Queue memory: Never work directly on main.", {
      source: "discord",
      candidateId: "discord:msg:42",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0]!;
    expect(call.command).toBe("python3");
    expect(call.args).toEqual([
      "-m",
      "openclaw_memory_core.integration.memory_candidate_queue_cli",
      "enqueue-pipeline",
      "--text",
      "Never work directly on main.",
      "--source",
      "discord",
      "--candidate-id",
      "discord:msg:42",
      "--json",
    ]);
    expect(call.options.env).toBe(env);

    spawn.childRef.value.emitClose(0);
    const result = await promise;
    expect(result.status).toBe("succeeded");
    expect(result.candidateId).toBe("discord:msg:42");
    expect(result.source).toBe("discord");
  });

  it("is case-insensitive on the trigger", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const promise = adapter.enqueue("QUEUE MEMORY: ALPHA", { candidateId: "c-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls).toHaveLength(1);
    const payloadArg = spawn.calls[0]?.args[4];
    expect(payloadArg).toBe("ALPHA");

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("honors OPENCLAW_MEMORY_PYTHON override", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_PYTHON: "  /opt/py/bin/python3  ",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls[0]?.command).toBe("/opt/py/bin/python3");

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("forwards the entire env object to spawn (including OPENCLAW_MEMORY_CORE_DSN)", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CORE_DSN: "postgres://x",
      OPENCLAW_MEMORY_CORE_PASSWORD: "secret",
      PATH: "/usr/bin",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-env" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls[0]?.options.env).toBe(env);

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("passes through caller-provided candidateId verbatim", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const promise = adapter.enqueue("queue memory: alpha", {
      candidateId: "discord:msg:abc-123",
      source: "discord",
    });
    await vi.advanceTimersByTimeAsync(0);
    const args = spawn.calls[0]?.args ?? [];
    const idx = args.indexOf("--candidate-id");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("discord:msg:abc-123");

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("falls back to a stable candidateId derived from source+sessionKey+requestId and never includes the message text", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const payload = "ULTRA-SECRET PHRASE 9134";
    const promise = adapter.enqueue(`queue memory: ${payload}`, {
      source: "acp",
      sessionKey: "agent:codex:acp:s-1",
      requestId: "r-7",
    });
    await vi.advanceTimersByTimeAsync(0);

    const args = spawn.calls[0]?.args ?? [];
    const idx = args.indexOf("--candidate-id");
    expect(idx).toBeGreaterThanOrEqual(0);
    const candidateId = String(args[idx + 1]);
    expect(candidateId).toContain("acp");
    expect(candidateId).toContain("r-7");
    expect(candidateId).not.toContain(payload);
    expect(candidateId).not.toContain("9134");

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("prefers context.source over context.provider over the 'runtime' default", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const p1 = adapter.enqueue("queue memory: a", {
      source: "telegram",
      provider: "openai",
      candidateId: "c-a",
    });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await p1;

    const p2 = adapter.enqueue("queue memory: b", { provider: "openai", candidateId: "c-b" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await p2;

    const p3 = adapter.enqueue("queue memory: c", { candidateId: "c-c" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await p3;

    const sources = spawn.calls.map((c) => {
      const i = c.args.indexOf("--source");
      return c.args[i + 1];
    });
    expect(sources).toEqual(["telegram", "openai", "runtime"]);
  });

  it("fails open and logs when CLI exits non-zero within grace (strict=false)", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn, log);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-fail" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitStderr("boom: bad things\nmore detail");
    spawn.childRef.value.emitClose(2);

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("memory candidate queue exited 2");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("memory candidate queue exited 2");
  });

  it("throws MemoryCandidateQueueError in strict mode on non-zero exit", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_STRICT: "true",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-strict" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(3);

    await expect(promise).rejects.toBeInstanceOf(MemoryCandidateQueueError);
  });

  it("fails open on ENOENT (python not found)", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_PYTHON: "missing-python",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-enoent" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitError(
      Object.assign(new Error("not found"), { code: "ENOENT" }) as NodeJS.ErrnoException,
    );

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("python not found: missing-python");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("returns detached when the child stays alive past the grace window", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS: "500",
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_TIMEOUT_MS: "30000",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.enqueue("queue memory: long-task", { candidateId: "c-detach" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result.status).toBe("detached");
    expect(spawn.childRef.value.killed).toBe(false);

    spawn.childRef.value.emitClose(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("memory candidate queue finished after detach"),
    );
  });

  it("kills the child with SIGTERM when the full timeout elapses after detach", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS: "100",
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_TIMEOUT_MS: "1000",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.enqueue("queue memory: stalls forever", { candidateId: "c-timeout" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.status).toBe("detached");

    expect(spawn.childRef.value.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(900);
    expect(spawn.childRef.value.killed).toBe(true);
  });

  it("treats SIGTERM signal as timeout in non-strict mode", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn, log);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-sigterm" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emit("close", null, "SIGTERM");

    const result = await promise;
    expect(result.status).toBe("timeout");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("killed by signal SIGTERM"));
  });

  it("hard-caps content length passed to the CLI", async () => {
    const spawn = buildSpawn();
    const { adapter } = makeAdapter(ENABLED_ENV, spawn.spawn);

    const longContent = "x".repeat(20_000);
    const promise = adapter.enqueue(`queue memory: ${longContent}`, { candidateId: "c-cap" });
    await vi.advanceTimersByTimeAsync(0);
    const args = spawn.calls[0]?.args ?? [];
    const idxText = args.indexOf("--text");
    const payload = String(args[idxText + 1] ?? "");
    expect(payload.length).toBe(16_000);
    expect(payload).toBe("x".repeat(16_000));

    spawn.childRef.value.emitClose(0);
    await promise;
  });

  it("catches synchronous spawn throws and fails open", async () => {
    const synchronousSpawn: SpawnFn = vi.fn(() => {
      throw new Error("spawn boom");
    });
    const log = vi.fn();
    const { adapter } = makeAdapter(ENABLED_ENV, synchronousSpawn, log);

    const result = await adapter.enqueue("queue memory: anything", { candidateId: "c-sync" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("spawn boom");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("propagates synchronous spawn throws as MemoryCandidateQueueError in strict mode", async () => {
    const cause = new Error("spawn boom");
    const synchronousSpawn: SpawnFn = vi.fn(() => {
      throw cause;
    });
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_STRICT: "true",
    };
    const { adapter } = makeAdapter(env, synchronousSpawn);

    await expect(
      adapter.enqueue("queue memory: anything", { candidateId: "c-sync-strict" }),
    ).rejects.toMatchObject({
      name: "MemoryCandidateQueueError",
      cause,
    });
  });

  it("clamps grace > timeout to the timeout value (defensive)", async () => {
    const spawn = buildSpawn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS: "10000",
      OPENCLAW_MEMORY_CANDIDATE_QUEUE_TIMEOUT_MS: "200",
    };
    const { adapter } = makeAdapter(env, spawn.spawn);

    const promise = adapter.enqueue("queue memory: stalls", { candidateId: "c-clamp" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result.status).toBe("detached");
  });
});

describe("log hygiene", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetMemoryCandidateQueueDebugBannerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetMemoryCandidateQueueDebugBannerForTests();
  });

  it("never logs DSN or message text in default (non-debug) operation", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_CORE_DSN: "postgres://user:secret@host:5432/db",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const payload = "MERLOT TIGER 9134";
    const promise = adapter.enqueue(`queue memory: ${payload}`, { candidateId: "c-hyg" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await promise;

    const messages = log.mock.calls.map(([m]) => String(m));
    for (const msg of messages) {
      expect(msg).not.toContain("postgres://");
      expect(msg).not.toContain("secret@");
      expect(msg).not.toContain(payload);
    }
  });

  it("with debug enabled, previews are capped and DSN is never logged", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_DEBUG: "true",
      OPENCLAW_MEMORY_CORE_DSN: "postgres://user:secret@host:5432/db",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const longContent = "y".repeat(2000);
    const promise = adapter.enqueue(`queue memory: ${longContent}`, { candidateId: "c-dbg" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await promise;

    const messages = log.mock.calls.map(([m]) => String(m));
    for (const msg of messages) {
      expect(msg).not.toContain("postgres://");
      expect(msg).not.toContain("secret@");
    }
    const extracted = messages.find((m) => /extractedPreview=/.test(m));
    expect(extracted).toBeDefined();
    const m = extracted?.match(/extractedPreview="([^"]*)"/);
    expect(m).not.toBeNull();
    if (m) {
      expect(m[1]?.endsWith("...")).toBe(true);
      expect((m[1] ?? "").length).toBeLessThanOrEqual(303);
    }
  });

  it("logs only the basename when OPENCLAW_MEMORY_PYTHON is an absolute path (debug)", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = {
      ...ENABLED_ENV,
      OPENCLAW_MEMORY_DEBUG: "true",
      OPENCLAW_MEMORY_PYTHON: "/Users/who/.venv/bin/python3",
    };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const promise = adapter.enqueue("queue memory: alpha", { candidateId: "c-pylog" });
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

  it("emits the [memory-candidate-queue] banner exactly once when debug is enabled", async () => {
    const spawn = buildSpawn();
    const log = vi.fn();
    const env: NodeJS.ProcessEnv = { ...ENABLED_ENV, OPENCLAW_MEMORY_DEBUG: "true" };
    const { adapter } = makeAdapter(env, spawn.spawn, log);

    const first = adapter.enqueue("queue memory: alpha", { candidateId: "c-b1" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await first;

    const second = adapter.enqueue("queue memory: beta", { candidateId: "c-b2" });
    await vi.advanceTimersByTimeAsync(0);
    spawn.childRef.value.emitClose(0);
    await second;

    const bannerHits = log.mock.calls.filter(
      ([msg]) => String(msg) === "[memory-candidate-queue] debug logging enabled",
    );
    expect(bannerHits).toHaveLength(1);
  });
});
