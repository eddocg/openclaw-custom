import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_FILE = fileURLToPath(new URL("./attempt.ts", import.meta.url));

/**
 * Source-level wiring guard for the embedded runner's late-bound memory
 * envelope. Pure end-to-end coverage of the helper lives in
 * `src/memory/memory-context-injection.test.ts`. This test only proves
 * that the runner consumes the helper at the documented seam:
 *
 *   - retrieval query = raw `params.prompt`
 *   - wrap target     = the final layered `effectivePrompt`
 *   - applied immediately before `activeSession.prompt(...)`
 *
 * Driving the full `runEmbeddedAttempt` here is forbidden by the embedded
 * runner test guardrails (`AGENTS.md`: "make production call that helper
 * directly, then test the helper"). The cheapest durable wiring proof is a
 * literal-call-site assertion: if anyone re-routes the wrap target or the
 * retrieval query, this test fails before review.
 */
describe("runEmbeddedAttempt memory-context wiring", () => {
  it("calls the shared injector with promptToWrap=effectivePrompt and query=raw params.prompt", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain(
      'import { createMemoryContextInjector } from "../../../memory/memory-context-injection.js";',
    );

    expect(source).toContain(
      "const memoryInjector = params.memoryInjector ?? createMemoryContextInjector();",
    );

    expect(source).toContain(
      "const submittedPrompt = await memoryInjector.inject({\n              promptToWrap: effectivePrompt,\n              query: params.prompt,\n            });",
    );
  });

  it("submits the wrapped prompt to activeSession.prompt and records it in the trajectory and snapshot", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    expect(source).toContain("finalPromptText = submittedPrompt;");
    expect(source).toContain("prompt: submittedPrompt,");
    expect(source).toContain("inFlightPrompt: submittedPrompt,");
    expect(source).toContain("activeSession.prompt(submittedPrompt, { images: imageResult.images })");
    expect(source).toContain("activeSession.prompt(submittedPrompt)");
  });

  it("does not wrap params.prompt before bootstrap/plugin/orphan-merge layering (Decision C)", async () => {
    const source = await readFile(SOURCE_FILE, "utf8");

    // Decision C requires the wrap to happen on the final effectivePrompt,
    // not on the raw params.prompt before layering. If anyone reintroduces
    // an early wrap, the bootstrap warning, hook prependContext, or orphan
    // merge marker would land outside <user_request>.
    expect(source).not.toMatch(/promptToWrap:\s*params\.prompt/);
    expect(source).not.toContain('"<memory_context>\\n${');
    expect(source).not.toContain("`<memory_context>\\n${params.prompt");
  });
});
