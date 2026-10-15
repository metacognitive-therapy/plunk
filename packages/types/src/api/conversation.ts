export type ConversationStatusValue = 'OPEN' | 'SNOOZED' | 'CLOSED';
export type MessageAuthorTypeValue = 'CONTACT' | 'AGENT' | 'SYSTEM';
export type MessageKindValue = 'COMMENT' | 'NOTE';

export interface MessengerAgent {
  id: string;
  /** Null when the agent has no name; visitors never see an agent's email. */
  name: string | null;
}

/** Internal notes are never included in messenger responses. */
export interface MessengerMessage {
  id: string;
  authorType: MessageAuthorTypeValue;
  agent: MessengerAgent | null;
  body: string;
  createdAt: string;
}

export interface MessengerConversationSummary {
  id: string;
  status: ConversationStatusValue;
  lastMessageAt: string;
  lastMessage: {body: string; authorType: MessageAuthorTypeValue} | null;
  unread: boolean;
}

export interface MessengerConversation {
  id: string;
  status: ConversationStatusValue;
  messages: MessengerMessage[];
}

export interface MessengerStartResponse {
  token: string;
  expiresAt: string;
  conversation: MessengerConversation;
}

export interface MessengerBootResponse {
  token: string;
  expiresAt: string;
  project: {
    name: string;
    logoUrl: string | null;
    language: string;
  };
}

export interface InboxMessage {
  id: string;
  authorType: MessageAuthorTypeValue;
  kind: MessageKindValue;
  author: {id: string; name: string; email: string} | null;
  body: string;
  source: string;
  createdAt: string;
}

export interface InboxContact {
  id: string;
  email: string | null;
  externalId: string | null;
  data: Record<string, unknown> | null;
}

export interface InboxConversationSummary {
  id: string;
  status: ConversationStatusValue;
  assigneeId: string | null;
  contact: InboxContact;
  lastMessageAt: string;
  lastMessage: {body: string; authorType: MessageAuthorTypeValue} | null;
  unread: boolean;
}

export interface InboxConversation extends InboxConversationSummary {
  channel: string;
  snoozedUntil: string | null;
  contactLastReadAt: string | null;
  createdAt: string;
  messages: InboxMessage[];
}

export interface InboxPage {
  conversations: InboxConversationSummary[];
  nextCursor: string | null;
}

export interface MessengerSettingsData {
  enabled: boolean;
  allowedOrigins: string[];
}
