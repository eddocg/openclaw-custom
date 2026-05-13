import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import {
  CANONICAL_REMEMBER_ACKNOWLEDGMENT,
  type CanonicalRememberBridge,
  type CanonicalRememberDivertResult,
} from "../../memory/canonical-remember-bridge.js";
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
import type { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeEvent } from "../runtime/types.js";

const hoisted = vi.hoisted(() => ({
  listAcpSessionEntriesMock: vi.fn(),
  readAcpSessionEntryMock: vi.fn(),
  upsertAcpSessionMetaMock: vi.fn(),
  getAcpRuntimeBackendMock: vi.fn(),
  requireAcpRuntimeBackendMock: vi.fn(),
}));

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
const SESSION_KEY = "agent:codex:acp:session-canonical";

function readySessionMeta(): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-canonical",
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

function makePassthroughCandidateQueue(): MemoryCandidateQueueAdapter {
  return {
    enqueue: vi.fn(async (): Promise<MemoryCandidateQueueResult> => ({
      status: "skipped:no_trigger",
    })),
  };
}

function makeBridge(
  result: CanonicalRememberDivertResult,
): CanonicalRememberBridge & { divert: ReturnType<typeof vi.fn> } {
  const divert = vi.fn(async () => result);
  return { divert } as CanonicalRememberBridge & {
    divert: ReturnType<typeof vi.fn>;
  };
}

describe("AcpSessionManager.runTurn canonical-remember bridge wiring", () => {
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
  });

  afterEach(() => {
    delete process.env.OPENCLAW_MEMORY_DEBUG;
    delete process.env.OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED;
  });

  it("calls bridge.divert with raw input.text and ACP context BEFORE semantic ingest / candidate queue", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester = makePassthroughIngester();
    const memoryCandidateQueue = makePassthroughCandidateQueue();
    const canonicalRememberBridge = makeBridge({
      diverted: false,
      reason: "queue-disabled",
    });

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
      memoryCandidateQueue,
      canonicalRememberBridge,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "remember this canonical operational rule: governed bridge requires review",
      mode: "prompt",
      requestId: "r-canon-1",
    });

    expect(canonicalRememberBridge.divert).toHaveBeenCalledTimes(1);
    const args = canonicalRememberBridge.divert.mock.calls[0];
    expect(args?.[0]).toBe(
      "remember this canonical operational rule: governed bridge requires review",
    );
    expect(args?.[1]).toEqual({
      source: "acp",
      sessionKey: SESSION_KEY,
      requestId: "r-canon-1",
    });
    // Detector mismatch (queue disabled in this test) → existing flow runs.
    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("short-circuits the turn and emits a deterministic acknowledgment when diverted=true", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester = makePassthroughIngester();
    const memoryCandidateQueue = makePassthroughCandidateQueue();
    const canonicalRememberBridge = makeBridge({
      diverted: true,
      acknowledgment: CANONICAL_REMEMBER_ACKNOWLEDGMENT,
      enqueueResult: { status: "succeeded", candidateId: "cand-canon-1" },
    });

    const events: AcpRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AcpRuntimeEvent) => {
      events.push(event);
    });

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
      memoryCandidateQueue,
      canonicalRememberBridge,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "remember this canonical operational rule: never auto-merge",
      mode: "prompt",
      requestId: "r-canon-2",
      onEvent,
    });

    expect(canonicalRememberBridge.divert).toHaveBeenCalledTimes(1);
    // Hard invariant: no semantic ingest, no candidate queue enqueue, no
    // runtime turn execution after the canonical short-circuit.
    expect(memoryIngester.ingest).not.toHaveBeenCalled();
    expect(memoryCandidateQueue.enqueue).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();

    // Deterministic acknowledgment delivered as a synthetic text_delta + done.
    expect(events.length).toBe(2);
    const [firstEvent, secondEvent] = events;
    expect(firstEvent.type).toBe("text_delta");
    if (firstEvent.type === "text_delta") {
      expect(firstEvent.text).toBe(CANONICAL_REMEMBER_ACKNOWLEDGMENT);
      expect(firstEvent.stream).toBe("output");
    }
    expect(secondEvent.type).toBe("done");
    if (secondEvent.type === "done") {
      expect(secondEvent.stopReason).toBe("canonical_remember_diverted");
    }
  });

  it("preserves existing semantic ingest + candidate queue + model turn when bridge returns diverted=false", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester = makePassthroughIngester();
    const memoryCandidateQueue = makePassthroughCandidateQueue();
    const canonicalRememberBridge = makeBridge({
      diverted: false,
      reason: "no-trigger",
    });

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
      memoryCandidateQueue,
      canonicalRememberBridge,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "queue memory: routine fact about deployments",
      mode: "prompt",
      requestId: "r-canon-3",
    });

    expect(canonicalRememberBridge.divert).toHaveBeenCalledTimes(1);
    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(memoryCandidateQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("does not call runtime.runTurn even when onEvent is omitted on the diverted path", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const canonicalRememberBridge = makeBridge({
      diverted: true,
      acknowledgment: CANONICAL_REMEMBER_ACKNOWLEDGMENT,
      enqueueResult: { status: "detached", reason: "grace expired" },
    });

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester: makePassthroughIngester(),
      memoryCandidateQueue: makePassthroughCandidateQueue(),
      canonicalRememberBridge,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "remember this canonical: hard invariant about replication",
      mode: "prompt",
      requestId: "r-canon-4",
    });

    expect(canonicalRememberBridge.divert).toHaveBeenCalledTimes(1);
    expect(runTurn).not.toHaveBeenCalled();
  });
});
