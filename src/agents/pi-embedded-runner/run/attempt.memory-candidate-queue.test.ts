import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_FILE = fileURLToPath(new URL("./attempt.ts", import.meta.url));

/**
 * Source-level wiring guard for the embedded runner's candidate-queue write
 * path. End-to-end coverage of the adapter lives in
 * `src/memory/memory-candidate-queue-adapter.test.ts`. This guard only proves
 * that the runner consumes the adapter at the documented seam parallel to
 * the semantic ingest seam:
 *
 *   - the adapter is imported from
 *     `src/memory/memory-candidate-queue-adapter`,
 *   - it is awaited with the raw `params.prompt` near run start,
 *   - the call is placed after the semantic ingest call and before the
 *     late-bound memory-context inject so triggers are evaluated on raw
 *     channel-agnostic text.
 */
describe("runEmbeddedAttempt memory-candidate-queue wiring", () => {
  it("imports the candidate queue adapter factory from the shared memory module", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain(
      'import { createMemoryCandidateQueueAdapter } from "../../../memory/memory-candidate-queue-adapter.js";',
    );
  });

  it("awaits memoryCandidateQueue.enqueue(params.prompt, ...) exactly once at the early run-start seam", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("params.memoryCandidateQueue ??");
    expect(source).toContain("createMemoryCandidateQueueAdapter(");

    const enqueueCalls =
      source.match(/memoryCandidateQueue\.enqueue\(\s*params\.prompt\b/g) ?? [];
    expect(enqueueCalls.length).toBe(1);
    expect(source).toMatch(
      /const\s+candidateQueueResult\s*=\s*await\s+memoryCandidateQueue\.enqueue\(\s*params\.prompt\b/,
    );
  });

  it("invokes enqueue after the semantic ingest and before the late-bound memory-context inject", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    const ingestIdx = source.search(
      /const\s+memoryIngestResult\s*=\s*await\s+memoryIngester\.ingest\(\s*params\.prompt\s*\)/,
    );
    const enqueueIdx = source.search(
      /const\s+candidateQueueResult\s*=\s*await\s+memoryCandidateQueue\.enqueue\(\s*params\.prompt\b/,
    );
    const injectIdx = source.indexOf("const submittedPrompt = await memoryInjector.inject({");
    expect(ingestIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(-1);
    expect(ingestIdx).toBeLessThan(enqueueIdx);
    expect(enqueueIdx).toBeLessThan(injectIdx);
  });

  it("does not call enqueue with a wrapped prompt (the adapter has its own wrapped-input guard)", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).not.toMatch(/memoryCandidateQueue\.enqueue\(\s*submittedPrompt/);
    expect(source).not.toMatch(/memoryCandidateQueue\.enqueue\(\s*effectivePrompt/);
  });

  it("emits debug-gated seam markers around the enqueue call at INFO level", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("[memory-candidate-queue] seam=embedded-attempt enqueue-start");
    expect(source).toContain("[memory-candidate-queue] seam=embedded-attempt enqueue-result");
    expect(source).toMatch(
      /log\.info\(\s*"\[memory-candidate-queue\] seam=embedded-attempt enqueue-start"\s*\)/,
    );
    expect(source).toMatch(
      /log\.info\(\s*`\[memory-candidate-queue\] seam=embedded-attempt enqueue-result/,
    );
  });

  it("wires a prefix-routing log bridge into the default-constructed candidate queue adapter", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toMatch(
      /const\s+memoryCandidateQueueLogBridge\s*=\s*\(\s*msg:\s*string\s*\)\s*:\s*void\s*=>\s*\{[\s\S]*?msg\.startsWith\("\[memory-candidate-queue\]"\)[\s\S]*?log\.info\(msg\)[\s\S]*?log\.debug\(msg\)[\s\S]*?\};/,
    );
    expect(source).toMatch(
      /createMemoryCandidateQueueAdapter\(\s*\{\s*log:\s*memoryCandidateQueueLogBridge\s*\}\s*\)/,
    );
  });

  it("forwards runtime/session identifiers as channel-agnostic context fields", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toMatch(/source:\s*candidateQueueSource\b/);
    expect(source).toMatch(/sessionKey:\s*params\.sessionKey/);
    expect(source).toMatch(/requestId:\s*params\.runId\b/);
    expect(source).toMatch(/provider:\s*params\.messageProvider\b/);
  });
});
