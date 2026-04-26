import { readFileSync as nodeReadFileSync } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import path from "node:path";

import {
  createMemoryContextAdapter,
  type MemoryContextAdapter,
} from "./memory-context-adapter.js";

const OPEN_TAG = "<memory_context>\n";
const CLOSE_TAG = "\n</memory_context>";
const SCAN_LIMIT_BYTES = 32 * 1024;

const DEFAULT_CANONICAL_MAX_CHARS = 16384;
const MIN_CANONICAL_MAX_CHARS = 1;
const CANONICAL_DEFAULT_BASENAME = "MEMORY.md";
const CANONICAL_DEFAULT_DIRS = [".openclaw", "workspace"] as const;

export type MemoryContextInjectInput = {
  /**
   * The string that will be wrapped (and ultimately submitted to the model)
   * if a non-empty memory block (canonical and/or semantic) is resolved.
   * The embedded runner passes its final layered prompt here; the ACP
   * control plane passes the raw user text.
   */
  promptToWrap: string;
  /**
   * The query forwarded to the semantic memory adapter for retrieval.
   * Callers should pass the raw user prompt here even when `promptToWrap`
   * is a layered variant (e.g. with bootstrap warnings prepended).
   * Canonical memory does not consume this query; it is sourced from a
   * static workspace file.
   */
  query: string;
};

export type MemoryContextInjector = {
  inject: (input: MemoryContextInjectInput) => Promise<string>;
};

export type CanonicalMemoryLoader = () => string;

export type CanonicalMemoryLoaderDeps = {
  env?: NodeJS.ProcessEnv;
  readFileSync?: (path: string, encoding: "utf-8") => string;
  homedir?: () => string;
  log?: (msg: string) => void;
};

export type MemoryContextInjectorDeps = {
  adapter?: MemoryContextAdapter;
  log?: (msg: string) => void;
  /**
   * Test seam for the canonical-memory loader. Defaults to a closure over
   * {@link loadCanonicalMemory} bound to the live env/fs/homedir and the
   * injector's `log` callback. Tests can pass a stub here to avoid the
   * filesystem entirely.
   */
  canonical?: CanonicalMemoryLoader;
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

/**
 * Compose the inner labeled memory block placed inside the `<memory_context>`
 * envelope. Canonical memory always renders before semantic memory so the
 * model sees operator-authored facts first, then retrieved context.
 *
 * - both empty -> empty string (caller short-circuits the wrap)
 * - canonical only -> `<canonical_memory>...</canonical_memory>`
 * - semantic only -> `<semantic_memory>...</semantic_memory>`
 * - both -> canonical block, blank line, semantic block
 */
export function composeMemoryBlock({
  canonical,
  semantic,
}: {
  canonical: string;
  semantic: string;
}): string {
  const sections: string[] = [];
  if (canonical && canonical.length > 0) {
    sections.push(`<canonical_memory>\n${canonical}\n</canonical_memory>`);
  }
  if (semantic && semantic.length > 0) {
    sections.push(`<semantic_memory>\n${semantic}\n</semantic_memory>`);
  }
  return sections.join("\n\n");
}

/**
 * Wrap `promptToWrap` with the documented `<memory_context>` /
 * `<user_request>` envelope around an already-composed memory block.
 *
 * The single-string signature is preserved for backwards compatibility with
 * callers that maintain their own labeling (existing tests, external code).
 * The injector itself uses {@link composeMemoryBlock} to build the inner
 * canonical/semantic structure and then hands the result to this function.
 */
export function wrapPromptWithMemoryContext(promptToWrap: string, memoryBlock: string): string {
  return (
    `<memory_context>\n${memoryBlock}\n</memory_context>\n\n` +
    `<user_request>\n${promptToWrap}\n</user_request>`
  );
}

/**
 * Load canonical memory from `OPENCLAW_CANONICAL_MEMORY_PATH` (when set) or
 * the default `<home>/.openclaw/workspace/MEMORY.md` location. Fails open:
 * a missing file, unreadable file, or empty/whitespace-only file all return
 * the empty string. The trimmed content is hard-capped by
 * `OPENCLAW_CANONICAL_MEMORY_MAX_CHARS` (default 16384) to bound the prompt
 * budget. Logs are bounded and never include the canonical body.
 */
export function loadCanonicalMemory(deps: CanonicalMemoryLoaderDeps = {}): string {
  const env = deps.env ?? process.env;
  const readFileSync = deps.readFileSync ?? nodeReadFileSync;
  const homedir = deps.homedir ?? nodeHomedir;
  const log = deps.log ?? (() => {});

  const filePath = resolveCanonicalPath(env, homedir);
  const cap = parsePositiveInt(
    env.OPENCLAW_CANONICAL_MEMORY_MAX_CHARS,
    DEFAULT_CANONICAL_MAX_CHARS,
    MIN_CANONICAL_MAX_CHARS,
  );

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    const reason = describeFsError(error);
    log(
      `[memory-context] canonical load failed reason=${reason} path=${path.basename(filePath)}`,
    );
    return "";
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return "";
  }

  if (trimmed.length > cap) {
    log(`[memory-context] canonical truncated bytes=${trimmed.length} cap=${cap}`);
    return trimmed.slice(0, cap);
  }

  return trimmed;
}

export function createMemoryContextInjector(
  deps: MemoryContextInjectorDeps = {},
): MemoryContextInjector {
  const adapter = deps.adapter ?? createMemoryContextAdapter({ log: deps.log });
  const log = deps.log;
  const canonicalLoader: CanonicalMemoryLoader =
    deps.canonical ?? (() => loadCanonicalMemory({ log }));

  return {
    inject: async ({ promptToWrap, query }: MemoryContextInjectInput): Promise<string> => {
      if (isPromptAlreadyWrapped(promptToWrap)) {
        return promptToWrap;
      }

      const canonical = canonicalLoader();

      let semantic = "";
      if (query && query.trim() !== "") {
        semantic = await adapter.resolveContext(query);
      }

      const memoryBlock = composeMemoryBlock({ canonical, semantic });
      if (!memoryBlock) {
        return promptToWrap;
      }

      return wrapPromptWithMemoryContext(promptToWrap, memoryBlock);
    },
  };
}

function resolveCanonicalPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  const explicit = env.OPENCLAW_CANONICAL_MEMORY_PATH;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit.trim();
  }
  return path.join(homedir(), ...CANONICAL_DEFAULT_DIRS, CANONICAL_DEFAULT_BASENAME);
}

function describeFsError(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code !== ""
  ) {
    return (error as { code: string }).code;
  }
  return "unknown";
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}
