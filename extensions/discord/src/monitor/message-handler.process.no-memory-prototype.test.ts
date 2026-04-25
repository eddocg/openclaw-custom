import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_FILE = fileURLToPath(new URL("./message-handler.process.ts", import.meta.url));

const FORBIDDEN_TOKENS = [
  "persistDiscordPrompt",
  "resolveSemanticMemoryContext",
  "Relevant memory:",
  "OPENCLAW_MEMORY_CORE_DSN",
  "openclaw_memory_core.integration.service",
  "PostgresEpisodicRetrieval",
] as const;

describe("message-handler.process.ts memory-prototype guard", () => {
  // Memory context is now resolved by the ACP-level adapter
  // (`src/memory/memory-context-adapter.ts` invoked from
  // `AcpGatewayAgent.prompt`). The Discord handler must not regrow its old
  // inline memory prototype, or memory context would be injected twice.
  it.each(FORBIDDEN_TOKENS)("does not contain forbidden token %j", async (token) => {
    const source = await readFile(SOURCE_FILE, "utf8");
    expect(source).not.toContain(token);
  });
});
