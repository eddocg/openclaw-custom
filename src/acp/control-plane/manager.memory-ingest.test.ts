import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { MemoryContextAdapter } from "../../memory/memory-context-adapter.js";
import {
  createMemoryContextInjector,
  type MemoryContextInjector,
} from "../../memory/memory-context-injection.js";
import {
  MemoryIngestError,
  type MemoryIngestAdapter,
  type MemoryIngestResult,
} from "../../memory/memory-ingest-adapter.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
} from "../runtime/types.js";

const hoisted = vi.hoisted(() => ({
  listAcpSessionEntriesMock: vi.fn(),
  readAcpSessionEntryMock: vi.fn(),
  upsertAcpSessionMetaMock: vi.fn(),
  getAcpRuntimeBackendMock: vi.fn(),
  requireAcpRuntimeBackendMock: vi.fn(),
  // Captures `info`/`debug` calls only on the dedicated `acp/memory-ingest`
  // subsystem logger; other subsystems pass through to the real factory.
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

function makeSpyInjector(): MemoryContextInjector & { inject: ReturnType<typeof vi.fn> } {
  return {
    inject: vi.fn(async (input: { promptToWrap: string }) => input.promptToWrap),
  } as MemoryContextInjector & { inject: ReturnType<typeof vi.fn> };
}

describe("AcpSessionManager.runTurn memory-ingest wiring", () => {
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

  it("calls memoryIngester.ingest with the raw input.text once per turn", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async (): Promise<MemoryIngestResult> => ({ status: "skipped:no_trigger" })),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "what is the bot ingestion phrase?",
      mode: "prompt",
      requestId: "r-ing-1",
    });

    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(memoryIngester.ingest).toHaveBeenCalledWith("what is the bot ingestion phrase?");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("short-circuits succeeded semantic ingest before memory injection and runtime.runTurn", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const callOrder: string[] = [];
    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async (): Promise<MemoryIngestResult> => {
        callOrder.push("ingest");
        return { status: "succeeded", content: "ORANGE FALCON" };
      }),
    };
    const memoryInjector = makeSpyInjector();
    const events: AcpRuntimeEvent[] = [];
    const onEvent = vi.fn(async (event: AcpRuntimeEvent) => {
      events.push(event);
    });

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector,
      memoryIngester,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "Remember this as semantic memory: ORANGE FALCON",
      mode: "prompt",
      requestId: "r-ing-2",
      onEvent,
    });

    expect(callOrder).toEqual(["ingest"]);
    expect(memoryInjector.inject).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    const [textEvent, doneEvent] = events;
    expect(textEvent.type).toBe("text_delta");
    if (textEvent.type === "text_delta") {
      expect(textEvent.text).toBe("Semantic memory stored.");
      expect(textEvent.stream).toBe("output");
    }
    expect(doneEvent.type).toBe("done");
    if (doneEvent.type === "done") {
      expect(doneEvent.stopReason).toBe("semantic_memory_ingest_handled");
    }
  });

  it("continues through memory injection and runtime.runTurn for skipped:no_trigger", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async (): Promise<MemoryIngestResult> => ({ status: "skipped:no_trigger" })),
    };
    const memoryInjector = makeSpyInjector();

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector,
      memoryIngester,
    });

    const userText = "what is the bot ingestion phrase?";
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: userText,
      mode: "prompt",
      requestId: "r-ing-3",
    });

    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(memoryInjector.inject).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);
    const forwarded = runTurn.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(forwarded?.text).toBe(userText);
  });

  it("aborts the turn before runtime when ingest throws MemoryIngestError (strict mode)", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async () => {
        throw new MemoryIngestError("memory ingest exited 2: boom");
      }),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    await expect(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: SESSION_KEY,
        text: "save this: alpha",
        mode: "prompt",
        requestId: "r-ing-strict",
      }),
    ).rejects.toMatchObject({
      name: "MemoryIngestError",
      message: expect.stringContaining("memory ingest exited 2"),
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("ingests even when input is already wrapped (the adapter itself enforces the no-double-ingest guard)", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async (rawText: string): Promise<MemoryIngestResult> => {
        if (rawText.includes("<memory_context>") || rawText.includes("<user_request>")) {
          return { status: "skipped:wrapped" };
        }
        return { status: "skipped:no_trigger" };
      }),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    const wrapped =
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nremember this: x\n</user_request>";
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: wrapped,
      mode: "prompt",
      requestId: "r-ing-wrapped",
    });

    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(memoryIngester.ingest).toHaveBeenCalledWith(wrapped);
    const result = await (memoryIngester.ingest as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(result?.status).toBe("skipped:wrapped");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("emits seam-start and seam-result lines via acpMemoryIngestLog.info when OPENCLAW_MEMORY_DEBUG=true", async () => {
    process.env.OPENCLAW_MEMORY_DEBUG = "true";

    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(
        async (): Promise<MemoryIngestResult> => ({
          status: "succeeded",
          reason: "ok",
          content: "alpha",
        }),
      ),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "Save this: alpha",
      mode: "prompt",
      requestId: "r-ing-debug",
    });

    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(runTurn).not.toHaveBeenCalled();

    const infoCalls = hoisted.acpMemoryIngestInfoMock.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((m) => /seam=acp-manager ingest-start/.test(m))).toBe(true);
    expect(infoCalls.some((m) => /seam=acp-manager ingest-result status=succeeded/.test(m))).toBe(
      true,
    );
    expect(
      infoCalls.some(
        (m) =>
          /seam=acp-manager short-circuit reason=semantic-trigger-matched status=succeeded/.test(
            m,
          ),
      ),
    ).toBe(true);
    // Reason marker must be present (either "ok" or "none"), but we do not
    // assert the full reason content to avoid overfitting.
    expect(infoCalls.some((m) => /reason=/.test(m))).toBe(true);

    // Seam markers must NOT be routed to debug, where the file logger filters
    // them at the default INFO level.
    const debugCalls = hoisted.acpMemoryIngestDebugMock.mock.calls.map(([msg]) => String(msg));
    expect(debugCalls.some((m) => /seam=acp-manager/.test(m))).toBe(false);
  });

  it("emits no [memory-ingest] seam markers when OPENCLAW_MEMORY_DEBUG is unset", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async (): Promise<MemoryIngestResult> => ({ status: "skipped:no_trigger" })),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "what is the bot ingestion phrase?",
      mode: "prompt",
      requestId: "r-ing-no-debug",
    });

    expect(memoryIngester.ingest).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledTimes(1);

    const infoCalls = hoisted.acpMemoryIngestInfoMock.mock.calls.map(([msg]) => String(msg));
    const debugCalls = hoisted.acpMemoryIngestDebugMock.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((m) => /\[memory-ingest\] seam=acp-manager/.test(m))).toBe(false);
    expect(debugCalls.some((m) => /\[memory-ingest\] seam=acp-manager/.test(m))).toBe(false);
  });
});
