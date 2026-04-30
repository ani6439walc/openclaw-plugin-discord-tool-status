export type ChannelMeta = {
  actualChannelId: string;
  userMessageId?: string;
  senderId?: string;
  accountId?: string;
  sourceSessionKey?: string;
};

export type ToolEntry = {
  toolCallId: string;
  toolName: string;
  params: any;
  status: "pending" | "completed";
};

export type AgentMessageContentItem = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

export type AgentEventMessage = {
  role?: string;
  content?: AgentMessageContentItem[];
  toolCallId?: string;
  toolName?: string;
};

export type SessionEntry = {
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
