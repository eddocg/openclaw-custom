import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryCandidateQueueAdapter,
  type EmbeddedRunAttemptParams,
  type MemoryCandidateQueueAdapter,
  type MemoryCandidateQueueResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";

const SOURCE_FILE = fileURLToPath(new URL("./run-attempt.ts", import.meta.url));

/**
 * Source-level wiring guard for the Codex app-server candidate-queue write
 * path. End-to-end coverage of the adapter lives in
 * `src/memory/memory-candidate-queue-adapter.test.ts`. This guard only proves
 * that `runCodexAppServerAttempt` consumes the adapter at the documented
 * Codex-only seam (mirroring the embedded runner / ACP seams):
 *
 *   - the adapter factory is sourced through the shared SDK barrel
 *     (`openclaw/plugin-sdk/agent-harness-runtime`) so the Codex extension
 *     never reaches into `src/memory/**` directly,
 *   - the adapter is awaited with the raw `params.prompt` near attempt
 *     start, before any heavy app-server / context-engine work,
 *   - the adapter is reused via `params.memoryCandidateQueue ??` so tests can
 *     inject a fake without touching the SDK,
 *   - the breadcrumb identifies the seam as `codex-app-server`,
 *   - DSNs/secrets are never logged.
 */
describe("runCodexAppServerAttempt memory-candidate-queue wiring", () => {
  it("imports the candidate queue adapter factory from the shared plugin SDK barrel", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain(
      "openclaw/plugin-sdk/agent-harness-runtime",
    );
    expect(source).toMatch(/createMemoryCandidateQueueAdapter,/);
    expect(source).not.toMatch(/from ["'].*src\/memory\/memory-candidate-queue-adapter/);
    expect(source).not.toMatch(/from ["'].*\.\.\/memory\/memory-candidate-queue-adapter/);
  });

  it("invokes the candidate queue at attempt start, before client/plugin/context work", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("params.memoryCandidateQueue ??");
    expect(source).toContain("createMemoryCandidateQueueAdapter(");

    const enqueueCalls = source.match(/memoryCandidateQueue\.enqueue\(\s*params\.prompt\b/g) ?? [];
    expect(enqueueCalls.length).toBe(1);

    const enqueueIdx = source.indexOf(
      "await enqueueCodexAppServerCandidateQueue({ params });",
    );
    const clientFactoryIdx = source.indexOf("resolveCodexAppServerClientFactory()");
    const turnStartIdx = source.indexOf('"turn/start"');
    expect(enqueueIdx).toBeGreaterThan(-1);
    expect(clientFactoryIdx).toBeGreaterThan(-1);
    expect(turnStartIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeLessThan(clientFactoryIdx);
    expect(enqueueIdx).toBeLessThan(turnStartIdx);
  });

  it("does not reach back into the existing PI/ACP candidate queue seams", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).not.toContain("seam=embedded-attempt enqueue");
    expect(source).not.toContain("seam=acp-manager enqueue");
  });

  it("emits debug-gated seam markers identifying seam=codex-app-server", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("[memory-candidate-queue] seam=codex-app-server enqueue-start");
    expect(source).toContain("[memory-candidate-queue] seam=codex-app-server enqueue-result");
    expect(source).toMatch(
      /embeddedAgentLog\.info\(\s*"\[memory-candidate-queue\] seam=codex-app-server enqueue-start"\s*\)/,
    );
    expect(source).toMatch(
      /embeddedAgentLog\.info\(\s*`\[memory-candidate-queue\] seam=codex-app-server enqueue-result/,
    );
  });

  it("forwards channel-agnostic context fields to the adapter", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toMatch(/source:\s*candidateQueueSource\b/);
    expect(source).toMatch(/sessionKey:\s*params\.sessionKey\b/);
    expect(source).toMatch(/requestId:\s*params\.runId\b/);
    expect(source).toMatch(/provider:\s*params\.messageProvider\b/);
  });

  it("never logs DSN or secret env vars from the bridge", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    // The bridge only forwards the adapter's own breadcrumbs; the adapter
    // itself never logs argv content, env values, or DSNs. Lock this with a
    // belt-and-suspenders source check so the Codex seam never grows a
    // bespoke logger that captures secrets.
    expect(source).not.toMatch(/OPENCLAW_MEMORY_CORE_DSN/);
    expect(source).not.toMatch(/process\.env\.\w*DSN/);
  });

  it("wraps the await in a try/catch so adapter throws cannot abort the attempt", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    const helperStart = source.indexOf("async function enqueueCodexAppServerCandidateQueue");
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = source.indexOf("\n}\n", helperStart);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const body = source.slice(helperStart, helperEnd);
    expect(body).toMatch(/try\s*\{[\s\S]*await\s+memoryCandidateQueue\.enqueue\(/);
    expect(body).toMatch(/catch\s*\(error\)/);
  });
});

describe("runCodexAppServerAttempt candidate-queue env contract", () => {
  // Fast adapter-level smoke that the SDK re-export is wired to the same
  // factory the embedded/ACP seams use. End-to-end behavior is owned by
  // `src/memory/memory-candidate-queue-adapter.test.ts`; here we only assert
  // the Codex-visible barrel returns an adapter shape that satisfies the
  // documented MemoryCandidateQueueAdapter contract.
  it("createMemoryCandidateQueueAdapter exports a working enqueue() through the SDK barrel", async () => {
    const adapter: MemoryCandidateQueueAdapter = createMemoryCandidateQueueAdapter({
      env: {} as NodeJS.ProcessEnv,
    });
    expect(typeof adapter.enqueue).toBe("function");
    const result: MemoryCandidateQueueResult = await adapter.enqueue("hello", {});
    expect(result.status).toBe("skipped:disabled");
  });

  it("forwards full env (including OPENCLAW_MEMORY_CORE_DSN) to the spawned subprocess without logging it", async () => {
    const captured: { args: ReadonlyArray<string>; options: { env?: NodeJS.ProcessEnv } }[] = [];
    const fakeChildSpawn = ((command: string, args: ReadonlyArray<string>, options: unknown) => {
      void command;
      captured.push({
        args,
        options: options as { env?: NodeJS.ProcessEnv },
      });
      // Return a minimal child-process-shaped object that immediately closes
      // with an error so the adapter resolves quickly without touching the
      // network. Behavior of the success/timeout paths is owned by the
      // adapter unit test.
      const handlers: Record<string, ((...args: unknown[]) => void) | undefined> = {};
      return {
        stdout: { setEncoding: () => {}, on: () => {} },
        stderr: { setEncoding: () => {}, on: () => {} },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
          if (event === "error") {
            queueMicrotask(() => handler(Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
          }
        },
        kill: () => true,
        pid: 12345,
      } as never;
    }) as unknown as Parameters<typeof createMemoryCandidateQueueAdapter>[0]["spawn"];
    const log = vi.fn();
    const adapter = createMemoryCandidateQueueAdapter({
      env: {
        OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED: "true",
        OPENCLAW_MEMORY_CANDIDATE_QUEUE_GRACE_MS: "10",
        OPENCLAW_MEMORY_CANDIDATE_QUEUE_TIMEOUT_MS: "100",
        OPENCLAW_MEMORY_CORE_DSN: "postgres://secret-dsn-do-not-log",
        OPENCLAW_MEMORY_PYTHON: "python3",
      },
      spawn: fakeChildSpawn,
      log,
    });
    await adapter.enqueue("queue memory: hello world", { source: "codex-app-server" });
    expect(captured.length).toBe(1);
    const forwardedEnv = captured[0]?.options.env ?? {};
    expect(forwardedEnv.OPENCLAW_MEMORY_CORE_DSN).toBe("postgres://secret-dsn-do-not-log");
    for (const call of log.mock.calls) {
      const message = String(call[0] ?? "");
      expect(message).not.toContain("postgres://secret-dsn-do-not-log");
      expect(message).not.toContain("OPENCLAW_MEMORY_CORE_DSN");
    }
  });
});
