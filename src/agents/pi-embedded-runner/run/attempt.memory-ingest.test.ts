import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_FILE = fileURLToPath(new URL("./attempt.ts", import.meta.url));

/**
 * Source-level wiring guard for the embedded runner's semantic-memory write
 * path. End-to-end coverage of the adapter (trigger detection, fail-open,
 * timeout, etc.) lives in `src/memory/memory-ingest-adapter.test.ts`. This
 * test only proves that the runner consumes the adapter at the documented
 * seam:
 *
 *   - the adapter is imported from `src/memory/memory-ingest-adapter`,
 *   - it is awaited with the raw `params.prompt` near run start,
 *   - the call is placed before the late-bound memory-context inject so the
 *     write path observes the raw text, not the wrapped `<memory_context>`
 *     prompt that idempotence would otherwise filter out.
 */
describe("runEmbeddedAttempt memory-ingest wiring", () => {
  it("imports the ingest adapter factory from the shared memory module", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain(
      'import { createMemoryIngestAdapter } from "../../../memory/memory-ingest-adapter.js";',
    );
  });

  it("awaits memoryIngester.ingest(params.prompt) exactly once at the early run-start seam", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("params.memoryIngester ??");
    expect(source).toContain("createMemoryIngestAdapter(");

    const ingestCalls = source.match(/memoryIngester\.ingest\(\s*params\.prompt\b/g) ?? [];
    expect(ingestCalls.length).toBe(1);
    expect(source).toMatch(
      /const\s+memoryIngestResult\s*=\s*await\s+memoryIngester\.ingest\(\s*params\.prompt\s*\)/,
    );
  });

  it("invokes ingest before the late-bound memory-context inject (so triggers are evaluated on raw text)", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    const ingestIdx = source.search(
      /const\s+memoryIngestResult\s*=\s*await\s+memoryIngester\.ingest\(\s*params\.prompt\s*\)/,
    );
    const injectIdx = source.indexOf("const submittedPrompt = await memoryInjector.inject({");
    expect(ingestIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(-1);
    expect(ingestIdx).toBeLessThan(injectIdx);
  });

  it("does not call ingest with a wrapped prompt (would short-circuit on the no-double-ingest guard)", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).not.toMatch(/memoryIngester\.ingest\(\s*submittedPrompt/);
    expect(source).not.toMatch(/memoryIngester\.ingest\(\s*effectivePrompt/);
  });

  it("emits debug-gated seam markers around the ingest call at INFO level", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("[memory-ingest] seam=embedded-attempt ingest-start");
    expect(source).toContain("[memory-ingest] seam=embedded-attempt ingest-result");

    // Both seam markers must use log.info so the gateway's default file log
    // level (INFO) captures them when OPENCLAW_MEMORY_DEBUG=true.
    expect(source).toMatch(
      /log\.info\(\s*"\[memory-ingest\] seam=embedded-attempt ingest-start"\s*\)/,
    );
    expect(source).toMatch(/log\.info\(\s*`\[memory-ingest\] seam=embedded-attempt ingest-result/);

    // Both seam markers must be conditional on the OPENCLAW_MEMORY_DEBUG gate.
    const startIdx = source.indexOf("[memory-ingest] seam=embedded-attempt ingest-start");
    const before = source.slice(Math.max(0, startIdx - 200), startIdx);
    expect(before).toContain("memoryIngestDebug");
  });

  it("wires a prefix-routing log bridge into the default-constructed adapter", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    // The default adapter is constructed with a static prefix-routing bridge:
    // `[memory-ingest]` breadcrumbs go to log.info (INFO-visible in the
    // gateway log file); other operational summaries stay on log.debug.
    expect(source).toMatch(
      /const\s+memoryIngestLogBridge\s*=\s*\(\s*msg:\s*string\s*\)\s*:\s*void\s*=>\s*\{[\s\S]*?msg\.startsWith\("\[memory-ingest\]"\)[\s\S]*?log\.info\(msg\)[\s\S]*?log\.debug\(msg\)[\s\S]*?\};/,
    );
    expect(source).toMatch(
      /createMemoryIngestAdapter\(\s*\{\s*log:\s*memoryIngestLogBridge\s*\}\s*\)/,
    );
  });
});
