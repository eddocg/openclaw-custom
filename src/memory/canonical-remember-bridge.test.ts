import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_REMEMBER_ACKNOWLEDGMENT,
  createCanonicalRememberBridge,
  extractCanonicalRememberContent,
  findCanonicalRememberTrigger,
} from "./canonical-remember-bridge.js";
import type {
  MemoryCandidateQueueAdapter,
  MemoryCandidateQueueResult,
} from "./memory-candidate-queue-adapter.js";

function makeQueueAdapter(
  result: MemoryCandidateQueueResult = { status: "succeeded", candidateId: "cand-1" },
): MemoryCandidateQueueAdapter {
  return {
    enqueue: vi.fn(async (): Promise<MemoryCandidateQueueResult> => result),
  };
}

const ENABLED_ENV = {
  OPENCLAW_MEMORY_CANDIDATE_QUEUE_ENABLED: "true",
} as NodeJS.ProcessEnv;
const DISABLED_ENV = {} as NodeJS.ProcessEnv;

describe("findCanonicalRememberTrigger", () => {
  it("matches `remember this canonical` at start of text with colon", () => {
    const match = findCanonicalRememberTrigger(
      "remember this canonical operational rule: do not auto-merge",
    );
    expect(match).toEqual({ trigger: "remember this canonical", index: 0 });
  });

  it("matches `save this canonical` at start of text with colon", () => {
    const match = findCanonicalRememberTrigger(
      "save this canonical: operators always require review",
    );
    expect(match).toEqual({ trigger: "save this canonical", index: 0 });
  });

  it("matches with leading whitespace and capitalization", () => {
    const match = findCanonicalRememberTrigger(
      "  Remember this canonical operational rule: never auto-apply",
    );
    expect(match).not.toBeNull();
    expect(match?.trigger).toBe("remember this canonical");
  });

  it("matches inside wrapped channel prompts (after a newline)", () => {
    const wrapped = [
      "Sender info: discord-user-1",
      "Channel: #ops",
      "",
      "Remember this canonical: governed proposal bridge requires human review",
    ].join("\n");
    const match = findCanonicalRememberTrigger(wrapped);
    expect(match).not.toBeNull();
    expect(match?.trigger).toBe("remember this canonical");
    expect(wrapped.slice(match?.index ?? 0).startsWith("Remember this canonical")).toBe(true);
  });

  it("does not match generic `remember this` without `canonical`", () => {
    expect(findCanonicalRememberTrigger("remember this: take out trash")).toBeNull();
    expect(findCanonicalRememberTrigger("save this: use TLS 1.3")).toBeNull();
  });

  it("does not match inside a longer word", () => {
    expect(findCanonicalRememberTrigger("remember this canonicalizing routine")).toBeNull();
  });

  it("does not match in mid-prose context", () => {
    expect(
      findCanonicalRememberTrigger(
        "and we should remember this canonical rule about merges",
      ),
    ).toBeNull();
  });

  it("does not match when text is empty", () => {
    expect(findCanonicalRememberTrigger("")).toBeNull();
  });
});

describe("extractCanonicalRememberContent", () => {
  it("returns the post-colon payload trimmed", () => {
    const text = "remember this canonical operational rule: do not auto-merge";
    const match = findCanonicalRememberTrigger(text);
    expect(match).not.toBeNull();
    if (!match) {
      throw new Error("expected match");
    }
    expect(extractCanonicalRememberContent(text, match)).toBe("do not auto-merge");
  });

  it("returns empty string when no colon follows the trigger", () => {
    const text = "remember this canonical operational rule do not auto-merge";
    const match = { trigger: "remember this canonical", index: 0 };
    expect(extractCanonicalRememberContent(text, match)).toBe("");
  });

  it("handles immediate colon with no descriptors", () => {
    const text = "remember this canonical: payload";
    const match = findCanonicalRememberTrigger(text);
    if (!match) {
      throw new Error("expected match");
    }
    expect(extractCanonicalRememberContent(text, match)).toBe("payload");
  });
});

describe("createCanonicalRememberBridge", () => {
  it("returns diverted=false when the candidate queue is disabled", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: DISABLED_ENV });
    const result = await bridge.divert("remember this canonical: rule");
    expect(result).toEqual({ diverted: false, reason: "queue-disabled" });
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  it("returns diverted=false when the detector does not match", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert("remember this: nothing canonical");
    expect(result.diverted).toBe(false);
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  it("returns diverted=false when the canonical content is empty after the colon", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert("remember this canonical:    ");
    expect(result).toEqual({ diverted: false, reason: "empty-content" });
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  it("calls adapter.enqueue exactly once with canonical/durable framed content", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert(
      "remember this canonical operational rule: governed proposal bridge requires review",
      { source: "discord", sessionKey: "agent:main:explicit:abc", requestId: "r-1" },
    );
    expect(adapter.enqueue).toHaveBeenCalledTimes(1);
    const args = (adapter.enqueue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args?.[0]).toBe(
      "queue memory: Remember this canonical operational rule: governed proposal bridge requires review",
    );
    expect(args?.[0]).toContain("Remember this canonical operational rule:");
    expect(args?.[1]).toEqual({
      source: "discord",
      sessionKey: "agent:main:explicit:abc",
      requestId: "r-1",
    });
    expect(result.diverted).toBe(true);
    if (result.diverted) {
      expect(result.acknowledgment).toBe(CANONICAL_REMEMBER_ACKNOWLEDGMENT);
      expect(result.enqueueResult.status).toBe("succeeded");
    }
  });

  it("treats `detached` as a successful divert (grace expiry path)", async () => {
    const adapter = makeQueueAdapter({ status: "detached", reason: "grace expired" });
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert(
      "save this canonical: operators must approve every release",
    );
    expect(result.diverted).toBe(true);
  });

  it("falls through (no short-circuit) when the underlying enqueue rejects", async () => {
    const adapter = makeQueueAdapter({ status: "failed", reason: "spawn error" });
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert("remember this canonical: payload");
    expect(result).toEqual({ diverted: false, reason: "enqueue-failed" });
  });

  it("does not match `queue memory:` traffic so the existing seam keeps it", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert("queue memory: rule about merges");
    expect(result.diverted).toBe(false);
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  it("does not match generic `remember this` (semantic ingest territory)", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const result = await bridge.divert("remember this: bring milk");
    expect(result.diverted).toBe(false);
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });

  it("rejects wrapped prompts containing `<memory_context>` tokens", async () => {
    const adapter = makeQueueAdapter();
    const bridge = createCanonicalRememberBridge({ adapter, env: ENABLED_ENV });
    const wrapped =
      "<memory_context>...</memory_context>\nremember this canonical: payload";
    const result = await bridge.divert(wrapped);
    expect(result).toEqual({ diverted: false, reason: "wrapped" });
    expect(adapter.enqueue).not.toHaveBeenCalled();
  });
});
