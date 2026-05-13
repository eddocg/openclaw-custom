import type {
  MemoryCandidateQueueAdapter,
  MemoryCandidateQueueContext,
  MemoryCandidateQueueResult,
} from "./memory-candidate-queue-adapter.js";
import { containsForbiddenSubstring } from "./memory-ingest-adapter.js";

/**
 * User-visible acknowledgment emitted when an inbound canonical-remember
 * message is diverted into the governed candidate queue. Kept frozen so the
 * runtime seams and tests share the exact wording.
 */
export const CANONICAL_REMEMBER_ACKNOWLEDGMENT =
  "Canonical memory candidate queued for review. No canonical memory was modified.";

/**
 * Narrow trigger tokens recognised by the canonical-remember bridge. The
 * detector is intentionally separate from the broader semantic-ingest
 * `(remember|save) this` family: only the explicit `... canonical` suffix
 * routes traffic here so generic save/remember flows keep their existing
 * semantic ingest path.
 */
const CANONICAL_TRIGGERS = ["remember this canonical", "save this canonical"] as const;

/**
 * Bounded scan window for the wrapped-prompt path, mirroring the semantic
 * ingest adapter. Channel adapters (notably Discord) prepend metadata blocks
 * before the user body, so the trigger can land hundreds of characters in.
 */
const SCAN_WINDOW_CHARS = 1000;

/**
 * Maximum distance (in characters) we scan after the canonical trigger for
 * the explicit `:` separator that marks the start of the canonical payload.
 * Requiring an explicit colon keeps the contract crisp: ambiguous prose like
 * `remember this canonical structure means ...` is rejected.
 */
const COLON_SEARCH_WINDOW_CHARS = 200;

const BOUNDARY_QUOTE_CHARS = new Set(['"', "'", "\u201C", "\u201D", "\u2018", "\u2019", "`"]);

const TRAILING_BOUNDARY_CHARS = new Set([" ", "\t", ":", ",", ";", "\n", "\r"]);

const NOOP_LOG = (_msg: string): void => {};

export type CanonicalRememberMatch = {
  trigger: string;
  /** Absolute index in the original `rawText` where the trigger starts. */
  index: number;
};

/**
 * Locate `(remember|save) this canonical` at a logical message boundary
 * within the first {@link SCAN_WINDOW_CHARS} characters. Mirrors the
 * boundary rules of the existing semantic ingest / candidate queue adapters
 * so wrapped channel prompts (Discord, etc.) match the trigger consistently.
 */
export function findCanonicalRememberTrigger(rawText: string): CanonicalRememberMatch | null {
  if (typeof rawText !== "string" || rawText === "") {
    return null;
  }
  const window = rawText.slice(0, SCAN_WINDOW_CHARS);
  const lowerWindow = window.toLowerCase();
  for (const trigger of CANONICAL_TRIGGERS) {
    let searchFrom = 0;
    while (searchFrom <= lowerWindow.length - trigger.length) {
      const candidate = lowerWindow.indexOf(trigger, searchFrom);
      if (candidate === -1) {
        break;
      }
      if (
        isLeftBoundary(rawText, candidate) &&
        isRightBoundary(rawText, candidate + trigger.length)
      ) {
        return { trigger, index: candidate };
      }
      searchFrom = candidate + 1;
    }
  }
  return null;
}

/**
 * Extract the canonical payload following a matched trigger. The contract
 * requires an explicit `:` separator within {@link COLON_SEARCH_WINDOW_CHARS}
 * characters of the trigger end — descriptive intervening words are allowed
 * (e.g. `remember this canonical operational rule: ...`) but a missing colon
 * yields an empty result so prose-like matches are rejected.
 */
export function extractCanonicalRememberContent(
  rawText: string,
  match: CanonicalRememberMatch,
): string {
  if (typeof rawText !== "string" || rawText === "") {
    return "";
  }
  const afterTrigger = match.index + match.trigger.length;
  if (afterTrigger > rawText.length) {
    return "";
  }
  const searchEnd = Math.min(afterTrigger + COLON_SEARCH_WINDOW_CHARS, rawText.length);
  const colonIdx = rawText.indexOf(":", afterTrigger);
  if (colonIdx === -1 || colonIdx >= searchEnd) {
    return "";
  }
  return rawText.slice(colonIdx + 1).trim();
}

export type CanonicalRememberDivertResult =
  | { diverted: false; reason: CanonicalRememberSkipReason }
  | {
      diverted: true;
      acknowledgment: string;
      enqueueResult: MemoryCandidateQueueResult;
    };

export type CanonicalRememberSkipReason =
  | "queue-disabled"
  | "wrapped"
  | "no-trigger"
  | "empty-content"
  | "enqueue-failed";

export type CanonicalRememberBridge = {
  /**
   * Inspect raw inbound user text. When the candidate queue is enabled and
   * the text matches an explicit canonical-remember trigger with a non-empty
   * payload, forward the payload through the existing candidate queue
   * adapter (synthesizing the canonical `queue memory:` envelope so adapter
   * behaviour is reused unchanged) and return a diversion outcome with the
   * deterministic acknowledgment text. All other inputs return
   * `{ diverted: false }` so existing runtime flow is preserved unchanged.
   */
  divert: (
    rawText: string,
    context?: MemoryCandidateQueueContext,
  ) => Promise<CanonicalRememberDivertResult>;
};

export type CanonicalRememberBridgeDeps = {
  adapter: MemoryCandidateQueueAdapter;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
};

/**
 * Build a canonical-remember bridge bound to an existing candidate queue
 * adapter. The bridge is a *narrow* gate around the adapter: it adds
 * canonical detection in front of the adapter's own `queue memory:` trigger
 * detection, but never replaces the adapter's spawn/grace/timeout contract.
 *
 * Hard invariants enforced here:
 * - No direct database writes; all enqueue work happens via the injected
 *   adapter (which itself spawns the `enqueue-pipeline` CLI).
 * - No auto-approve / auto-apply / scheduler hooks. The adapter call returns
 *   a `queued_for_review` proposal; downstream worker-plan / create-proposal
 *   remain manual operator steps.
 * - Generic `remember this` / `save this` traffic does not match here; it
 *   continues to flow through the existing semantic ingest adapter.
 * - `queue memory: ...` traffic also does not match here; the existing
 *   candidate queue adapter call still handles it on its own seam.
 */
export function createCanonicalRememberBridge(
  deps: CanonicalRememberBridgeDeps,
): CanonicalRememberBridge {
  const log = deps.log ?? NOOP_LOG;
  return {
    divert: async (
      rawText: string,
      context: MemoryCandidateQueueContext = {},
    ): Promise<CanonicalRememberDivertResult> => {
      const env = deps.env ?? process.env;
      if (!isCandidateQueueEnabled(env)) {
        return { diverted: false, reason: "queue-disabled" };
      }
      if (typeof rawText !== "string" || rawText.trim() === "") {
        return { diverted: false, reason: "no-trigger" };
      }
      if (containsForbiddenSubstring(rawText)) {
        return { diverted: false, reason: "wrapped" };
      }
      const match = findCanonicalRememberTrigger(rawText);
      if (!match) {
        return { diverted: false, reason: "no-trigger" };
      }
      const content = extractCanonicalRememberContent(rawText, match);
      if (content === "") {
        return { diverted: false, reason: "empty-content" };
      }
      // Reuse the existing candidate queue adapter unchanged by synthesizing
      // its native `queue memory:` envelope while preserving canonical-rule
      // framing for memory-core's router after the adapter strips that
      // envelope. The bridge remains a thin detector + envelope wrapper so
      // the matching surface stays narrow.
      const synthesized = `queue memory: Remember this canonical operational rule: ${content}`;
      log(
        `[canonical-remember-bridge] divert trigger="${match.trigger}" triggerIndex=${match.index} contentChars=${content.length}`,
      );
      const enqueueResult = await deps.adapter.enqueue(synthesized, context);
      if (
        enqueueResult.status === "succeeded" ||
        enqueueResult.status === "detached"
      ) {
        log(
          `[canonical-remember-bridge] divert status=${enqueueResult.status} acknowledged=true`,
        );
        return {
          diverted: true,
          acknowledgment: CANONICAL_REMEMBER_ACKNOWLEDGMENT,
          enqueueResult,
        };
      }
      // Fail-open: if the underlying queue rejected the synthesized
      // envelope (skipped:disabled / failed / timeout / etc.), do NOT
      // short-circuit the turn. Returning `diverted: false` lets the normal
      // flow proceed unchanged so the operator still gets feedback through
      // the model. The hard invariant of "no direct MEMORY.md write under
      // queue mode" is preserved by the doctor/runtime guards, not by this
      // bridge.
      log(
        `[canonical-remember-bridge] enqueue rejected status=${enqueueResult.status} reason=${enqueueResult.reason ?? "none"}; falling through`,
      );
      return { diverted: false, reason: "enqueue-failed" };
    },
  };
}

function isCandidateQueueEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED;
  if (typeof raw !== "string") {
    return false;
  }
  const lower = raw.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes" || lower === "on";
}

function isLeftBoundary(rawText: string, position: number): boolean {
  if (position === 0) {
    return true;
  }
  let cursor = position - 1;
  while (cursor >= 0) {
    const ch = rawText[cursor];
    if (ch === "\n" || ch === "\r") {
      return true;
    }
    if (ch === " " || ch === "\t") {
      cursor -= 1;
      continue;
    }
    if (BOUNDARY_QUOTE_CHARS.has(ch)) {
      cursor -= 1;
      continue;
    }
    if (ch === ">") {
      cursor -= 1;
      continue;
    }
    return false;
  }
  return true;
}

function isRightBoundary(rawText: string, position: number): boolean {
  if (position >= rawText.length) {
    return true;
  }
  const ch = rawText[position];
  return TRAILING_BOUNDARY_CHARS.has(ch);
}
