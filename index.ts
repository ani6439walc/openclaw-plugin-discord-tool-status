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
  extractSenderId,
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

    function logHookEvent(hookName: string, _event: any, ctx: any) {
      logger.debug(
        `discord-tool-status: ${hookName} ctx: ${JSON.stringify(ctx)}`,
        {
          subsystem: "plugins",
          sessionKey: ctx.sessionKey,
        },
      );
    }

    function shouldSkipSession(ctx: any, hookName: string): boolean {
      if (
        isActiveMemorySessionKey(ctx.sessionKey) ||
        isSubagentSessionKey(ctx.sessionKey)
      ) {
        logger.trace(
          `discord-tool-status: ${hookName}: skip (active-memory/subagent) session.`,
          {
            subsystem: "plugins",
            sessionKey: ctx.sessionKey,
          },
        );
        return true;
      }
      return false;
    }

    async function resolveAndFinalize(
      ctx: any,
      delayMs: number,
      hookName: string,
      requireVisibleState = false,
    ) {
      const contextKey = getDiscordContextKey(ctx.sessionKey);
      if (!contextKey) return;
      const session = await resolveSession(contextKey, ctx.sessionKey);
      if (!session) return;
      if (requireVisibleState && !hasVisibleStatusState(session)) return;
      await updateStatusMessage(session, getToken, true);
      scheduleSessionCleanup(
        contextKey,
        session,
        ctx.sessionKey,
        delayMs,
        `${hookName}_delayed`,
        getToken,
      );
    }

    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "discord") return;
      if (shouldSkipSession(ctx, "message_received")) return;
      logHookEvent("message_received", event, ctx);

      const contextKey = getDiscordContextKey(ctx.sessionKey);
      if (!contextKey) return;

      const actualChannelId = extractIdFromMetadata(
        event.metadata?.to as string,
      );
      if (!actualChannelId) return;

      sessionContextMap.set(contextKey, {
        actualChannelId,
        userMessageId: event.messageId,
        senderId: extractSenderId(event.metadata),
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
            senderId: extractSenderId(event.metadata),
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

          replacement.toolHistory.push({
            toolCallId: "init",
            toolName: "📖 努力翻找著腦海裡關於主人的記憶...",
            params: {},
            status: "completed",
          });
          return;
        }

        activeSession.channelId = actualChannelId;
        activeSession.userMessageId = event.messageId;
        activeSession.senderId = extractSenderId(event.metadata);
        activeSession.accountId = ctx.accountId;
      }

      const session = getOrCreateSession(contextKey, ctx.sessionKey);
      if (session && session.toolHistory.length === 0) {
        session.toolHistory.push({
          toolCallId: "init",
          toolName: "📖 努力翻找著腦海裡關於主人的記憶...",
          params: {},
          status: "pending",
        });
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (shouldSkipSession(ctx, "before_tool_call")) return;
      logHookEvent("before_tool_call", event, ctx);

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
      if (shouldSkipSession(ctx, "after_tool_call")) return;
      logHookEvent("after_tool_call", event, ctx);

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
      if (shouldSkipSession(ctx, "message_sending")) return undefined;
      logHookEvent("message_sending", event, ctx);

      await resolveAndFinalize(ctx, 1000, "message_sending");
      return undefined;
    });

    api.on("before_agent_reply", async (event, ctx) => {
      if (shouldSkipSession(ctx, "before_agent_reply"))
        return { handled: false };
      logHookEvent("before_agent_reply", event, ctx);

      await resolveAndFinalize(ctx, 1000, "before_agent_reply", true);
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
      logHookEvent("agent_end", event, ctx);

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
            }
            const initEntry = session.toolHistory.find(
              (t) => t.toolCallId === "init",
            );
            if (initEntry) {
              initEntry.status = "completed";
            }
            await updateStatusMessage(session, getToken, true);
          }
          return;
        }

        await resolveAndFinalize(ctx, 1500, "agent_end");
      }
    });
  },
});
