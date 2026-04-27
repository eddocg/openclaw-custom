import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import {
  MemoryContextError,
  type MemoryContextAdapter,
} from "../../memory/memory-context-adapter.js";
import { createMemoryContextInjector } from "../../memory/memory-context-injection.js";
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

describe("AcpSessionManager.runTurn memory-context injection", () => {
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

  it("forwards the wrapped text to runtime.runTurn when memory injector returns content", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const adapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => "remembered fact"),
    };
    const memoryInjector = createMemoryContextInjector({ adapter, canonical: () => "" });

    const manager = new AcpSessionManager({ ...DEFAULT_DEPS, memoryInjector });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "what is foo?",
      mode: "prompt",
      requestId: "r-mem-1",
    });

    expect(adapter.resolveContext).toHaveBeenCalledTimes(1);
    expect(adapter.resolveContext).toHaveBeenCalledWith("what is foo?");
    expect(runTurn).toHaveBeenCalledTimes(1);
    const forwarded = runTurn.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(forwarded?.text).toBe(
      "<memory_context>\n<semantic_memory>\nremembered fact\n</semantic_memory>\n</memory_context>\n\n<user_request>\nwhat is foo?\n</user_request>",
    );
  });

  it("forwards the raw text unchanged when memory injector returns the input untouched", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const adapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => ""),
    };
    const memoryInjector = createMemoryContextInjector({ adapter, canonical: () => "" });

    const manager = new AcpSessionManager({ ...DEFAULT_DEPS, memoryInjector });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: "no memory available",
      mode: "prompt",
      requestId: "r-mem-2",
    });

    expect(runTurn).toHaveBeenCalledTimes(1);
    const forwarded = runTurn.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(forwarded?.text).toBe("no memory available");
  });

  it("does not double-wrap input that is already wrapped", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const adapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => "should-not-run"),
    };
    const memoryInjector = createMemoryContextInjector({ adapter, canonical: () => "" });

    const manager = new AcpSessionManager({ ...DEFAULT_DEPS, memoryInjector });

    const alreadyWrapped =
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nask again\n</user_request>";
    await manager.runTurn({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      text: alreadyWrapped,
      mode: "prompt",
      requestId: "r-mem-3",
    });

    expect(adapter.resolveContext).not.toHaveBeenCalled();
    expect(runTurn).toHaveBeenCalledTimes(1);
    const forwarded = runTurn.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(forwarded?.text).toBe(alreadyWrapped);
  });

  it("propagates MemoryContextError so the caller can surface a strict-mode failure", async () => {
    const { runtime, runTurn } = createRuntime();
    bindRuntime(runtime);

    const adapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => {
        throw new MemoryContextError("memory CLI exited 2: boom");
      }),
    };
    const memoryInjector = createMemoryContextInjector({ adapter, canonical: () => "" });

    const manager = new AcpSessionManager({ ...DEFAULT_DEPS, memoryInjector });

    await expect(
      manager.runTurn({
        cfg: baseCfg,
        sessionKey: SESSION_KEY,
        text: "what is foo?",
        mode: "prompt",
        requestId: "r-mem-strict",
      }),
    ).rejects.toMatchObject({
      name: "MemoryContextError",
      message: expect.stringContaining("memory CLI exited 2"),
    });
    expect(runTurn).not.toHaveBeenCalled();
  });
});
