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

  it("awaits memoryIngester.ingest(params.prompt) at the early run-start seam", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain(
      "const memoryIngester = params.memoryIngester ?? createMemoryIngestAdapter();",
    );
    expect(source).toContain("await memoryIngester.ingest(params.prompt);");
  });

  it("invokes ingest before the late-bound memory-context inject (so triggers are evaluated on raw text)", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");
    const ingestIdx = source.indexOf("await memoryIngester.ingest(params.prompt);");
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
});
