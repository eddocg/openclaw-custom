import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type {
  MemoryCandidateQueueAdapter,
  MemoryCandidateQueueResult,
} from "../../memory/memory-candidate-queue-adapter.js";
import type { MemoryContextAdapter } from "../../memory/memory-context-adapter.js";
import { createMemoryContextInjector } from "../../memory/memory-context-injection.js";
import type {
  MemoryIngestAdapter,
  MemoryIngestResult,
} from "../../memory/memory-ingest-adapter.js";
import type { AcpRuntime, AcpRuntimeCapabilities } from "../runtime/types.js";

const hoisted = vi.hoisted(() => ({
  listAcpSessionEntriesMock: vi.fn(),
  readAcpSessionEntryMock: vi.fn(),
  upsertAcpSessionMetaMock: vi.fn(),
  getAcpRuntimeBackendMock: vi.fn(),
  requireAcpRuntimeBackendMock: vi.fn(),
  acpMemoryIngestInfoMock: vi.fn(),
  acpMemoryIngestDebugMock: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (subsystem: string) => {
      if (subsystem === "acp/memory-ingest") {
        const stub = {
          subsystem,
          isEnabled: () => true,
          trace: vi.fn(),
          debug: (msg: string) => hoisted.acpMemoryIngestDebugMock(msg),
          info: (msg: string) => hoisted.acpMemoryIngestInfoMock(msg),
          warn: vi.fn(),
          error: vi.fn(),
          fatal: vi.fn(),
          raw: vi.fn(),
          child: () => stub,
        };
        return stub;
      }
      return original.createSubsystemLogger(subsystem);
    },
  };
});

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoisted.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: (params: unknown) => hoisted.upsertAcpSessionMetaMock(params),
}));

vi.mock("../runtime/registry.js", () => ({
  getAcpRuntimeBackend: (backendId?: string) => hoisted.getAcpRuntimeBackendMock(backendId),
  requireAcpRuntimeBackend: (backendId?: string) => hoisted.requireAcpRuntimeBackendMock(backendId),
}));

let AcpSessionManager: typeof import("./manager.js").AcpSessionManager;
let resetAcpSessionManagerForTests: typeof import("./manager.js").__testing.resetAcpSessionManagerForTests;
let DEFAULT_DEPS: typeof import("./manager.types.js").DEFAULT_DEPS;

const baseCfg = {
  acp: { enabled: true, backend: "acpx", dispatch: { enabled: true } },
} as OpenClawConfig;
const SESSION_KEY = "agent:codex:acp:session-1";

function readySessionMeta(): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent",
    state: "idle",
    lastActivityAt: Date.now(),
  };
}

function createRuntime(): {
  runtime: AcpRuntime;
  runTurn: ReturnType<typeof vi.fn>;
} {
  const runTurn = vi.fn(async function* () {
    yield { type: "done" as const };
  });
  const runtime: AcpRuntime = {
    ensureSession: vi.fn(async (input: { sessionKey: string; mode: "persistent" | "oneshot" }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    })),
    runTurn,
    prepareFreshSession: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getCapabilities: vi.fn(
      async (): Promise<AcpRuntimeCapabilities> => ({
        controls: ["session/set_mode", "session/set_config_option", "session/status"],
      }),
    ),
    getStatus: vi.fn(async () => ({ summary: "status=alive", details: { status: "alive" } })),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
  };
  return { runtime, runTurn };
}

function bindRuntime(runtime: AcpRuntime): void {
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
    id: "acpx",
    runtime,
  });
  hoisted.readAcpSessionEntryMock.mockReturnValue({
    sessionKey: SESSION_KEY,
    storeSessionKey: SESSION_KEY,
    acp: readySessionMeta(),
  });
}

function makeStubInjector() {
  const adapter: MemoryContextAdapter = {
    resolveContext: vi.fn(async () => ""),
  };
  return createMemoryContextInjector({ adapter });
}

function makePassthroughIngester(): MemoryIngestAdapter {
  return {
    ingest: vi.fn(async (): Promise<MemoryIngestResult> => ({ status: "skipped:no_trigger" })),
  };
}

describe("AcpSessionManager.runTurn memory-candidate-queue wiring", () => {
  beforeAll(async () => {
    ({
      AcpSessionManager,
      __testing: { resetAcpSessionManagerForTests },
    } = await import("./manager.js"));
    ({ DEFAULT_DEPS } = await import("./manager.types.js"));
  });

  beforeEach(() => {
    resetAcpSessionManagerForTests();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
    hoisted.acpMemoryIngestInfoMock.mockReset();
    hoisted.acpMemoryIngestDebugMock.mockReset();
    delete process.env.OPENCLAW_MEMORY_DEBUG;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_MEMORY_DEBUG;
  });

  it("calls memoryCandidateQueue.enqueue with raw input.text and the ACP source/sessionKey/requestId context", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryCandidateQueue: MemoryCandidateQueueAdapter = {
      enqueue: vi.fn(
        async (): Promise<MemoryCandidateQueueResult> => ({ status: "skipped:no_trigger" }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "queue memory: project uses pgvector",
      mode: "prompt",
      requestId: "r-cq-1",
    });

    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    const args = (memoryCandidateQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toBe("queue memory: project uses pgvector");
    expect(args?.[1]).toEqual({
      source: "acp",
      sessionKey: SESSION_KEY,
      requestId: "r-cq-1",
    });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("does not spawn / skips for non-trigger input but still runs the turn", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryCandidateQueue: MemoryCandidateQueueAdapter = {
      enqueue: vi.fn(
        async (): Promise<MemoryCandidateQueueResult> => ({ status: "skipped:no_trigger" }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "hello there, please tell me about memory",
      mode: "prompt",
      requestId: "r-cq-2",
    });

    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("does not block the turn when the candidate queue adapter fails (fail-open)", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryCandidateQueue: MemoryCandidateQueueAdapter = {
      enqueue: vi.fn(
        async (): Promise<MemoryCandidateQueueResult> => ({
          status: "failed",
          reason: "memory candidate queue exited 2",
        }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "queue memory: alpha",
      mode: "prompt",
      requestId: "r-cq-failopen",
    });

    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("does not alter prompt text forwarded to runtime.runTurn (write-only side effect)", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryCandidateQueue: MemoryCandidateQueueAdapter = {
      enqueue: vi.fn(
        async (): Promise<MemoryCandidateQueueResult> => ({
          status: "succeeded",
          source: "acp",
          candidateId: "acp:req:s:r-cq-3",
        }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue,
    });

    const userText = "Queue memory: Never work directly on main.";
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: userText,
      mode: "prompt",
      requestId: "r-cq-3",
    });

    const forwarded = runTurn.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(forwarded?.text).toBe(userText);
  });

  it("emits seam-start / seam-result lines on the ACP subsystem logger at INFO when OPENCLAW_MEMORY_DEBUG=true", async () => {
    process.env.OPENCLAW_MEMORY_DEBUG = "true";

    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryCandidateQueue: MemoryCandidateQueueAdapter = {
      enqueue: vi.fn(
        async (): Promise<MemoryCandidateQueueResult> => ({
          status: "succeeded",
          reason: "ok",
        }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "queue memory: alpha",
      mode: "prompt",
      requestId: "r-cq-debug",
    });

    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);

    const infoCalls = hoisted.acpMemoryIngestInfoMock.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((m) => /\[memory-candidate-queue\] seam=acp-manager enqueue-start/.test(m))).toBe(
      true,
    );
    expect(
      infoCalls.some((m) =>
        /\[memory-candidate-queue\] seam=acp-manager enqueue-result status=succeeded/.test(m),
      ),
    ).toBe(true);
  });

  it("emits no [memory-candidate-queue] seam markers when OPENCLAW_MEMORY_DEBUG is unset", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryCandidateQueue: MemoryCandidateQueueAdapter = {
      enqueue: vi.fn(
        async (): Promise<MemoryCandidateQueueResult> => ({ status: "skipped:no_trigger" }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "what is the bot ingestion phrase?",
      mode: "prompt",
      requestId: "r-cq-no-debug",
    });

    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);

    const infoCalls = hoisted.acpMemoryIngestInfoMock.mock.calls.map(([msg]) => String(msg));
    const debugCalls = hoisted.acpMemoryIngestDebugMock.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((m) => /\[memory-candidate-queue\] seam=acp-manager/.test(m))).toBe(false);
    expect(debugCalls.some((m) => /\[memory-candidate-queue\] seam=acp-manager/.test(m))).toBe(
      false,
    );
  });
});
