import os from "node:os";
import path from "node:path";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

// Regression: memory-context injection used to live inside AcpGatewayAgent.prompt.
// It now lives in the shared injector wired into the embedded runner and
// AcpSessionManager.runTurn, so all runtime paths share a single wrap and the
// translator no longer touches `openclaw-memory-core`. These tests guard against
// reintroduction of an ACP-translator-local wrap (which would cause double
// injection in the gateway path).

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

async function runAgent(options: { prefixCwd?: boolean } = {}) {
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
      prefixCwd: options.prefixCwd,
    },
  );

  return { agent, requestSpy };
}

describe("acp translator memory-context regression", () => {
  it("forwards the raw user text with the cwd prefix and no memory wrap", async () => {
    const { agent, requestSpy } = await runAgent();

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");

    expect(requestSpy).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: expect.stringMatching(/\[Working directory: [^\]]+\]\n\nwhat is foo\?$/),
      }),
      { timeoutMs: null },
    );
    const message = getSentMessage(requestSpy);
    expect(message).not.toContain("<memory_context>");
    expect(message).not.toContain("</memory_context>");
    expect(message).not.toContain("<user_request>");
    expect(message).not.toContain("</user_request>");
  });

  it("forwards the raw user text with no prefix when prefixCwd=false", async () => {
    const { agent, requestSpy } = await runAgent({ prefixCwd: false });

    await expect(agent.prompt(TEST_PROMPT)).rejects.toThrow("stop-after-send");

    const message = getSentMessage(requestSpy);
    expect(message).toBe(USER_TEXT);
    expect(message).not.toContain("<memory_context>");
    expect(message).not.toContain("<user_request>");
  });
});
