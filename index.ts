import {
  createSubsystemLogger,
  definePluginEntry,
  type OpenClawPluginApi,
} from "./api.js";
import { resolveDiscordToken } from "./token.js";

const logger = createSubsystemLogger("plugins");

type ChannelMeta = {
  actualChannelId: string;
  userMessageId?: string;
  senderId?: string;
  accountId?: string;
  sourceSessionKey?: string;
};

type ToolEntry = {
  toolCallId: string;
  toolName: string;
  params: any;
  status: "pending" | "completed";
};

type AgentMessageContentItem = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

type AgentEventMessage = {
  role?: string;
  content?: AgentMessageContentItem[];
  toolCallId?: string;
  toolName?: string;
};

type SessionEntry = {
  contextKey: string;
  channelId: string;
  userMessageId?: string;
  senderId?: string;
  accountId?: string;
  ownerSessionKey: string;
  generation: number;
  statusMessageId?: string;
  toolHistory: ToolEntry[];
  pendingOp?: Promise<void>;
  clearTimer?: ReturnType<typeof setTimeout>;
};

const sessionContextMap = new Map<string, ChannelMeta>();
const activeSessions = new Map<string, SessionEntry>();

const MAX_RETRIES = 2;
const RETRY_FALLBACK_MS = 1000;
const SESSION_RESOLVE_RETRY_MS = 75;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function getRetryDelayMs(res: Response): Promise<number> {
  const headerVal = Number(res.headers.get("retry-after"));
  if (Number.isFinite(headerVal) && headerVal > 0) {
    return Math.ceil(headerVal * 1000);
  }

  try {
    const body = (await res.clone().json()) as { retry_after?: unknown };
    const bodyVal = Number(body.retry_after);
    if (Number.isFinite(bodyVal) && bodyVal > 0) {
      return Math.ceil(bodyVal * 1000);
    }
  } catch {
    // Ignore parse errors; use fallback delay.
  }

  return RETRY_FALLBACK_MS;
}

async function discordApiRequest(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429) {
      return res;
    }

    const delayMs = await getRetryDelayMs(res);
    logger.warn(`discord-tool-status: ${operation} hit rate limit.`, {
      subsystem: "plugins",
      status: res.status,
      retryInMs: delayMs,
      attempt,
    });

    if (attempt === MAX_RETRIES) {
      return res;
    }
    await sleep(delayMs);
  }

  throw new Error("discord-tool-status: unexpected retry loop exit");
}

function clearSessionState(
  contextKey: string,
  session?: SessionEntry,
  expectedGeneration?: number,
  expectedOwner?: string,
) {
  if (session) {
    const current = activeSessions.get(contextKey);
    if (current !== session) {
      return;
    }
    if (
      current &&
      expectedGeneration !== undefined &&
      current.generation !== expectedGeneration
    ) {
      return;
    }
    if (
      current &&
      expectedOwner !== undefined &&
      current.ownerSessionKey !== expectedOwner
    ) {
      return;
    }
  }

  if (session?.clearTimer) {
    clearTimeout(session.clearTimer);
    session.clearTimer = undefined;
  }
  activeSessions.delete(contextKey);
  sessionContextMap.delete(contextKey);
}

function isCurrentSession(session: SessionEntry): boolean {
  return activeSessions.get(session.contextKey) === session;
}

function hasVisibleStatusState(session: SessionEntry): boolean {
  return Boolean(session.statusMessageId) || session.toolHistory.length > 0;
}

async function waitForPendingOp(session: SessionEntry, hookName: string) {
  if (!session.pendingOp) return;
  logger.debug(`discord-tool-status: [${hookName}] Waiting for pending op...`, {
    subsystem: "plugins",
  });
  try {
    await session.pendingOp;
  } catch (err) {
    logger.warn(`discord-tool-status: [${hookName}] Pending op failed.`, {
      subsystem: "plugins",
      error: String(err),
    });
  }
}

function getOrCreateSession(
  contextKey: string,
  requestSessionKey?: string,
): SessionEntry | undefined {
  const normalizedRequestSessionKey =
    typeof requestSessionKey === "string" && requestSessionKey.trim().length > 0
      ? requestSessionKey
      : undefined;

  const context = sessionContextMap.get(contextKey);
  const preferredOwner = context?.sourceSessionKey;
  const existing = activeSessions.get(contextKey);
  if (existing) {
    if (
      normalizedRequestSessionKey &&
      existing.ownerSessionKey === normalizedRequestSessionKey
    ) {
      return existing;
    }

    if (
      normalizedRequestSessionKey &&
      preferredOwner &&
      normalizedRequestSessionKey === preferredOwner
    ) {
      return undefined;
    }

    if (
      preferredOwner &&
      existing.ownerSessionKey === preferredOwner &&
      normalizedRequestSessionKey &&
      normalizedRequestSessionKey !== preferredOwner
    ) {
      return undefined;
    }

    return existing;
  }

  if (!context) return undefined;

  if (
    preferredOwner &&
    normalizedRequestSessionKey &&
    normalizedRequestSessionKey !== preferredOwner
  ) {
    return undefined;
  }

  const ownerSessionKey =
    normalizedRequestSessionKey || preferredOwner || contextKey;

  const created: SessionEntry = {
    contextKey,
    channelId: context.actualChannelId,
    userMessageId: context.userMessageId,
    senderId: context.senderId,
    accountId: context.accountId,
    ownerSessionKey,
    generation: 1,
    toolHistory: [],
  };
  activeSessions.set(contextKey, created);
  return created;
}

async function retireSession(
  session: SessionEntry,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  if (session.clearTimer) {
    clearTimeout(session.clearTimer);
    session.clearTimer = undefined;
  }

  await waitForPendingOp(session, `${hookName}_retire_wait`);

  if (!session.statusMessageId) {
    session.toolHistory = [];
    return;
  }

  const token = getToken(session.accountId);
  if (!token) {
    session.toolHistory = [];
    return;
  }

  const staleMsgId = session.statusMessageId;
  const deleted = await deleteMessage(session.channelId, staleMsgId, token);
  if (deleted && session.statusMessageId === staleMsgId) {
    session.statusMessageId = undefined;
  }
  session.toolHistory = [];
}

async function resolveSession(
  contextKey: string,
  requestSessionKey?: string,
): Promise<SessionEntry | undefined> {
  const immediate = getOrCreateSession(contextKey, requestSessionKey);
  if (immediate) return immediate;

  await sleep(SESSION_RESOLVE_RETRY_MS);
  return getOrCreateSession(contextKey, requestSessionKey);
}

function scheduleSessionCleanup(
  contextKey: string,
  session: SessionEntry,
  requestSessionKey: string | undefined,
  delayMs: number,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  if (requestSessionKey && session.ownerSessionKey !== requestSessionKey) {
    return;
  }

  const expectedGeneration = session.generation;
  const expectedOwner = session.ownerSessionKey;

  if (session.clearTimer) {
    clearTimeout(session.clearTimer);
  }

  session.clearTimer = setTimeout(() => {
    const current = activeSessions.get(contextKey);
    if (
      !current ||
      current !== session ||
      current.generation !== expectedGeneration ||
      current.ownerSessionKey !== expectedOwner
    ) {
      return;
    }

    clearStatusMessage(session, hookName, getToken)
      .catch((err) => {
        logger.warn(
          `discord-tool-status: Failed to clear status message on ${hookName}`,
          {
            subsystem: "plugins",
            contextKey,
            error: String(err),
          },
        );
      })
      .finally(() => {
        clearSessionState(
          contextKey,
          session,
          expectedGeneration,
          expectedOwner,
        );
      });
  }, delayMs);
}

function getToolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("web_search")) return "🔎";
  if (n.includes("web_fetch")) return "🗳️";
  if (n.includes("browser")) return "🌎";
  if (n.includes("memory")) return "🧠";
  if (n.includes("wiki")) {
    if (n.includes("search")) return "🕵️";
    if (n.includes("apply")) return "🧱";
    if (n.includes("lint")) return "🧼";
    if (n.includes("status")) return "📡";
    return "📒";
  }
  if (n.includes("deepwiki")) {
    if (n.includes("ask")) return "🐙";
    return "📚";
  }
  if (n.includes("context7")) {
    if (n.includes("resolve")) return "🧩";
    return "🗞️";
  }
  if (n.includes("google-developer")) {
    if (n.includes("search") || n.includes("answer")) return "🔭";
    return "📂";
  }
  if (n.includes("read")) return "📖";
  if (n.includes("write")) return "✍️";
  if (n.includes("edit")) return "🛠️";
  if (n.includes("diff")) return "⚖️";
  if (n.includes("exec")) return "🚀";
  if (n.includes("process")) return "⏳";
  if (n.includes("image_generate")) return "🧪";
  if (n.includes("image")) return "🖼️";
  if (n.includes("pdf")) return "📜";
  if (n.includes("message")) return "✉️";
  if (n.includes("sequential")) return "🔗";
  if (n.includes("session_status")) return "🎬";
  if (n.includes("sessions_history")) return "🕰️";
  if (n.includes("sessions_list")) return "🔖";
  if (n.includes("sessions_send")) return "🛸";
  if (n.includes("sessions_spawn")) return "🐣";
  if (n.includes("sessions_yield")) return "🏁";
  if (n.includes("agents_list") || n.includes("subagents")) return "👥";
  return "💡";
}

function formatParams(params: any): string {
  if (!params || typeof params !== "object") return "";
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v], index) => {
      const keyPrefix = index === 0 ? "   - " : "     ";
      const valueIndent = index === 0 ? "      " : "      ";
      let val = typeof v === "string" ? v : JSON.stringify(v, null, 5);
      val = val.trim();

      if (val.includes("\n")) {
        let displayVal = val;
        if (displayVal.length > 1000) {
          displayVal = displayVal.substring(0, 1000) + "... (truncated)";
        }
        const lines = displayVal
          .split("\n")
          .map((line) => `${valueIndent}${line}`)
          .join("\n");
        return `${keyPrefix}${k}: |\n${lines}`;
      } else {
        if (val.length > 200) val = val.substring(0, 200) + "...";
        return `${keyPrefix}${k}: ${val}`;
      }
    })
    .join("\n");
}

function getDiscordContextKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(
    /discord:(?:channel|direct|group|dm|chat):[^:]+/i,
  );
  return match ? match[0].toLowerCase() : undefined;
}

function isSubagentSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":subagent:");
}

function isActiveMemorySessionKey(sessionKey: string | undefined): boolean {
  return (
    typeof sessionKey === "string" && sessionKey.includes(":active-memory:")
  );
}

function getActiveMemorySourceSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const idx = sessionKey!.indexOf(":active-memory:");
  if (idx <= 0) {
    return undefined;
  }
  return sessionKey!.slice(0, idx);
}

function parseActiveMemoryToolEntries(event: any): ToolEntry[] {
  const messages = (event?.messages ?? []) as AgentEventMessage[];
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const byToolCallId = new Map<string, ToolEntry>();
  const completion = new Set<string>();

  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item?.type !== "toolCall") continue;
        if (!item.id || !item.name) continue;

        const prefixedId = `active-memory:${item.id}`;
        byToolCallId.set(prefixedId, {
          toolCallId: prefixedId,
          toolName: `active-memory:${item.name}`,
          params: item.arguments ?? {},
          status: "pending",
        });
      }
      continue;
    }

    if (msg?.role === "toolResult" && msg.toolCallId) {
      completion.add(`active-memory:${msg.toolCallId}`);
      if (!byToolCallId.has(`active-memory:${msg.toolCallId}`)) {
        byToolCallId.set(`active-memory:${msg.toolCallId}`, {
          toolCallId: `active-memory:${msg.toolCallId}`,
          toolName: `active-memory:${msg.toolName || "unknown"}`,
          params: {},
          status: "pending",
        });
      }
    }
  }

  for (const [toolCallId, entry] of byToolCallId) {
    if (completion.has(toolCallId)) {
      entry.status = "completed";
    }
  }

  return Array.from(byToolCallId.values());
}

function extractIdFromMetadata(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:channel|user|direct|group|dm|chat):(\d+)/i);
  return match?.[1] || undefined;
}

async function sendMessage(
  channelId: string,
  content: string,
  token: string,
  replyToId?: string,
) {
  try {
    const body: any = { content };
    if (replyToId) body.message_reference = { message_id: replyToId };
    const res = await discordApiRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "sendMessage",
    );
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      logger.warn("discord-tool-status: sendMessage failed.", {
        subsystem: "plugins",
        status: res.status,
        error: data,
      });
      return undefined;
    }
    return data.id as string;
  } catch (err) {
    logger.warn("discord-tool-status: sendMessage threw.", {
      subsystem: "plugins",
      error: String(err),
    });
    return undefined;
  }
}

async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
  token: string,
) {
  try {
    const res = await discordApiRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      },
      "editMessage",
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as any;
      logger.warn("discord-tool-status: editMessage failed.", {
        subsystem: "plugins",
        status: res.status,
        error: data,
      });
    }
  } catch (err) {
    logger.warn("discord-tool-status: editMessage threw.", {
      subsystem: "plugins",
      error: String(err),
    });
  }
}

async function deleteMessage(
  channelId: string,
  messageId: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await discordApiRequest(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${token}` },
      },
      "deleteMessage",
    );
    if (!res.ok) {
      logger.warn("discord-tool-status: deleteMessage failed.", {
        subsystem: "plugins",
        status: res.status,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("discord-tool-status: deleteMessage threw.", {
      subsystem: "plugins",
      error: String(err),
    });
    return false;
  }
}

async function clearStatusMessage(
  session: SessionEntry,
  hookName: string,
  getToken: (accountId?: string) => string,
) {
  await waitForPendingOp(session, hookName);

  if (!session.statusMessageId) return;

  const token = getToken(session.accountId);
  if (token) {
    const msgId = session.statusMessageId;
    logger.debug(
      `discord-tool-status: [${hookName}] Deleting status message ${msgId}`,
      { subsystem: "plugins" },
    );
    const deleted = await deleteMessage(session.channelId, msgId, token);
    if (deleted) {
      session.statusMessageId = undefined;
    }
  }
  session.toolHistory = [];
}

async function updateStatusMessage(
  session: SessionEntry,
  getToken: (accountId?: string) => string,
  isFinal = false,
) {
  const priorOp = session.pendingOp;
  const op = (async () => {
    if (priorOp) {
      logger.debug(
        "discord-tool-status: [update_status_message] Waiting for pending op...",
        {
          subsystem: "plugins",
        },
      );
      try {
        await priorOp;
      } catch (err) {
        logger.warn(
          "discord-tool-status: [update_status_message] Pending op failed.",
          {
            subsystem: "plugins",
            error: String(err),
          },
        );
      }
    }

    let content = "";
    while (session.toolHistory.length > 0) {
      const contentParts = session.toolHistory.map((t, index) => {
        const icon = getToolIcon(t.toolName);
        const pStr = formatParams(t.params);
        const isLast = index === session.toolHistory.length - 1;
        const suffix =
          t.status === "completed" && (!isLast || isFinal) ? "✓" : "←";
        return `${icon} ${t.toolName}: ${suffix}${pStr ? "\n" + pStr : ""}`;
      });

      content = "```yaml\n" + contentParts.join("\n\n") + "\n```";
      if (content.length <= 1700 && session.toolHistory.length <= 6) break;
      session.toolHistory.shift();
    }

    if (!content) return;

    const token = getToken(session.accountId);
    if (!token) return;

    if (!session.statusMessageId) {
      if (!isCurrentSession(session)) {
        return;
      }

      const createdId = await sendMessage(
        session.channelId,
        content,
        token,
        session.userMessageId,
      );

      if (!createdId) {
        return;
      }

      if (!isCurrentSession(session)) {
        await deleteMessage(session.channelId, createdId, token);
        return;
      }

      session.statusMessageId = createdId;
      logger.debug(
        `discord-tool-status: Created status message ${session.statusMessageId}`,
        {
          subsystem: "plugins",
        },
      );
      return;
    }

    if (!isCurrentSession(session)) {
      return;
    }

    await editMessage(
      session.channelId,
      session.statusMessageId,
      content,
      token,
    );
    logger.debug("discord-tool-status: Updated status message.", {
      subsystem: "plugins",
    });
  })();

  session.pendingOp = op;
  try {
    await op;
  } finally {
    if (session.pendingOp === op) {
      session.pendingOp = undefined;
    }
  }
}

export default definePluginEntry({
  id: "discord-tool-status",
  name: "Discord Tool Status",
  description:
    "Shows live tool-call status as a Discord message that is updated and deleted when the agent finishes.",
  register(api: OpenClawPluginApi) {
    const getToken = (accountId?: string) =>
      resolveDiscordToken(api.config, { accountId }).token;

    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "discord") return;
      if (
        isActiveMemorySessionKey(ctx.sessionKey) ||
        isSubagentSessionKey(ctx.sessionKey)
      ) {
        logger.trace(
          "discord-tool-status: message_received: skip (active-memory/subagent) session.",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return;
      }
      logger.debug(
        `discord-tool-status: message_received event: ${JSON.stringify(event)}`,
        {
          subsystem: "plugins",
          ctx,
        },
      );
      const contextKey = getDiscordContextKey(ctx.sessionKey);
      if (!contextKey) return;

      const actualChannelId = extractIdFromMetadata(
        event.metadata?.to as string,
      );
      if (!actualChannelId) return;

      sessionContextMap.set(contextKey, {
        actualChannelId,
        userMessageId: event.messageId,
        senderId: String(event.metadata?.senderId ?? "").trim() || undefined,
        accountId: ctx.accountId,
        sourceSessionKey: ctx.sessionKey,
      });

      const activeSession = activeSessions.get(contextKey);
      if (activeSession) {
        if (
          ctx.sessionKey &&
          activeSession.ownerSessionKey !== ctx.sessionKey
        ) {
          if (activeSession.clearTimer) {
            clearTimeout(activeSession.clearTimer);
            activeSession.clearTimer = undefined;
          }
          const replacement: SessionEntry = {
            contextKey,
            channelId: actualChannelId,
            userMessageId: event.messageId,
            senderId:
              String(event.metadata?.senderId ?? "").trim() || undefined,
            accountId: ctx.accountId,
            ownerSessionKey: ctx.sessionKey,
            generation: activeSession.generation + 1,
            toolHistory: [],
          };
          activeSessions.set(contextKey, replacement);
          retireSession(
            activeSession,
            "message_received_owner_switch",
            getToken,
          ).catch((err) => {
            logger.warn(
              "discord-tool-status: failed to retire old session on owner switch",
              {
                subsystem: "plugins",
                contextKey,
                error: String(err),
              },
            );
          });
          return;
        }

        activeSession.channelId = actualChannelId;
        activeSession.userMessageId = event.messageId;
        activeSession.senderId =
          String(event.metadata?.senderId ?? "").trim() || undefined;
        activeSession.accountId = ctx.accountId;
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (
        isActiveMemorySessionKey(ctx.sessionKey) ||
        isSubagentSessionKey(ctx.sessionKey)
      ) {
        logger.trace(
          "discord-tool-status: before_tool_call: skip (active-memory/subagent) session.",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return;
      }
      logger.debug(
        `discord-tool-status: before_tool_call event: ${JSON.stringify(event)}`,
        {
          subsystem: "plugins",
          ctx,
        },
      );
      const contextKey = getDiscordContextKey(ctx.sessionKey);
      const session = contextKey
        ? await resolveSession(contextKey, ctx.sessionKey)
        : undefined;

      if (!session) {
        logger.debug(
          "discord-tool-status: before_tool_call: skip (no session/context).",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return;
      }

      session.toolHistory.push({
        toolCallId: event.toolCallId as string,
        toolName: event.toolName,
        params: event.params,
        status: "pending",
      });

      if (session.toolHistory.length > 10) session.toolHistory.shift();
      await updateStatusMessage(session, getToken);
    });

    api.on("after_tool_call", async (event, ctx) => {
      if (
        isActiveMemorySessionKey(ctx.sessionKey) ||
        isSubagentSessionKey(ctx.sessionKey)
      ) {
        logger.trace(
          "discord-tool-status: after_tool_call: skip (active-memory/subagent) session.",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return;
      }
      logger.debug(
        `discord-tool-status: after_tool_call event: ${JSON.stringify(event)}`,
        {
          subsystem: "plugins",
          ctx,
        },
      );
      const contextKey = getDiscordContextKey(ctx.sessionKey);
      const session = contextKey
        ? await resolveSession(contextKey, ctx.sessionKey)
        : undefined;

      if (!session) return;

      const toolEntry = session.toolHistory.find(
        (t) => t.toolCallId === event.toolCallId,
      );
      if (toolEntry) {
        toolEntry.status = "completed";
        await updateStatusMessage(session, getToken);
      }
    });

    api.on("message_sending", async (event, ctx) => {
      if (ctx.channelId !== "discord") return undefined;
      if (
        isActiveMemorySessionKey(ctx.sessionKey) ||
        isSubagentSessionKey(ctx.sessionKey)
      ) {
        logger.trace(
          "discord-tool-status: message_sending: skip (active-memory/subagent) session.",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return undefined;
      }
      logger.debug(
        `discord-tool-status: message_sending event: ${JSON.stringify(event)}`,
        {
          subsystem: "plugins",
          ctx,
        },
      );
      const contextKey = getDiscordContextKey(ctx.sessionKey);
      if (contextKey) {
        const session = await resolveSession(contextKey, ctx.sessionKey);
        if (session) {
          await updateStatusMessage(session, getToken, true);
          scheduleSessionCleanup(
            contextKey,
            session,
            ctx.sessionKey,
            1000,
            "message_sending_delayed",
            getToken,
          );
        }
      }
      return undefined;
    });

    api.on("before_agent_reply", async (event, ctx) => {
      if (
        isActiveMemorySessionKey(ctx.sessionKey) ||
        isSubagentSessionKey(ctx.sessionKey)
      ) {
        logger.trace(
          "discord-tool-status: before_agent_reply: skip (active-memory/subagent) session.",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return { handled: false };
      }
      logger.debug(
        `discord-tool-status: before_agent_reply event: ${JSON.stringify(event)}`,
        {
          subsystem: "plugins",
          ctx,
        },
      );
      const contextKey = getDiscordContextKey(ctx.sessionKey);
      if (contextKey) {
        const session = await resolveSession(contextKey, ctx.sessionKey);
        if (session && hasVisibleStatusState(session)) {
          await updateStatusMessage(session, getToken, true);
          scheduleSessionCleanup(
            contextKey,
            session,
            ctx.sessionKey,
            1000,
            "before_agent_reply_delayed",
            getToken,
          );
        }
      }
      return { handled: false };
    });

    api.on("agent_end", async (event, ctx) => {
      if (isSubagentSessionKey(ctx.sessionKey)) {
        logger.trace(
          "discord-tool-status: message_received: skip subagent session.",
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return;
      }
      logger.debug(
        `discord-tool-status: agent_end event: ${JSON.stringify(event)}`,
        {
          subsystem: "plugins",
          ctx,
        },
      );

      const contextKey = getDiscordContextKey(ctx.sessionKey);
      if (contextKey) {
        if (isActiveMemorySessionKey(ctx.sessionKey)) {
          const sourceSessionKey = getActiveMemorySourceSessionKey(
            ctx.sessionKey,
          );
          const session = sourceSessionKey
            ? getOrCreateSession(contextKey, sourceSessionKey)
            : undefined;
          if (session) {
            if (session.clearTimer) {
              clearTimeout(session.clearTimer);
              session.clearTimer = undefined;
            }
            const entries = parseActiveMemoryToolEntries(event);
            if (entries.length > 0) {
              for (const entry of entries) {
                const existing = session.toolHistory.find(
                  (t) => t.toolCallId === entry.toolCallId,
                );
                if (existing) {
                  existing.status = entry.status;
                  existing.params = entry.params;
                  existing.toolName = entry.toolName;
                } else {
                  session.toolHistory.push(entry);
                }
              }
              while (session.toolHistory.length > 10) {
                session.toolHistory.shift();
              }

              await updateStatusMessage(session, getToken, true);
            }
          }
          return;
        }

        const session = await resolveSession(contextKey, ctx.sessionKey);
        if (session) {
          await updateStatusMessage(session, getToken, true);
          scheduleSessionCleanup(
            contextKey,
            session,
            ctx.sessionKey,
            1500,
            "agent_end_delayed",
            getToken,
          );
        }
      }
    });
  },
});
