import { createSubsystemLogger } from "../api.js";
import { MAX_RETRIES, RETRY_FALLBACK_MS } from "./constants.js";

const logger = createSubsystemLogger("plugins");

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function getRetryDelayMs(res: Response): Promise<number> {
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
    /* intentionally empty: fall through to default delay */
  }

  return RETRY_FALLBACK_MS;
}

export async function discordApiRequest(
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

export async function sendMessage(
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

export async function editMessage(
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

export async function deleteMessage(
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
