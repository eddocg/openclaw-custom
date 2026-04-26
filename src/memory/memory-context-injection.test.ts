import { describe, expect, it, vi } from "vitest";
import {
  MemoryContextError,
  type MemoryContextAdapter,
} from "./memory-context-adapter.js";
import {
  createMemoryContextInjector,
  isPromptAlreadyWrapped,
  wrapPromptWithMemoryContext,
} from "./memory-context-injection.js";

function fakeAdapter(impl: (query: string) => Promise<string> | string): {
  adapter: MemoryContextAdapter;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (query: string) => impl(query));
  return { adapter: { resolveContext: spy }, spy };
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

describe("createMemoryContextInjector", () => {
  it("returns the wrap target untouched and skips the adapter for empty queries", async () => {
    const { adapter, spy } = fakeAdapter(() => "should not run");
    const injector = createMemoryContextInjector({ adapter });

    expect(await injector.inject({ promptToWrap: "PROMPT", query: "" })).toBe("PROMPT");
    expect(await injector.inject({ promptToWrap: "PROMPT", query: "  \n\t" })).toBe("PROMPT");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the wrap target untouched and skips the adapter when already wrapped", async () => {
    const { adapter, spy } = fakeAdapter(() => "should not run");
    const injector = createMemoryContextInjector({ adapter });

    const already =
      "<memory_context>\nprior\n</memory_context>\n\n<user_request>\nq\n</user_request>";
    expect(await injector.inject({ promptToWrap: already, query: "raw" })).toBe(already);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the wrap target untouched when the adapter returns an empty block", async () => {
    const { adapter } = fakeAdapter(() => "");
    const injector = createMemoryContextInjector({ adapter });

    expect(await injector.inject({ promptToWrap: "PROMPT", query: "raw" })).toBe("PROMPT");
  });

  it("wraps the wrap target when the adapter returns a non-empty block", async () => {
    const { adapter, spy } = fakeAdapter(() => "remembered fact");
    const injector = createMemoryContextInjector({ adapter });

    const result = await injector.inject({
      promptToWrap: "final layered prompt body",
      query: "raw user question",
    });

    expect(result).toBe(
      "<memory_context>\nremembered fact\n</memory_context>\n\n<user_request>\nfinal layered prompt body\n</user_request>",
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("raw user question");
  });

  it("forwards the raw query (not the wrap target) to the adapter", async () => {
    const { adapter, spy } = fakeAdapter(() => "fact");
    const injector = createMemoryContextInjector({ adapter });

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
    const injector = createMemoryContextInjector({ adapter });

    await expect(
      injector.inject({ promptToWrap: "PROMPT", query: "raw" }),
    ).rejects.toMatchObject({
      name: "MemoryContextError",
      message: expect.stringContaining("memory CLI exited 2"),
    });
  });
});
