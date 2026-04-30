import type { ToolEntry, AgentEventMessage } from "./types.js";

export function getDiscordContextKey(
  sessionKey: string | undefined,
): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(
    /discord:(?:channel|direct|group|dm|chat):[^:]+/i,
  );
  return match ? match[0].toLowerCase() : undefined;
}

export function isSubagentSessionKey(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":subagent:");
}

export function isActiveMemorySessionKey(
  sessionKey: string | undefined,
): boolean {
  return (
    typeof sessionKey === "string" && sessionKey.includes(":active-memory:")
  );
}

export function getActiveMemorySourceSessionKey(
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

export function extractIdFromMetadata(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:channel|user|direct|group|dm|chat):(\d+)/i);
  return match?.[1] || undefined;
}

export function extractSenderId(metadata: any): string | undefined {
  return String(metadata?.senderId ?? "").trim() || undefined;
}

export function parseActiveMemoryToolEntries(event: any): ToolEntry[] {
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
