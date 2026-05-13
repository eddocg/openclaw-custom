import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_FILE = fileURLToPath(new URL("./attempt.ts", import.meta.url));

/**
 * Source-level wiring guard for the governed canonical-remember diversion
 * slice. End-to-end coverage of the bridge lives in
 * `src/memory/canonical-remember-bridge.test.ts`. This guard only proves
 * that the embedded runner consumes the bridge at the documented seam
 * BEFORE semantic ingest, memory injection, model execution, and tool
 * exposure, and that the short-circuit return path is in place.
 */
describe("runEmbeddedAttempt canonical-remember bridge wiring", () => {
  it("imports the canonical-remember bridge factory from the shared memory module", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    expect(source).toContain(
      'import { createCanonicalRememberBridge } from "../../../memory/canonical-remember-bridge.js";',
    );
  });

  it("constructs the bridge from the shared candidate queue adapter (or the injected fake)", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    expect(source).toContain("params.canonicalRememberBridge ??");
    expect(source).toMatch(
      /createCanonicalRememberBridge\(\s*\{\s*adapter:\s*memoryCandidateQueue\s*,\s*log:\s*memoryCandidateQueueLogBridge\s*,?\s*\}\s*\)/,
    );
  });

  it("calls bridge.divert(params.prompt, ...) exactly once at the early run-start seam", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    const divertCalls =
      source.match(/canonicalRememberBridge\.divert\(\s*params\.prompt\b/g) ?? [];
    expect(divertCalls.length).toBe(1);
    expect(source).toMatch(
      /const\s+canonicalDivertResult\s*=\s*await\s+canonicalRememberBridge\.divert\(\s*params\.prompt\b/,
    );
  });

  it("invokes divert BEFORE the semantic ingest and the late-bound memory-context inject", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    const divertIdx = source.search(
      /const\s+canonicalDivertResult\s*=\s*await\s+canonicalRememberBridge\.divert\(/,
    );
    const ingestIdx = source.search(
      /const\s+memoryIngestResult\s*=\s*await\s+memoryIngester\.ingest\(\s*params\.prompt\s*\)/,
    );
    const enqueueIdx = source.search(
      /const\s+candidateQueueResult\s*=\s*await\s+memoryCandidateQueue\.enqueue\(\s*params\.prompt\b/,
    );
    const injectIdx = source.indexOf("const submittedPrompt = await memoryInjector.inject({");
    expect(divertIdx).toBeGreaterThan(-1);
    expect(ingestIdx).toBeGreaterThan(-1);
    expect(enqueueIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(-1);
    expect(divertIdx).toBeLessThan(ingestIdx);
    expect(divertIdx).toBeLessThan(enqueueIdx);
    expect(divertIdx).toBeLessThan(injectIdx);
  });

  it("short-circuits the turn via a deterministic acknowledgment when divert returns diverted=true", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    expect(source).toMatch(
      /if\s*\(\s*canonicalDivertResult\.diverted\s*\)\s*\{[\s\S]*?return\s+buildCanonicalDivertedEmbeddedAttemptResult\(\s*\{[\s\S]*?acknowledgment:\s*canonicalDivertResult\.acknowledgment[\s\S]*?\}\s*\);[\s\S]*?\}/,
    );
    expect(source).toContain("function buildCanonicalDivertedEmbeddedAttemptResult(");
    expect(source).toMatch(/assistantTexts:\s*\[\s*params\.acknowledgment\s*\]/);
  });

  it("emits debug-gated `[canonical-remember-bridge]` seam markers around the divert call", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    expect(source).toContain("[canonical-remember-bridge] seam=embedded-attempt divert-start");
    expect(source).toContain(
      "[canonical-remember-bridge] seam=embedded-attempt divert-result diverted=",
    );
    expect(source).toContain(
      "[canonical-remember-bridge] seam=embedded-attempt short-circuit reason=canonical-diverted",
    );
  });

  it("does not introduce any new direct MEMORY.md write tooling on the diversion path", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    // Hard invariant: the diversion path must not synthesize `memory_flush`,
    // `MEMORY.md`, or other canonical write tools. The bridge only enqueues
    // through the existing candidate queue adapter + returns the ack.
    const divertedBlock = source.match(
      /if\s*\(\s*canonicalDivertResult\.diverted\s*\)\s*\{[\s\S]*?\}\s*\n\s*\n/,
    )?.[0];
    expect(divertedBlock).toBeDefined();
    expect(divertedBlock ?? "").not.toMatch(/MEMORY\.md/);
    expect(divertedBlock ?? "").not.toMatch(/memory_flush/);
    expect(divertedBlock ?? "").not.toMatch(/applyCanonical|writeCanonicalMemory/);
  });
});
