import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { MemoryContextAdapter } from "../../memory/memory-context-adapter.js";
import { createMemoryContextInjector } from "../../memory/memory-context-injection.js";
import {
  MemoryIngestError,
  type MemoryIngestAdapter,
} from "../../memory/memory-ingest-adapter.js";
import type { AcpRuntime, AcpRuntimeCapabilities } from "../runtime/types.js";

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
  });

  it("calls memoryIngester.ingest with the raw input.text once per turn", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async () => ({ status: "skipped:no_trigger" })),
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

  it("ingests before invoking runtime.runTurn (call order)", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const callOrder: string[] = [];
    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async () => {
        callOrder.push("ingest");
        return { status: "succeeded", content: "ORANGE FALCON" };
      }),
    };
    runTurn.mockImplementation(async function* () {
      callOrder.push("runTurn");
      yield { type: "done" as const };
    });

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "Remember this as semantic memory: ORANGE FALCON",
      mode: "prompt",
      requestId: "r-ing-2",
    });

    expect(callOrder).toEqual(["ingest", "runTurn"]);
  });

  it("does not alter prompt text forwarded to runtime.runTurn (write path is side-effect only)", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const memoryIngester: MemoryIngestAdapter = {
      ingest: vi.fn(async () => ({ status: "succeeded", content: "ORANGE FALCON" })),
    };

    const manager = new AcpSessionManager({
      ...DEFAULT_DEPS,
      memoryInjector: makeStubInjector(),
      memoryIngester,
    });

    const userText = "Remember this as semantic memory: ORANGE FALCON";
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: userText,
      mode: "prompt",
      requestId: "r-ing-3",
    });

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
      ingest: vi.fn(async (rawText: string) => {
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
    const result = await (memoryIngester.ingest as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;
    expect(result?.status).toBe("skipped:wrapped");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});
