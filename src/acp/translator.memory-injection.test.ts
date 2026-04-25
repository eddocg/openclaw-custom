import os from "node:os";
import path from "node:path";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  MemoryContextError,
  type MemoryContextAdapter,
} from "../memory/memory-context-adapter.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

const TEST_SESSION_ID = "session-mem";
const TEST_SESSION_KEY = "agent:main:main";
const USER_TEXT = "what is foo?";
const TEST_PROMPT = {
  sessionId: TEST_SESSION_ID,
  prompt: [{ type: "text", text: USER_TEXT }],
  _meta: {},
} as unknown as PromptRequest;

type ChatSendBody = { message: string };

function createStopAfterSendSpy() {
  return vi.fn(async (method: string, _params?: ChatSendBody) => {
    if (method === "chat.send") {
      throw new Error("stop-after-send");
    }
    return {};
  });
}

function getSentMessage(spy: ReturnType<typeof createStopAfterSendSpy>): string {
  const call = spy.mock.calls[0];
  if (!call) {
    throw new Error("expected chat.send to have been called");
  }
  const body = call[1];
  if (!body) {
    throw new Error("chat.send call did not include a body");
  }
  return body.message;
}

async function runWithMemoryAdapter(
  memoryAdapter: MemoryContextAdapter,
  options: { prefixCwd?: boolean } = {},
) {
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    cwd: path.join(os.homedir(), "openclaw-test"),
  });

  const requestSpy = createStopAfterSendSpy();
  const agent = new AcpGatewayAgent(
    createAcpConnection(),
    createAcpGateway(requestSpy as unknown as GatewayClient["request"]),
    {
      sessionStore,
      memoryAdapter,
      prefixCwd: options.prefixCwd,
    },
  );

  return { agent, requestSpy };
}

describe("acp memory-context injection", () => {
  it("does not wrap the user message when memory adapter returns empty (regression)", async () => {
    const memoryAdapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => ""),
    };
    const { agent, requestSpy } = await runWithMemoryAdapter(memoryAdapter);

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");

    expect(memoryAdapter.resolveContext).toHaveBeenCalledWith(USER_TEXT);
    expect(requestSpy).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: expect.stringMatching(
          /\[Working directory: [^\]]+\]\n\nwhat is foo\?$/,
        ),
      }),
      { timeoutMs: null },
    );
    const message = getSentMessage(requestSpy);
    expect(message).not.toContain("<memory_context>");
    expect(message).not.toContain("<user_request>");
  });

  it("wraps the message in <memory_context>/<user_request> when adapter returns a block", async () => {
    const memoryAdapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => "prior fact about foo"),
    };
    const { agent, requestSpy } = await runWithMemoryAdapter(memoryAdapter);

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");

    const message = getSentMessage(requestSpy);
    expect(message).toMatch(/^\[Working directory: [^\]]+\]\n\n<memory_context>\n/);
    expect(message).toContain("<memory_context>\nprior fact about foo\n</memory_context>");
    expect(message).toContain(`<user_request>\n${USER_TEXT}\n</user_request>`);
  });

  it("omits the working-directory prefix but still wraps memory when prefixCwd=false", async () => {
    const memoryAdapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => "remembered"),
    };
    const { agent, requestSpy } = await runWithMemoryAdapter(memoryAdapter, {
      prefixCwd: false,
    });

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");

    const message = getSentMessage(requestSpy);
    expect(message.startsWith("<memory_context>\nremembered\n</memory_context>")).toBe(true);
    expect(message).toContain(`<user_request>\n${USER_TEXT}\n</user_request>`);
    expect(message).not.toContain("[Working directory:");
  });

  it("propagates MemoryContextError thrown by the adapter (strict-mode behavior)", async () => {
    const memoryAdapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => {
        throw new MemoryContextError("memory CLI exited 2: boom");
      }),
    };
    const { agent, requestSpy } = await runWithMemoryAdapter(memoryAdapter);

    await expect(agent.prompt(TEST_PROMPT)).rejects.toMatchObject({
      name: "MemoryContextError",
      message: expect.stringContaining("memory CLI exited 2"),
    });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("rejects when the assembled message (with memory) exceeds MAX_PROMPT_BYTES", async () => {
    const oversize = "x".repeat(2 * 1024 * 1024 + 1024);
    const memoryAdapter: MemoryContextAdapter = {
      resolveContext: vi.fn(async () => oversize),
    };
    const { agent, requestSpy } = await runWithMemoryAdapter(memoryAdapter);

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow(/Prompt exceeds maximum allowed size/);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
