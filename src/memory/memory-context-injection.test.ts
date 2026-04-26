import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryContextError,
  type MemoryContextAdapter,
} from "./memory-context-adapter.js";
import {
  composeMemoryBlock,
  createMemoryContextInjector,
  isPromptAlreadyWrapped,
  loadCanonicalMemory,
  wrapPromptWithMemoryContext,
} from "./memory-context-injection.js";

const CANONICAL_BODY = "Operator-authored fact: the canary is GREEN JAGUAR 617.";

function fakeAdapter(impl: (query: string) => Promise<string> | string): {
  adapter: MemoryContextAdapter;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (query: string) => impl(query));
  return { adapter: { resolveContext: spy }, spy };
}

function fsErrorWithCode(code: string): Error & { code: string } {
  const error = new Error(`fake ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

describe("isPromptAlreadyWrapped", () => {
  it("returns false for empty/missing input", () => {
    expect(isPromptAlreadyWrapped("")).toBe(false);
    expect(isPromptAlreadyWrapped("plain user prompt")).toBe(false);
  });

  it("detects a wrap at the start of the string", () => {
    const wrapped = "<memory_context>\nfact\n</memory_context>\n\n<user_request>\nask\n</user_request>";
    expect(isPromptAlreadyWrapped(wrapped)).toBe(true);
  });

  it("detects a wrap that follows a working-directory prefix", () => {
    const wrapped =
      "[Working directory: ~/proj]\n\n<memory_context>\nfact\n</memory_context>\n\nrest";
    expect(isPromptAlreadyWrapped(wrapped)).toBe(true);
  });

  it("detects a wrap that follows a bootstrap-style warning prefix", () => {
    const wrapped =
      "[bootstrap warning] some lines here\n<memory_context>\nfact\n</memory_context>\n\n<user_request>\nbody\n</user_request>";
    expect(isPromptAlreadyWrapped(wrapped)).toBe(true);
  });

  it("returns false when the open tag has no matching close tag", () => {
    const half = "<memory_context>\nfact without a close tag";
    expect(isPromptAlreadyWrapped(half)).toBe(false);
  });

  it("ignores wraps placed beyond the 32 KiB scan window", () => {
    const padding = "x".repeat(33 * 1024);
    const wrapped = `${padding}<memory_context>\nfact\n</memory_context>\n\n<user_request>\nq\n</user_request>`;
    expect(isPromptAlreadyWrapped(wrapped)).toBe(false);
  });
});

describe("wrapPromptWithMemoryContext", () => {
  it("emits the documented envelope verbatim", () => {
    const wrapped = wrapPromptWithMemoryContext("the prompt body", "the memory body");
    expect(wrapped).toBe(
      "<memory_context>\nthe memory body\n</memory_context>\n\n<user_request>\nthe prompt body\n</user_request>",
    );
  });
});

describe("composeMemoryBlock", () => {
  it("returns empty string when both sources are empty", () => {
    expect(composeMemoryBlock({ canonical: "", semantic: "" })).toBe("");
  });

  it("returns canonical-only block when semantic is empty", () => {
    expect(composeMemoryBlock({ canonical: "facts", semantic: "" })).toBe(
      "<canonical_memory>\nfacts\n</canonical_memory>",
    );
  });

  it("returns semantic-only block when canonical is empty", () => {
    expect(composeMemoryBlock({ canonical: "", semantic: "retrieved" })).toBe(
      "<semantic_memory>\nretrieved\n</semantic_memory>",
    );
  });

  it("returns canonical first, then semantic, separated by a blank line", () => {
    expect(composeMemoryBlock({ canonical: "facts", semantic: "retrieved" })).toBe(
      "<canonical_memory>\nfacts\n</canonical_memory>\n\n<semantic_memory>\nretrieved\n</semantic_memory>",
    );
  });
});

describe("loadCanonicalMemory", () => {
  it("reads and trims content from OPENCLAW_CANONICAL_MEMORY_PATH when set", () => {
    const readFileSync = vi.fn(() => `\n  ${CANONICAL_BODY}  \n\n`);
    const homedir = vi.fn(() => "/should/not/be/used");
    const log = vi.fn();

    const result = loadCanonicalMemory({
      env: { OPENCLAW_CANONICAL_MEMORY_PATH: "/explicit/MEMORY.md" },
      readFileSync,
      homedir,
      log,
    });

    expect(result).toBe(CANONICAL_BODY);
    expect(readFileSync).toHaveBeenCalledWith("/explicit/MEMORY.md", "utf-8");
    expect(homedir).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("falls back to <home>/.openclaw/workspace/MEMORY.md when env unset", () => {
    const readFileSync = vi.fn(() => CANONICAL_BODY);
    const homedir = vi.fn(() => "/Users/test");
    const log = vi.fn();

    const result = loadCanonicalMemory({
      env: {},
      readFileSync,
      homedir,
      log,
    });

    expect(result).toBe(CANONICAL_BODY);
    expect(readFileSync).toHaveBeenCalledWith(
      path.join("/Users/test", ".openclaw", "workspace", "MEMORY.md"),
      "utf-8",
    );
    expect(homedir).toHaveBeenCalledTimes(1);
  });

  it("treats whitespace-only OPENCLAW_CANONICAL_MEMORY_PATH as unset", () => {
    const readFileSync = vi.fn(() => CANONICAL_BODY);
    const homedir = vi.fn(() => "/Users/test");

    loadCanonicalMemory({
      env: { OPENCLAW_CANONICAL_MEMORY_PATH: "   " },
      readFileSync,
      homedir,
    });

    expect(readFileSync).toHaveBeenCalledWith(
      path.join("/Users/test", ".openclaw", "workspace", "MEMORY.md"),
      "utf-8",
    );
  });

  it.each([
    ["ENOENT", "ENOENT"],
    ["EACCES", "EACCES"],
    ["EISDIR", "EISDIR"],
  ])("returns '' and logs reason=%s without leaking the path body", (_label, code) => {
    const readFileSync = vi.fn(() => {
      throw fsErrorWithCode(code);
    });
    const log = vi.fn();

    const result = loadCanonicalMemory({
      env: { OPENCLAW_CANONICAL_MEMORY_PATH: "/some/nested/dir/MEMORY.md" },
      readFileSync,
      homedir: () => "/Users/test",
      log,
    });

    expect(result).toBe("");
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]?.[0] ?? "";
    expect(message).toContain(`reason=${code}`);
    expect(message).toContain("path=MEMORY.md");
    expect(message).not.toContain("/some/nested/dir");
  });

  it("returns '' and logs reason=unknown on a generic non-Errno throw", () => {
    const readFileSync = vi.fn(() => {
      throw new Error("decoder blew up");
    });
    const log = vi.fn();

    const result = loadCanonicalMemory({
      env: {},
      readFileSync,
      homedir: () => "/Users/test",
      log,
    });

    expect(result).toBe("");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0] ?? "").toContain("reason=unknown");
  });

  it("returns '' for an empty file without logging", () => {
    const log = vi.fn();
    const result = loadCanonicalMemory({
      env: {},
      readFileSync: () => "",
      homedir: () => "/Users/test",
      log,
    });
    expect(result).toBe("");
    expect(log).not.toHaveBeenCalled();
  });

  it("returns '' for a whitespace-only file without logging", () => {
    const log = vi.fn();
    const result = loadCanonicalMemory({
      env: {},
      readFileSync: () => "   \n\t\n  ",
      homedir: () => "/Users/test",
      log,
    });
    expect(result).toBe("");
    expect(log).not.toHaveBeenCalled();
  });

  it("truncates oversize content to OPENCLAW_CANONICAL_MEMORY_MAX_CHARS and logs only sizes", () => {
    const body = "x".repeat(20000);
    const log = vi.fn();
    const result = loadCanonicalMemory({
      env: { OPENCLAW_CANONICAL_MEMORY_MAX_CHARS: "100" },
      readFileSync: () => body,
      homedir: () => "/Users/test",
      log,
    });
    expect(result).toHaveLength(100);
    expect(result).toBe("x".repeat(100));
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("canonical truncated");
    expect(message).toContain("bytes=20000");
    expect(message).toContain("cap=100");
    expect(message).not.toContain(body);
  });

  it("falls back to default cap when OPENCLAW_CANONICAL_MEMORY_MAX_CHARS is garbage", () => {
    const body = "y".repeat(20000);
    const log = vi.fn();
    const result = loadCanonicalMemory({
      env: { OPENCLAW_CANONICAL_MEMORY_MAX_CHARS: "abc" },
      readFileSync: () => body,
      homedir: () => "/Users/test",
      log,
    });
    expect(result).toHaveLength(16384);
    expect(log.mock.calls[0]?.[0] ?? "").toContain("cap=16384");
  });

  it("never logs the canonical body across all observed log invocations", () => {
    const sentinel = "SECRET-SENTINEL-DO-NOT-LEAK";
    const log = vi.fn();

    loadCanonicalMemory({
      env: { OPENCLAW_CANONICAL_MEMORY_MAX_CHARS: "10" },
      readFileSync: () => sentinel.repeat(100),
      homedir: () => "/Users/test",
      log,
    });

    loadCanonicalMemory({
      env: {},
      readFileSync: () => {
        const error = fsErrorWithCode("EACCES");
        (error as Error).message = sentinel;
        throw error;
      },
      homedir: () => "/Users/test",
      log,
    });

    for (const call of log.mock.calls) {
      expect(call[0] ?? "").not.toContain(sentinel);
    }
  });
});

describe("createMemoryContextInjector", () => {
  it("returns the wrap target untouched and skips the adapter when both sources are empty", async () => {
    const { adapter, spy } = fakeAdapter(() => "should not run");
    const canonical = vi.fn(() => "");
    const injector = createMemoryContextInjector({ adapter, canonical });

    expect(await injector.inject({ promptToWrap: "PROMPT", query: "" })).toBe("PROMPT");
    expect(await injector.inject({ promptToWrap: "PROMPT", query: "  \n\t" })).toBe("PROMPT");
    expect(spy).not.toHaveBeenCalled();
    expect(canonical).toHaveBeenCalledTimes(2);
  });

  it("returns the wrap target untouched and consults neither source when already wrapped", async () => {
    const { adapter, spy } = fakeAdapter(() => "should not run");
    const canonical = vi.fn(() => "should-not-load");
    const injector = createMemoryContextInjector({ adapter, canonical });

    const already =
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nq\n</user_request>";
    expect(await injector.inject({ promptToWrap: already, query: "raw" })).toBe(already);
    expect(spy).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it("wraps with canonical-only block when query is empty but canonical is present", async () => {
    const { adapter, spy } = fakeAdapter(() => "should not run");
    const canonical = vi.fn(() => "canonical fact");
    const injector = createMemoryContextInjector({ adapter, canonical });

    const result = await injector.inject({ promptToWrap: "PROMPT BODY", query: "" });

    expect(result).toBe(
      "<memory_context>\n<canonical_memory>\ncanonical fact\n</canonical_memory>\n</memory_context>\n\n<user_request>\nPROMPT BODY\n</user_request>",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("wraps with canonical-only block when semantic adapter returns empty", async () => {
    const { adapter, spy } = fakeAdapter(() => "");
    const canonical = vi.fn(() => "canonical fact");
    const injector = createMemoryContextInjector({ adapter, canonical });

    const result = await injector.inject({ promptToWrap: "PROMPT BODY", query: "raw user question" });

    expect(result).toBe(
      "<memory_context>\n<canonical_memory>\ncanonical fact\n</canonical_memory>\n</memory_context>\n\n<user_request>\nPROMPT BODY\n</user_request>",
    );
    expect(spy).toHaveBeenCalledWith("raw user question");
  });

  it("wraps with semantic-only block (new label) when canonical is absent", async () => {
    const { adapter, spy } = fakeAdapter(() => "remembered fact");
    const canonical = vi.fn(() => "");
    const injector = createMemoryContextInjector({ adapter, canonical });

    const result = await injector.inject({
      promptToWrap: "final layered prompt body",
      query: "raw user question",
    });

    expect(result).toBe(
      "<memory_context>\n<semantic_memory>\nremembered fact\n</semantic_memory>\n</memory_context>\n\n<user_request>\nfinal layered prompt body\n</user_request>",
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("raw user question");
  });

  it("wraps with canonical first, then semantic, when both are present", async () => {
    const { adapter } = fakeAdapter(() => "retrieved fact");
    const canonical = vi.fn(() => "static fact");
    const injector = createMemoryContextInjector({ adapter, canonical });

    const result = await injector.inject({
      promptToWrap: "BODY",
      query: "raw",
    });

    expect(result).toBe(
      "<memory_context>\n<canonical_memory>\nstatic fact\n</canonical_memory>\n\n<semantic_memory>\nretrieved fact\n</semantic_memory>\n</memory_context>\n\n<user_request>\nBODY\n</user_request>",
    );
  });

  it("forwards the raw query (not the wrap target) to the adapter", async () => {
    const { adapter, spy } = fakeAdapter(() => "fact");
    const injector = createMemoryContextInjector({ adapter, canonical: () => "" });

    await injector.inject({
      promptToWrap: "BOOTSTRAP\n\nraw user question",
      query: "raw user question",
    });

    expect(spy).toHaveBeenCalledWith("raw user question");
  });

  it("propagates MemoryContextError from the adapter unchanged (strict mode contract)", async () => {
    const adapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => {
        throw new MemoryContextError("memory CLI exited 2: boom");
      }),
    };
    const injector = createMemoryContextInjector({
      adapter,
      canonical: () => "static fact",
    });

    await expect(
      injector.inject({ promptToWrap: "PROMPT", query: "raw" }),
    ).rejects.toMatchObject({
      name: "MemoryContextError",
      message: expect.stringContaining("memory CLI exited 2"),
    });
  });
});
