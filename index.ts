import {
  createSubsystemLogger,
  definePluginEntry,
  type OpenClawPluginApi,
} from "./api.js";
import { resolveDiscordToken } from "./token.js";
import {
  getDiscordContextKey,
  isActiveMemorySessionKey,
  isSubagentSessionKey,
  getActiveMemorySourceSessionKey,
  extractIdFromMetadata,
  parseActiveMemoryToolEntries,
} from "./src/parser.js";
import {
  activeSessions,
  sessionContextMap,
  getOrCreateSession,
  hasVisibleStatusState,
  resolveSession,
  retireSession,
  scheduleSessionCleanup,
  updateStatusMessage,
} from "./src/session.js";
import type { SessionEntry } from "./src/types.js";

const logger = createSubsystemLogger("plugins");

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
        logger.trace("discord-tool-status: agent_end: skip subagent session.", {
          subsystem: "plugins",
          sessionKey: ctx.sessionKey,
        });
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
