import {
  createMemoryContextAdapter,
  type MemoryContextAdapter,
} from "./memory-context-adapter.js";

const OPEN_TAG = "<memory_context>\n";
const CLOSE_TAG = "\n</memory_context>";
const SCAN_LIMIT_BYTES = 32 * 1024;

export type MemoryContextInjectInput = {
  /**
   * The string that will be wrapped (and ultimately submitted to the model)
   * if the memory adapter returns a non-empty block. The embedded runner
   * passes its final layered prompt here; the ACP control plane passes
   * the raw user text.
   */
  promptToWrap: string;
  /**
   * The query forwarded to the memory adapter for retrieval. Callers should
   * pass the raw user prompt here even when `promptToWrap` is a layered
   * variant (e.g. with bootstrap warnings prepended).
   */
  query: string;
};

export type MemoryContextInjector = {
  inject: (input: MemoryContextInjectInput) => Promise<string>;
};

export type MemoryContextInjectorDeps = {
  adapter?: MemoryContextAdapter;
  log?: (msg: string) => void;
};

/**
 * Detects an existing `<memory_context>` ... `</memory_context>` envelope in
 * the first 32 KiB of the prompt. The cap protects against pathological large
 * prompts; production callers wrap relatively short user text or layered
 * runner prompts well within that bound.
 */
export function isPromptAlreadyWrapped(prompt: string): boolean {
  if (!prompt) {
    return false;
  }
  const head = prompt.length > SCAN_LIMIT_BYTES ? prompt.slice(0, SCAN_LIMIT_BYTES) : prompt;
  const open = head.indexOf(OPEN_TAG);
  if (open < 0) {
    return false;
  }
  const close = head.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
  return close > open;
}

export function wrapPromptWithMemoryContext(promptToWrap: string, memoryBlock: string): string {
  return (
    `<memory_context>\n${memoryBlock}\n</memory_context>\n\n` +
    `<user_request>\n${promptToWrap}\n</user_request>`
  );
}

export function createMemoryContextInjector(
  deps: MemoryContextInjectorDeps = {},
): MemoryContextInjector {
  const adapter = deps.adapter ?? createMemoryContextAdapter({ log: deps.log });

  return {
    inject: async ({ promptToWrap, query }: MemoryContextInjectInput): Promise<string> => {
      if (!query || query.trim() === "") {
        return promptToWrap;
      }
      if (isPromptAlreadyWrapped(promptToWrap)) {
        return promptToWrap;
      }
      const memoryBlock = await adapter.resolveContext(query);
      if (!memoryBlock) {
        return promptToWrap;
      }
      return wrapPromptWithMemoryContext(promptToWrap, memoryBlock);
    },
  };
}
