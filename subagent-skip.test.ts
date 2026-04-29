import { describe, it, expect, vi, beforeEach } from "vitest";

type Handler = (event: any, ctx: any) => Promise<any>;

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    createSubsystemLogger: () => mockLogger,
  };
});

import plugin from "./index.js";

function createApiMock() {
  const handlers = new Map<string, Handler>();
  const api = {
    config: {
      channels: {
        discord: {
          token: "token",
        },
      },
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as any;

  plugin.register(api);

  async function emit(name: string, event: any, ctx: any) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Handler not found: ${name}`);
    return handler(event, ctx);
  }

  return { emit };
}

describe("discord-tool-status subagent skips", () => {
  beforeEach(() => {
    mockLogger.trace.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
  });

  it("emits skip trace logs for subagent sessions across all relevant hooks", async () => {
    const { emit } = createApiMock();

    const subagentCtx = {
      channelId: "discord",
      sessionKey:
        "agent:main:discord:direct:529296776637972480:subagent:explore:run-1",
    };

    await emit(
      "message_received",
      {
        messageId: "sub-1",
        metadata: { to: "channel:1472937004919423059", senderId: "42" },
      },
      subagentCtx,
    );
    await emit(
      "before_tool_call",
      { toolCallId: "sub-t1", toolName: "memory_search", params: { q: "x" } },
      subagentCtx,
    );
    await emit("after_tool_call", { toolCallId: "sub-t1" }, subagentCtx);
    await emit("message_sending", {}, subagentCtx);
    await emit("before_agent_reply", {}, subagentCtx);
    await emit("agent_end", {}, subagentCtx);

    const traceMessages = mockLogger.trace.mock.calls.map(([msg]) => String(msg));

    expect(traceMessages).toContain(
      "discord-tool-status: message_received: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: before_tool_call: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: after_tool_call: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: message_sending: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: before_agent_reply: skip (active-memory/subagent) session.",
    );
    expect(traceMessages).toContain(
      "discord-tool-status: message_received: skip subagent session.",
    );
  });
});
